import {
    LoadSubsetOperationAbortedError,
    type LoadSubsetOptions,
    type SyncConfig,
    whenSyncAccepted,
} from '@tanstack/db'
import type { Fetcher } from './fetch-records'
import { ACCEPTED, EAGER, type Holder, type Ledger } from './ledger'
import type { LoadedSubsets } from './loaded-subsets'
import { logger } from './logger'
import type { Applied, Membership } from './membership'
import type { RealtimeSubscription } from './realtime-subscription'
import { realtimeWhereFor } from './realtime-where'
import { idOf } from './records'
import { type PbRequest, realtimeFiltersFor, toRequest } from './request'
import type { SyncChannel, SyncedStore } from './synced-store'
import type { RealtimeMode } from './types'
import type { ViewRegistry } from './views'

export interface SyncAdapterDeps<T extends object> {
    collectionName: string
    syncMode: 'eager' | 'on-demand'
    realtimeMode: RealtimeMode
    ledger: Ledger<T>
    store: SyncedStore<T>
    membership: Membership<T>
    fetcher: Fetcher<T>
    subsets: LoadedSubsets
    realtime: Pick<
        RealtimeSubscription,
        'retainQueryFilters' | 'releaseQueryFilters' | 'resetQueryFilters'
    >
    /** The view registry, created after the collection; read lazily. */
    registry: () => Pick<ViewRegistry<never, object>, 'tagFor' | 'withViewExpand'>
    onCleanup: () => void
}

export interface SyncAdapter<T extends object> {
    sync: SyncConfig<T, string | number>['sync']
    /**
     * Refetch every live subset from the server (the whole collection in
     * eager mode), then release the topic and accepted holders the results
     * did not confirm. Resolves when the rows are accepted; they become
     * visible with the settlement of any persisting mutation.
     */
    reload: () => Promise<void>
    /** The subset holders whose base realtime filter is `filter`. */
    subsetsFor: (filter: string) => LoadSubsetOptions[]
    /** The server deleted `id`; a fetch in flight must not put it back. */
    noteDeleted: (id: string) => void
}

/** `visible` for a load core awaits; `accepted` for a path a mutation handler can reach. */
type Wait = 'visible' | 'accepted'

type Demand = {
    request: PbRequest
    filters: string[] | undefined
    /** The effective realtime mode is `'query'`, so `filters` hold a realtime ref. */
    counted: boolean
    /** Incremented by every load of this demand; only the newest load reconciles. */
    seq: number
}

/** One run of `sync()`, from its call to its cleanup. */
type Run = {
    abort: AbortController
    demands: Map<LoadSubsetOptions, Demand>
    eagerSeq: number
    eagerLoad: Promise<void> | undefined
}

