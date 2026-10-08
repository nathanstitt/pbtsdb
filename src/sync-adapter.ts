import {
    compileSingleRowExpression,
    LoadSubsetOperationAbortedError,
    type LoadSubsetOptions,
    type SyncConfig,
    toBooleanPredicate,
    whenSyncAccepted,
} from '@tanstack/db'
import type { Fetcher, FetchResult } from './fetch-records'
import { ACCEPTED, EAGER, type Holder, type Ledger } from './ledger'
import type { LoadedSubsets } from './loaded-subsets'
import { logger } from './logger'
import type { Applied, Membership } from './membership'
import type { RealtimeSubscription } from './realtime-subscription'
import { realtimeWhereFor } from './realtime-where'
import { idOf, idsOf } from './records'
import { type PbRequest, realtimeFiltersFor, toRequest } from './request'
import type { LoadStatus } from './sync-status'
import type { SyncChannel, SyncedStore } from './synced-store'
import type { RealtimeMode } from './types'
import type { ViewRegistry } from './views'

export interface SyncAdapterDeps<T extends object> {
    collectionName: string
    syncMode: 'eager' | 'on-demand'
    realtimeMode: RealtimeMode
    /** How long an unloaded subset stays held for an equal load to adopt; 0 releases at once. */
    subsetGcTime: number
    /** Waits before each retry of a failed load; the length is the number of retries. */
    loadRetryDelays: readonly number[]
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
    /** After anything `loadStatus()` reports may have changed. */
    onLoadStatusChange: () => void
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
    /**
     * The server deleted `id`, as seen on `topic`: `'*'` for a real delete,
     * a filter string for a row that left that filter. A fetch in flight for
     * a demand the topic covers must not put the row back.
     */
    noteDeleted: (id: string, topic: string) => void
    /** Whether `id` was deleted while a fetch still in flight was running. */
    isDeleted: (id: string) => boolean
    /** Release every parked subset now, for example because the auth changed. */
    expireParked: () => void
    /** End every retry wait now, so a waiting load tries again at once. */
    wakeRetries: () => void
    /**
     * The holders a server-confirmed row belongs to by its values: `EAGER`
     * in eager mode, else every live, landed demand whose `where` the row
     * matches on the client. For a row the server wrote, so no row the
     * server lacks can enter through here.
     */
    holdersFor: (row: T) => Holder[]
    /** Live demands sleeping in retry or ended in an error that is not retried. */
    loadStatus: () => LoadStatus
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
    /** The newest load; a superseded load resolves with it. */
    loading: Promise<string[]> | undefined
    /** Set once unloaded: the demand waits for an equal load to adopt it, or expires. */
    parked: ReturnType<typeof setTimeout> | undefined
    /** Rows for this demand reached the store at least once; only such a demand may park. */
    landed: boolean
    /** Ends a retry wait early: a newer load, an unload or a cleanup supersedes it. */
    wake: (() => void) | undefined
    /** When the load now sleeping in retry first failed. */
    retryingSince: number | undefined
    /** The newest load ended in an error that is not retried. */
    failed: boolean
}

/** One run of `sync()`, from its call to its cleanup. */
type Run = {
    abort: AbortController
    demands: Map<LoadSubsetOptions, Demand>
    eagerSeq: number
    eagerLoad: Promise<string[]> | undefined
    eagerWake: (() => void) | undefined
    eagerRetryingSince: number | undefined
    eagerFailed: boolean
}

export function createSyncAdapter<T extends object>(deps: SyncAdapterDeps<T>): SyncAdapter<T> {
    const { collectionName, syncMode, ledger, store, membership, fetcher, subsets, realtime } = deps
    const { subsetGcTime, loadRetryDelays } = deps
    let current: Run | undefined
    // One entry per fetch in flight: ids the server deleted meanwhile, which
    // the result may still list, and the realtime filters the demand holds
    // (undefined: covered by `'*'` only).
    const tombstones = new Map<Set<string>, readonly string[] | undefined>()

    function demandFor(opts: LoadSubsetOptions): Demand {
        const request = toRequest(deps.registry().withViewExpand(opts))
        const mode = deps.registry().tagFor(opts)?.realtime ?? deps.realtimeMode
        const base = {
            request,
            seq: 0,
            loading: undefined,
            parked: undefined,
            landed: false,
            wake: undefined,
            retryingSince: undefined,
            failed: false,
        }
        if (mode !== 'query') return { ...base, filters: undefined, counted: false }
        const filters = realtimeFiltersFor(toRequest({ where: realtimeWhereFor(opts) }))
        return { ...base, filters, counted: true }
    }

    // Two demands are equal when they would send the same request and hold
    // the same realtime filters.
    function keyOf(demand: Demand): string {
        return JSON.stringify([demand.request, demand.filters], (_key, value: unknown) =>
            value && typeof value === 'object' && !Array.isArray(value)
                ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
                : value
        )
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
        refetch: boolean,
        filters: readonly string[] | undefined
    ): Promise<FetchResult<T>> {
        const deleted = new Set<string>()
        tombstones.set(deleted, filters)
        try {
            const { rows, fromStore, filings } = await fetcher.fetchRecords(request, {
                signals: signal ? [run.abort.signal, signal] : [run.abort.signal],
                refetch,
            })
            return {
                rows: rows.filter(row => !deleted.has(idOf(row) ?? '')),
                fromStore,
                filings,
            }
        } finally {
            tombstones.delete(deleted)
        }
    }

    // Core ignores an aborted load's outcome, but a direct caller
    // (`beginLoadSubsetOperation`) must see that it did not complete. A
    // reload skips the demand instead.
    function isStopped(run: Run, opts: LoadSubsetOptions): boolean {
        return run.abort.signal.aborted || opts.signal?.aborted === true
    }

    function stopped(run: Run, opts: LoadSubsetOptions, wait: Wait): boolean {
        if (!isStopped(run, opts)) return false
        if (wait === 'visible') throw new LoadSubsetOperationAbortedError()
        return true
    }

    // `unknown` is the answer for an expression the client cannot compile or
    // evaluate. The release path treats it as no match, so it releases
    // nothing; the hand-off treats it as a match, so it keeps the row.
    function matcherFor(where: LoadSubsetOptions['where'], unknown: boolean): (row: T) => boolean {
        if (where === undefined) return () => true
        let evaluate: ReturnType<typeof compileSingleRowExpression>
        try {
            evaluate = compileSingleRowExpression(where)
        } catch {
            return () => unknown
        }
        return row => {
            try {
                return toBooleanPredicate(evaluate(row as Record<string, unknown>))
            } catch {
                return unknown
            }
        }
    }

    // Rows ACCEPTED or this demand's filter topics hold, as they stand
    // before the fetch. Never '*': it holds rows for every query on the
    // collection, and a client-side `where` can disagree with PocketBase's. A row an event or a write-back replaces meanwhile
    // is a new object, so it is not mistaken for one the result omits.
    function uncoveredRows(demand: Demand): { holders: Holder[]; rows: Map<string, T> } {
        const holders = [ACCEPTED, ...(demand.filters ?? [])]
        const rows = new Map<string, T>()
        for (const holder of holders) {
            for (const id of ledger.idsOf(holder)) {
                const stored = ledger.row(id)
                if (stored) rows.set(id, stored)
            }
        }
        return { holders, rows }
    }

    // A complete fresh result is the server's answer for `where`: a row
    // ACCEPTED or a filter topic holds, that matches `where` and that the result
    // omits, is gone or changed on the server (rule 6 exception). A page
    // (limit, cursor, offset) omits matching rows by design.
    function releaseOmitted(
        opts: LoadSubsetOptions,
        before: { holders: Holder[]; rows: Map<string, T> },
        ids: readonly string[]
    ): Applied {
        if (opts.limit !== undefined || opts.cursor || opts.offset !== undefined) return true
        const returned = new Set(ids)
        const matches = matcherFor(opts.where, false)
        const omitted = [...before.rows]
            .filter(([id, stored]) => !returned.has(id) && ledger.row(id) === stored)
            .filter(([, stored]) => matches(stored))
            .map(([id]) => id)
        return omitted.length > 0 ? membership.drop(before.holders, omitted) : true
    }

    async function install(
        run: Run,
        opts: LoadSubsetOptions,
        wait: Wait,
        before: { holders: Holder[]; rows: Map<string, T> },
        result: FetchResult<T>
    ): Promise<string[]> {
        const applied = membership.reconcile(opts, result.rows)
        if (applied === false) {
            result.filings.undo()
            return []
        }
        result.filings.commit()
        const demand = run.demands.get(opts)
        if (demand) demand.landed = true
        const ids = idsOf(result.rows)
        const released = result.fromStore ? true : releaseOmitted(opts, before, ids)
        await settle(applied, wait)
        await settle(released, wait)
        if (!stopped(run, opts, wait)) membership.confirm(opts, [ACCEPTED], ids)
        return ids
    }

    // A transient failure must not error the live query: one flaky request
    // would otherwise leave a list empty until a remount. Retries stop when
    // the demand is gone, superseded or aborted.
    function superseded(run: Run, opts: LoadSubsetOptions, demand: Demand, seq: number): boolean {
        return isStopped(run, opts) || run.demands.get(opts) !== demand || demand.seq !== seq
    }

    function statusOf(error: unknown): number | undefined {
        const status = (error as { status?: unknown } | null)?.status
        return typeof status === 'number' ? status : undefined
    }

    // A response the server gave on purpose is not retried: the request is
    // wrong or forbidden and would fail again. Everything else (no response,
    // a server error, a timeout, a rate limit) may pass next time. A 401 is
    // retried only once the auth changes.
    function isRetryable(error: unknown): boolean {
        const status = statusOf(error)
        if (status === undefined || status < 400 || status >= 500) return true
        return status === 401 || status === 408 || status === 429
    }

    /**
     * The wait before retry number `attempt`: the configured delay with up to
     * a quarter of jitter either way, so retries do not fire in lockstep; the
     * last delay repeats. Undefined with no delays, or with a 401, which
     * waits for a wake alone.
     */
    function retryDelay(attempt: number, error: unknown): number | undefined {
        if (statusOf(error) === 401) return undefined
        const base = loadRetryDelays[Math.min(attempt, loadRetryDelays.length - 1)]
        return base === undefined ? undefined : Math.round(base * (0.75 + Math.random() * 0.5))
    }

    /** Sleeps `ms` unless woken through `onWake` first; with no `ms`, until woken. */
    function sleep(ms: number | undefined, onWake: (wake: () => void) => void): Promise<void> {
        return new Promise<void>(resolve => {
            const timer = ms === undefined ? undefined : setTimeout(resolve, ms)
            onWake(() => {
                if (timer !== undefined) clearTimeout(timer)
                resolve()
            })
        })
    }

    function wakeRetries(run: Run): void {
        run.eagerWake?.()
        for (const demand of run.demands.values()) demand.wake?.()
    }

    const { onLoadStatusChange } = deps

    function loadStatus(): LoadStatus {
        const status: LoadStatus = { retrying: 0, failed: 0 }
        const run = current
        if (!run) return status
        const count = (retryingSince: number | undefined, failed: boolean) => {
            if (failed) status.failed += 1
            if (retryingSince === undefined) return
            status.retrying += 1
            if (status.failingSince === undefined || retryingSince < status.failingSince) {
                status.failingSince = retryingSince
            }
        }
        for (const demand of run.demands.values()) {
            if (demand.parked === undefined) count(demand.retryingSince, demand.failed)
        }
        count(run.eagerRetryingSince, run.eagerFailed)
        return status
    }

    /**
     * Waits out the next retry delay. False when the load is no longer
     * wanted; throws the error when retries are off or it is not retryable.
     * A demand keeps retrying until it loads, so a live query never enters
     * the error state it cannot leave; a reload or reconnect wakes the wait.
     */
    async function retryAllowed(
        run: Run,
        opts: LoadSubsetOptions,
        demand: Demand,
        seq: number,
        attempt: number,
        error: unknown
    ): Promise<boolean> {
        if (superseded(run, opts, demand, seq)) return false
        if (loadRetryDelays.length === 0 || !isRetryable(error)) {
            demand.failed = true
            onLoadStatusChange()
            throw error
        }
        const delay = retryDelay(attempt, error)
        logger.warn('Subset load failed; retrying', { collectionName, attempt, delay, error })
        demand.retryingSince ??= Date.now()
        onLoadStatusChange()
        await sleep(delay, wake => {
            demand.wake = wake
        })
        demand.wake = undefined
        return !superseded(run, opts, demand, seq)
    }

    async function fetchWithRetry(
        run: Run,
        opts: LoadSubsetOptions,
        demand: Demand,
        seq: number,
        refetch: boolean
    ): Promise<FetchResult<T> | undefined> {
        try {
            for (let attempt = 0; ; attempt++) {
                try {
                    return await fetchRows(
                        run,
                        demand.request,
                        opts.signal,
                        refetch,
                        demand.filters
                    )
                } catch (error) {
                    if (!(await retryAllowed(run, opts, demand, seq, attempt, error))) {
                        return undefined
                    }
                }
            }
        } finally {
            if (demand.seq === seq) {
                demand.retryingSince = undefined
                onLoadStatusChange()
            }
        }
    }

    function load(
        run: Run,
        opts: LoadSubsetOptions,
        demand: Demand,
        wait: Wait,
        refetch: boolean
    ): Promise<string[]> {
        demand.wake?.()
        const seq = ++demand.seq
        demand.failed = false
        demand.retryingSince = undefined
        onLoadStatusChange()
        const before = uncoveredRows(demand)
        const loading = (async (): Promise<string[]> => {
            const result = await fetchWithRetry(run, opts, demand, seq, refetch)
            if (result !== undefined && !superseded(run, opts, demand, seq)) {
                return install(run, opts, wait, before, result)
            }
            // Undo before `stopped` can throw, so an aborted result leaves
            // the filings as they were. A superseded load resolves with the
            // newer one, so the caller never resolves before its rows.
            result?.filings.undo()
            if (demand.seq !== seq) return demand.loading ?? []
            stopped(run, opts, wait)
            return []
        })()
        demand.loading = loading
        return loading
    }

    function expire(run: Run, opts: LoadSubsetOptions): void {
        const demand = run.demands.get(opts)
        if (!demand) return
        if (demand.parked !== undefined) clearTimeout(demand.parked)
        demand.wake?.()
        run.demands.delete(opts)
        if (demand.counted) realtime.releaseQueryFilters(demand.filters)
        membership.drop([opts])
        onLoadStatusChange()
    }

    // An unloaded subset is parked: its rows stay held and its realtime
    // filters stay open for `subsetGcTime`, so a panel that mounts again
    // adopts them with no request. A reload or cleanup expires every parked
    // demand, because a parked demand is a cache.
    function unloadSubset(run: Run, opts: LoadSubsetOptions): void {
        try {
            const demand = run.demands.get(opts)
            if (!demand) return
            if (subsetGcTime <= 0 || demand.parked !== undefined || !demand.landed) {
                expire(run, opts)
                return
            }
            demand.parked = setTimeout(() => {
                if (current === run) expire(run, opts)
            }, subsetGcTime)
            onLoadStatusChange()
        } catch (error) {
            logger.error('unloadSubset failed', { collectionName, error })
        }
    }

    function expireParked(run: Run): void {
        for (const [opts, demand] of [...run.demands]) {
            if (demand.parked !== undefined) expire(run, opts)
        }
    }

    /** Take the parked demand equal to `demand`, keeping its filter refs for the caller. */
    function unpark(run: Run, demand: Demand): LoadSubsetOptions | undefined {
        const key = keyOf(demand)
        for (const [opts, parked] of run.demands) {
            if (parked.parked === undefined || keyOf(parked) !== key) continue
            clearTimeout(parked.parked)
            run.demands.delete(opts)
            onLoadStatusChange()
            return opts
        }
        return undefined
    }

    function serve(opts: LoadSubsetOptions, demand: Demand): Applied {
        if (opts.refetch) return false
        const served = fetcher.serveFromStore(demand.request)
        if (!served) return false
        demand.seq += 1
        demand.loading = undefined
        demand.landed = true
        return membership.reconcile(opts, served, [ACCEPTED])
    }

    // Adopting a parked demand moves its rows to the new holder in one
    // transaction and inherits its realtime filter refs.
    function adopt(opts: LoadSubsetOptions, parkedOpts: LoadSubsetOptions): Applied {
        const rows: T[] = []
        for (const id of ledger.idsOf(parkedOpts)) {
            const row = ledger.row(id)
            if (row) rows.push(row)
        }
        return membership.reconcile(opts, rows, [ACCEPTED, parkedOpts])
    }

    // Rows already at hand for a new demand: a parked equal demand's, or
    // the store's. False when a fetch is needed.
    function startFromHeld(
        opts: LoadSubsetOptions,
        demand: Demand,
        parkedOpts: LoadSubsetOptions | undefined
    ): Applied {
        if (parkedOpts === undefined) return serve(opts, demand)
        const adopted = adopt(opts, parkedOpts)
        demand.landed = true
        return opts.refetch === true ? false : adopted
    }

    // Rows adopted while a reload is running predate it; fetch them again
    // so the adopter is as fresh as the rest.
    function refetchAdopted(run: Run, opts: LoadSubsetOptions, demand: Demand): void {
        void load(run, opts, demand, 'accepted', true).catch(error =>
            logger.error('Refetch after adopting a parked subset failed', { collectionName, error })
        )
    }

    function startHeld(
        run: Run,
        opts: LoadSubsetOptions,
        demand: Demand,
        parkedOpts: LoadSubsetOptions | undefined
    ): Applied {
        try {
            const applied = startFromHeld(opts, demand, parkedOpts)
            if (applied !== false && parkedOpts !== undefined && reloading) {
                refetchAdopted(run, opts, demand)
            }
            return applied
        } catch (error) {
            expire(run, opts)
            throw error
        }
    }

    function loadSubsetIn(run: Run) {
        return (opts: LoadSubsetOptions): true | Promise<void> => {
            // Core passes a fresh options object per acquisition; a direct
            // caller that reuses one must not leak the earlier demand's refs.
            if (run.demands.has(opts)) expire(run, opts)
            const demand = demandFor(opts)
            const parkedOpts = unpark(run, demand)
            run.demands.set(opts, demand)
            if (parkedOpts === undefined && demand.counted) {
                realtime.retainQueryFilters(demand.filters)
            }
            const applied = startHeld(run, opts, demand, parkedOpts)
            if (applied !== false) return applied
            // A load that fails keeps retrying and keeps its demand, so the
            // live query stays loading rather than erroring; a reload() or
            // reconnect wakes it. An unload releases it as usual.
            return load(run, opts, demand, 'visible', opts.refetch === true).then(() => undefined)
        }
    }

    // A superseded eager load waits for the newer one, so readiness never
    // fires before the rows a later load brings.
    /** Like `retryAllowed` for the eager load; throws when the load is stale, so it never installs. */
    async function eagerRetryAllowed(
        run: Run,
        seq: number,
        attempt: number,
        error: unknown
    ): Promise<void> {
        const stale = () => run.abort.signal.aborted || run.eagerSeq !== seq
        if (stale()) throw error
        if (loadRetryDelays.length === 0 || !isRetryable(error)) {
            run.eagerFailed = true
            onLoadStatusChange()
            throw error
        }
        const delay = retryDelay(attempt, error)
        logger.warn('Eager load failed; retrying', { collectionName, attempt, delay, error })
        run.eagerRetryingSince ??= Date.now()
        onLoadStatusChange()
        await sleep(delay, wake => {
            run.eagerWake = wake
        })
        run.eagerWake = undefined
        if (stale()) throw error
    }

    async function fetchEagerWithRetry(run: Run, seq: number): Promise<FetchResult<T>> {
        try {
            for (let attempt = 0; ; attempt++) {
                try {
                    return await fetchRows(run, {}, undefined, false, undefined)
                } catch (error) {
                    await eagerRetryAllowed(run, seq, attempt, error)
                }
            }
        } finally {
            if (run.eagerSeq === seq) {
                run.eagerRetryingSince = undefined
                onLoadStatusChange()
            }
        }
    }

    function loadEagerRows(run: Run): Promise<string[]> {
        run.eagerWake?.()
        const seq = ++run.eagerSeq
        run.eagerFailed = false
        run.eagerRetryingSince = undefined
        onLoadStatusChange()
        const loading = (async (): Promise<string[]> => {
            const { rows, filings } = await fetchEagerWithRetry(run, seq)
            if (run.abort.signal.aborted || run.eagerSeq !== seq) {
                filings.undo()
                return run.eagerSeq !== seq ? (run.eagerLoad ?? []) : []
            }
            const applied = membership.reconcile(EAGER, rows, [ACCEPTED])
            if (applied === false) {
                filings.undo()
                return []
            }
            filings.commit()
            await settle(applied, 'accepted')
            return idsOf(rows)
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

    async function reloadRows(run: Run): Promise<Set<string>> {
        const loaded =
            syncMode === 'eager'
                ? [await loadEagerRows(run)]
                : await Promise.all(
                      [...run.demands].map(([opts, demand]) =>
                          load(run, opts, demand, 'accepted', true)
                      )
                  )
        return new Set(loaded.flat())
    }

    async function releaseUnconfirmed(
        run: Run,
        before: [Holder, string[]][],
        confirmed: Set<string>
    ): Promise<void> {
        for (const [holder, ids] of before) {
            if (run.abort.signal.aborted) return
            const unconfirmed = ids.filter(id => !confirmed.has(id))
            if (unconfirmed.length > 0) {
                await settle(membership.drop([holder], unconfirmed), 'accepted')
            }
        }
    }

    async function reloadNow(): Promise<void> {
        const run = current
        if (!run || !store.isAttached()) return
        expireParked(run)
        const before = releasable()
        let confirmed: Set<string>
        try {
            confirmed = await reloadRows(run)
        } catch (error) {
            if (run.abort.signal.aborted) return
            throw error
        }
        await releaseUnconfirmed(run, before, confirmed)
    }

    // Callers during a reload share one follow-up reload, which starts when
    // the current one settles: a change that landed after the current fetch
    // went out still gets a fresh fetch, and no request is sent per caller.
    let reloading: Promise<void> | undefined
    let queued: Promise<void> | undefined
    // Every call wakes the retries at once, also when it only queues behind
    // a reload in flight: the waiting loads try again now, under the current
    // auth, instead of sleeping out their delay.
    function reload(): Promise<void> {
        if (current) wakeRetries(current)
        if (!reloading) {
            reloading = reloadNow().finally(() => {
                reloading = undefined
            })
            return reloading
        }
        queued ??= reloading
            .catch(() => undefined)
            .then(() => {
                queued = undefined
                return reload()
            })
        return queued
    }

    return {
        sync: params => {
            const channel: SyncChannel<T> = params
            const run: Run = {
                abort: new AbortController(),
                demands: new Map(),
                eagerSeq: 0,
                eagerLoad: undefined,
                eagerWake: undefined,
                eagerRetryingSince: undefined,
                eagerFailed: false,
            }
            current = run
            store.attach(channel)
            // Core has already fenced this run's writes when it calls
            // cleanup; the abort stops its requests, and every async path
            // checks it before it writes.
            const cleanup = () => {
                run.abort.abort()
                run.eagerWake?.()
                for (const demand of run.demands.values()) {
                    if (demand.parked !== undefined) clearTimeout(demand.parked)
                    demand.wake?.()
                }
                run.demands.clear()
                if (current === run) current = undefined
                store.detach(channel)
                ledger.clear()
                subsets.clear()
                if (syncMode === 'on-demand') realtime.resetQueryFilters()
                deps.onCleanup()
                onLoadStatusChange()
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
        noteDeleted: (id, topic) => {
            for (const [deleted, filters] of tombstones) {
                if (topic === '*' || filters?.includes(topic)) deleted.add(id)
            }
        },
        isDeleted: id => [...tombstones.keys()].some(deleted => deleted.has(id)),
        expireParked: () => {
            if (current) expireParked(current)
        },
        wakeRetries: () => {
            if (current) wakeRetries(current)
        },
        holdersFor: row => {
            if (!current) return []
            if (syncMode === 'eager') return [EAGER]
            return [...current.demands]
                .filter(
                    ([opts, demand]) =>
                        demand.parked === undefined &&
                        demand.landed &&
                        matcherFor(opts.where, true)(row)
                )
                .map(([opts]) => opts)
        },
        loadStatus,
    }
}