export function createSyncAdapter<T extends object>(deps: SyncAdapterDeps<T>): SyncAdapter<T> {
    const { collectionName, syncMode, ledger, store, membership, fetcher, subsets, realtime } = deps
    let current: Run | undefined
    // One set per fetch in flight: ids the server deleted meanwhile, which
    // the result may still list.
    const tombstones = new Set<Set<string>>()

    function demandFor(opts: LoadSubsetOptions): Demand {
        const request = toRequest(deps.registry().withViewExpand(opts))
        const mode = deps.registry().tagFor(opts)?.realtime ?? deps.realtimeMode
        if (mode !== 'query') return { request, filters: undefined, counted: false, seq: 0 }
        const filters = realtimeFiltersFor(toRequest({ where: realtimeWhereFor(opts) }))
        return { request, filters, counted: true, seq: 0 }
    }

    function idsOf(rows: readonly T[]): string[] {
        return rows.map(idOf).filter((id): id is string => id !== undefined)
    }

    async function settle(applied: Applied, wait: Wait): Promise<void> {
        if (applied === true || applied === false) return
        const receipt = wait === 'accepted' ? whenSyncAccepted(applied) : applied
        if (receipt !== true) await receipt
    }

    async function fetchRows(
        run: Run,
        request: PbRequest,
        signal: AbortSignal | undefined,
        refetch: boolean
    ): Promise<T[]> {
        const deleted = new Set<string>()
        tombstones.add(deleted)
        try {
            const { rows } = await fetcher.fetchRecords(request, {
                signal: signal ? AbortSignal.any([run.abort.signal, signal]) : run.abort.signal,
                refetch,
            })
            return rows.filter(row => !deleted.has(idOf(row) ?? ''))
        } finally {
            tombstones.delete(deleted)
        }
    }

    // Core ignores an aborted load's outcome, but a direct caller
    // (`beginLoadSubsetOperation`) must see that it did not complete. A
    // reload skips the demand instead.
    function stopped(run: Run, opts: LoadSubsetOptions, wait: Wait): boolean {
        if (!run.abort.signal.aborted && opts.signal?.aborted !== true) return false
        if (wait === 'visible') throw new LoadSubsetOperationAbortedError()
        return true
    }

    async function load(
        run: Run,
        opts: LoadSubsetOptions,
        demand: Demand,
        wait: Wait,
        refetch: boolean
    ): Promise<void> {
        const seq = ++demand.seq
        const rows = await fetchRows(run, demand.request, opts.signal, refetch).catch(error => {
            if (stopped(run, opts, wait)) return undefined
            throw error
        })
        if (rows === undefined || stopped(run, opts, wait)) return
        if (run.demands.get(opts)?.seq !== seq) return
        const applied = membership.reconcile(opts, rows)
        if (applied === false) return
        ledger.release(ACCEPTED, idsOf(rows))
        await settle(applied, wait)
        stopped(run, opts, wait)
    }

    function unloadSubset(run: Run, opts: LoadSubsetOptions): void {
        try {
            const demand = run.demands.get(opts)
            if (!demand) return
            run.demands.delete(opts)
            if (demand.counted) realtime.releaseQueryFilters(demand.filters)
            membership.drop([opts])
        } catch (error) {
            logger.error('unloadSubset failed', { collectionName, error })
        }
    }

    function serve(opts: LoadSubsetOptions, demand: Demand): Applied {
        if (opts.refetch) return false
        const served = fetcher.serveFromStore(demand.request)
        if (!served) return false
        demand.seq += 1
        const applied = membership.reconcile(opts, served)
        if (applied !== false) ledger.release(ACCEPTED, idsOf(served))
        return applied
    }

    function loadSubsetIn(run: Run) {
        return (opts: LoadSubsetOptions): true | Promise<void> => {
            const demand = demandFor(opts)
            run.demands.set(opts, demand)
            if (demand.counted) realtime.retainQueryFilters(demand.filters)
            try {
                const applied = serve(opts, demand)
                if (applied !== false) return applied
            } catch (error) {
                unloadSubset(run, opts)
                throw error
            }
            return load(run, opts, demand, 'visible', opts.refetch === true).catch(error => {
                unloadSubset(run, opts)
                throw error
            })
        }
    }

    // A superseded eager load waits for the newer one, so readiness never
    // fires before the rows a later load brings.
    function loadEagerRows(run: Run): Promise<void> {
        const seq = ++run.eagerSeq
        const loading = (async (): Promise<void> => {
            const rows = await fetchRows(run, {}, undefined, false)
            if (run.abort.signal.aborted) return
            if (run.eagerSeq !== seq) return run.eagerLoad
            await settle(membership.reconcile(EAGER, rows), 'accepted')
        })()
        run.eagerLoad = loading
        return loading
    }

    async function startEager(
        run: Run,
        markReady: () => void,
        markError: (error: unknown) => void
    ): Promise<void> {
        try {
            await loadEagerRows(run)
        } catch (error) {
            if (run.abort.signal.aborted) return
            logger.error('Initial load failed', { collectionName, error })
            markError(error)
            return
        }
        if (!run.abort.signal.aborted) markReady()
    }

    // Holders a reload may release: realtime topics (the only string
    // holders) and ACCEPTED. Taken before the fetch, so a row an echo or a
    // write-back lands while the fetch is in flight keeps its holder.
    function releasable(): [Holder, string[]][] {
        return ledger
            .holders()
            .filter(holder => holder === ACCEPTED || typeof holder === 'string')
            .map((holder): [Holder, string[]] => [holder, ledger.idsOf(holder)])
    }

    async function reload(): Promise<void> {
        const run = current
        if (!run || !store.isAttached()) return
        const unconfirmed = releasable()
        try {
            if (syncMode === 'eager') {
                await loadEagerRows(run)
            } else {
                await Promise.all(
                    [...run.demands].map(([opts, demand]) =>
                        load(run, opts, demand, 'accepted', true)
                    )
                )
            }
        } catch (error) {
            if (run.abort.signal.aborted) return
            throw error
        }
        for (const [holder, ids] of unconfirmed) {
            if (run.abort.signal.aborted) return
            await settle(membership.drop([holder], ids), 'accepted')
        }
    }

    return {
        sync: params => {
            const channel: SyncChannel<T> = params
            const run: Run = {
                abort: new AbortController(),
                demands: new Map(),
                eagerSeq: 0,
                eagerLoad: undefined,
            }
            current = run
            store.attach(channel)
            // Core has already fenced this run's writes when it calls
            // cleanup; the abort stops its requests, and every async path
            // checks it before it writes.
            const cleanup = () => {
                run.abort.abort()
                run.demands.clear()
                if (current === run) current = undefined
                store.detach(channel)
                ledger.clear()
                subsets.clear()
                if (syncMode === 'on-demand') realtime.resetQueryFilters()
                deps.onCleanup()
            }
            if (syncMode === 'eager') {
                void startEager(run, params.markReady, params.markError)
                return { cleanup }
            }
            params.markReady()
            return {
                loadSubset: loadSubsetIn(run),
                unloadSubset: opts => unloadSubset(run, opts),
                cleanup,
            }
        },
        reload,
        subsetsFor: filter =>
            [...(current?.demands ?? [])]
                .filter(([, demand]) => demand.filters?.includes(filter))
                .map(([opts]) => opts),
        noteDeleted: id => {
            for (const deleted of tombstones) deleted.add(id)
        },
    }
}
