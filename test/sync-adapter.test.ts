import {
    eq,
    gt,
    IR,
    isNull,
    LoadSubsetOperationAbortedError,
    type LoadSubsetOptions,
    like,
    type SyncConfig,
    withAcceptedReceipt,
} from '@tanstack/db'
import { describe, expect, it, vi } from 'vitest'
import type { Fetcher, FetchOptions, FetchResult } from '../src/fetch-records'
import { ACCEPTED, createLedger, EAGER } from '../src/ledger'
import { createLoadedSubsets } from '../src/loaded-subsets'
import { createMembership } from '../src/membership'
import { type PbRequest, realtimeFiltersFor, toRequest } from '../src/request'
import { createSyncAdapter } from '../src/sync-adapter'
import { createSyncedStore } from '../src/synced-store'

type Row = { id: string; name: string; updated: string }
type SyncParams = Parameters<SyncConfig<Row, string | number>['sync']>[0]

const row = (id: string, name = id): Row => ({ id, name, updated: '2026-01-01 00:00:00.000Z' })
const named = (name: string): LoadSubsetOptions => ({ where: eq(new IR.PropRef(['name']), name) })

type Call = {
    request: PbRequest
    options: FetchOptions | undefined
    resolve: (rows: Row[]) => void
    reject: (error: unknown) => void
}

function deferred() {
    let resolve: () => void = () => undefined
    const promise = new Promise<void>(done => {
        resolve = done
    })
    return { promise, resolve }
}

function setup(syncMode: 'eager' | 'on-demand' = 'on-demand', subsetGcTime = 0) {
    const calls: Call[] = []
    let served: Row[] | undefined
    const fetcher: Fetcher<Row> = {
        fetchRecords: (request, options) =>
            new Promise<FetchResult<Row>>((resolve, reject) => {
                calls.push({
                    request,
                    options,
                    resolve: rows => resolve({ rows, fromStore: false }),
                    reject,
                })
            }),
        serveFromStore: () => served,
        expectFiling: () => () => undefined,
    }
    const log: string[] = []
    let commitReceipt: () => true | Promise<void> = () => true
    const markReady = vi.fn()
    const markError = vi.fn()
    const params = {
        begin: () => {
            log.push('begin')
        },
        write: message => {
            log.push(
                'key' in message
                    ? `delete:${String(message.key)}`
                    : `${message.type}:${message.value.id}`
            )
        },
        commit: () => {
            log.push('commit')
            return commitReceipt()
        },
        markReady,
        markError,
        truncate: () => undefined,
    } satisfies Omit<SyncParams, 'collection'>
    const ledger = createLedger<Row>()
    const store = createSyncedStore<Row>('rows')
    const subsets = createLoadedSubsets()
    const membership = createMembership<Row>({
        collectionName: 'rows',
        ledger,
        store,
        onRemoved: () => undefined,
    })
    const realtime = {
        retainQueryFilters: vi.fn(),
        releaseQueryFilters: vi.fn(),
        resetQueryFilters: vi.fn(),
    }
    const onCleanup = vi.fn()
    const adapter = createSyncAdapter<Row>({
        collectionName: 'rows',
        syncMode,
        realtimeMode: 'query',
        subsetGcTime,
        ledger,
        store,
        membership,
        fetcher,
        subsets,
        realtime,
        registry: () => ({ tagFor: () => undefined, withViewExpand: opts => opts }),
        onCleanup,
    })
    const result = adapter.sync(params as unknown as SyncParams)
    const res = result && typeof result === 'object' ? result : {}
    const loadSubset = (opts: LoadSubsetOptions) => {
        if (!res.loadSubset) throw new Error('no loadSubset')
        return res.loadSubset(opts)
    }
    const unloadSubset = (opts: LoadSubsetOptions) => res.unloadSubset?.(opts)
    const cleanup = () => res.cleanup?.()
    return {
        adapter,
        calls,
        log,
        ledger,
        membership,
        realtime,
        markReady,
        markError,
        loadSubset,
        unloadSubset,
        cleanup,
        serve: (rows: Row[] | undefined) => {
            served = rows
        },
        receipt: (fn: () => true | Promise<void>) => {
            commitReceipt = fn
        },
    }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('sync adapter', () => {
    it('a stale first load that finishes after a reload installs nothing', async () => {
        const t = setup()
        const opts: LoadSubsetOptions = {}
        const first = t.loadSubset(opts)
        const reload = t.adapter.reload()
        expect(t.calls).toHaveLength(2)
        t.calls[1].resolve([row('b')])
        await reload
        t.calls[0].resolve([row('a')])
        await first
        expect(t.ledger.idsOf(opts)).toEqual(['b'])
        expect(t.ledger.has('a')).toBe(false)
    })

    it('a demand unloaded during its fetch writes nothing', async () => {
        const t = setup()
        const opts: LoadSubsetOptions = {}
        const load = t.loadSubset(opts)
        t.unloadSubset(opts)
        t.unloadSubset(opts)
        t.calls[0].resolve([row('a')])
        await load
        expect(t.log).toEqual([])
        expect(t.ledger.idsOf(opts)).toEqual([])
        expect(t.realtime.releaseQueryFilters).toHaveBeenCalledTimes(1)
    })

    it('an abort before the receipt rejects with LoadSubsetOperationAbortedError', async () => {
        const t = setup()
        const abort = new AbortController()
        const load = t.loadSubset({ signal: abort.signal })
        abort.abort()
        t.calls[0].resolve([row('a')])
        await expect(load).rejects.toBeInstanceOf(LoadSubsetOperationAbortedError)
    })

    it('an abort after an accepted receipt still rejects with LoadSubsetOperationAbortedError', async () => {
        const t = setup()
        const visible = deferred()
        t.receipt(() => withAcceptedReceipt(visible.promise, true))
        const abort = new AbortController()
        const load = t.loadSubset({ signal: abort.signal })
        t.calls[0].resolve([row('a')])
        await flush()
        expect(t.log).toEqual(['begin', 'insert:a', 'commit'])
        abort.abort()
        visible.resolve()
        await expect(load).rejects.toBeInstanceOf(LoadSubsetOperationAbortedError)
    })

    it('a row deleted during its fetch is not installed', async () => {
        const t = setup()
        const opts: LoadSubsetOptions = {}
        const load = t.loadSubset(opts)
        t.adapter.noteDeleted('a')
        t.calls[0].resolve([row('a'), row('b')])
        await load
        expect(t.ledger.has('a')).toBe(false)
        expect(t.ledger.idsOf(opts)).toEqual(['b'])
    })

    it('an eager first-load failure calls markError once', async () => {
        const t = setup('eager')
        t.calls[0].reject(new Error('down'))
        await flush()
        expect(t.markError).toHaveBeenCalledTimes(1)
        expect(t.markReady).not.toHaveBeenCalled()
    })

    it('an eager first load that settles after cleanup calls nothing and writes nothing', async () => {
        const ok = setup('eager')
        ok.cleanup()
        ok.calls[0].resolve([row('a')])
        await flush()
        const failed = setup('eager')
        failed.cleanup()
        failed.calls[0].reject(new Error('down'))
        await flush()
        for (const t of [ok, failed]) {
            expect(t.markReady).not.toHaveBeenCalled()
            expect(t.markError).not.toHaveBeenCalled()
            expect(t.log).toEqual([])
        }
    })

    it('an eager first load marks ready once its rows are accepted', async () => {
        const t = setup('eager')
        t.calls[0].resolve([row('a')])
        await flush()
        expect(t.markReady).toHaveBeenCalledTimes(1)
        expect(t.ledger.has('a')).toBe(true)
    })

    it('reload keeps confirmed rows topic holders and releases unconfirmed ones', async () => {
        const t = setup()
        const opts: LoadSubsetOptions = {}
        const load = t.loadSubset(opts)
        t.calls[0].resolve([row('a'), row('b')])
        await load
        t.membership.land('topic', [row('a'), row('c')])
        const reload = t.adapter.reload()
        t.calls[1].resolve([row('a')])
        await reload
        expect(t.ledger.idsOf('topic')).toEqual(['a'])
        expect(t.ledger.has('b')).toBe(false)
        expect(t.ledger.has('c')).toBe(false)
        t.unloadSubset(opts)
        expect(t.ledger.has('a')).toBe(true)
    })

    it('cleanup during a load stops every later write', async () => {
        const t = setup()
        const load = t.loadSubset({})
        t.cleanup()
        t.calls[0].resolve([row('a')])
        await expect(load).rejects.toBeInstanceOf(LoadSubsetOperationAbortedError)
        expect(t.log).toEqual([])
        expect(t.ledger.size()).toBe(0)
        expect(t.realtime.resetQueryFilters).toHaveBeenCalledTimes(1)
    })

    it('a subset the store serves returns true synchronously and holds its rows', () => {
        const t = setup()
        t.serve([row('a')])
        const opts: LoadSubsetOptions = {}
        expect(t.loadSubset(opts)).toBe(true)
        expect(t.calls).toHaveLength(0)
        expect(t.ledger.idsOf(opts)).toEqual(['a'])
    })

    it('refetch skips the store', async () => {
        const t = setup()
        t.serve([row('a')])
        const load = t.loadSubset({ refetch: true })
        expect(t.calls).toHaveLength(1)
        expect(t.calls[0].options?.refetch).toBe(true)
        t.calls[0].resolve([row('a')])
        await load
    })
    describe('a fresh result releases accepted and topic holders it omits', () => {
        const topic = realtimeFiltersFor(toRequest(named('x')))?.[0]
        if (topic === undefined) throw new Error('no realtime filter for the where')

        it('a matching row held only by ACCEPTED or the demand topic and omitted leaves the ledger', async () => {
            const t = setup()
            const opts = named('x')
            t.membership.land(ACCEPTED, [row('a', 'x')])
            t.membership.land(topic, [row('c', 'x')])
            const load = t.loadSubset(opts)
            t.calls[0].resolve([row('b', 'x')])
            await load
            expect(t.ledger.has('a')).toBe(false)
            expect(t.ledger.has('c')).toBe(false)
            expect(t.log).toContain('delete:a')
            expect(t.log).toContain('delete:c')
            expect(t.ledger.idsOf(opts)).toEqual(['b'])
        })

        it('a row the result contains keeps its subset holder and drops ACCEPTED', async () => {
            const t = setup()
            const opts = named('x')
            t.membership.land(ACCEPTED, [row('a', 'x')])
            const load = t.loadSubset(opts)
            t.calls[0].resolve([row('a', 'x')])
            await load
            expect(t.ledger.idsOf(opts)).toEqual(['a'])
            expect(t.ledger.idsOf(ACCEPTED)).toEqual([])
        })

        it('a row that does not match the where is untouched', async () => {
            const t = setup()
            const opts = named('x')
            t.membership.land(ACCEPTED, [row('a', 'y')])
            t.membership.land(topic, [row('c', 'y')])
            const load = t.loadSubset(opts)
            t.calls[0].resolve([])
            await load
            expect(t.ledger.idsOf(ACCEPTED)).toEqual(['a'])
            expect(t.ledger.idsOf(topic)).toEqual(['c'])
        })

        it("a row the '*' topic holds is untouched", async () => {
            const t = setup()
            t.membership.land('*', [row('a', 'x')])
            const opts: LoadSubsetOptions = {}
            const load = t.loadSubset(opts)
            t.calls[0].resolve([])
            await load
            expect(t.ledger.idsOf('*')).toEqual(['a'])
            expect(t.log).not.toContain('delete:a')
        })

        it('a row a subset holds is untouched', async () => {
            const t = setup()
            const other: LoadSubsetOptions = {}
            const loadOther = t.loadSubset(other)
            t.calls[0].resolve([row('a', 'x')])
            await loadOther
            const opts = named('x')
            const load = t.loadSubset(opts)
            t.calls[1].resolve([])
            await load
            expect(t.ledger.idsOf(other)).toEqual(['a'])
            expect(t.log).not.toContain('delete:a')
        })

        it('a row that changes while the fetch is in flight is untouched', async () => {
            const t = setup()
            const opts = named('x')
            const load = t.loadSubset(opts)
            t.membership.land(ACCEPTED, [row('a', 'x')])
            t.calls[0].resolve([])
            await load
            expect(t.ledger.idsOf(ACCEPTED)).toEqual(['a'])
        })

        // The release is safe only while the client predicate matches no row
        // PocketBase's would reject. These pin the known differences in the
        // safe direction: `~` is case-insensitive, `= null` matches '', and a
        // Date compares as a string on the server.
        describe('the client predicate is not laxer than PocketBase', () => {
            const kept = async (opts: LoadSubsetOptions, stored: Row) => {
                const t = setup()
                t.membership.land(ACCEPTED, [stored])
                const load = t.loadSubset(opts)
                t.calls[0].resolve([])
                await load
                expect(t.ledger.idsOf(ACCEPTED)).toEqual([stored.id])
            }

            it('like is case-sensitive', () =>
                kept({ where: like(new IR.PropRef<string>(['name']), 'x%') }, row('a', 'Xy')))

            it('isNull does not match an empty string', () =>
                kept({ where: isNull(new IR.PropRef(['name'])) }, row('a', '')))

            it('a Date compared to a timestamp string matches nothing', () =>
                kept(
                    { where: gt(new IR.PropRef(['updated']), new Date('2020-01-01T00:00:00Z')) },
                    row('a', 'x')
                ))
        })
    })

    describe('a parked subset', () => {
        const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

        it('is adopted by an equal load within the window with no request, inheriting its filter refs', async () => {
            const t = setup('on-demand', 1000)
            const first = named('x')
            const load = t.loadSubset(first)
            t.calls[0].resolve([row('a', 'x')])
            await load
            t.unloadSubset(first)
            expect(t.ledger.idsOf(first)).toEqual(['a'])
            expect(t.realtime.releaseQueryFilters).not.toHaveBeenCalled()

            const second = named('x')
            expect(t.loadSubset(second)).toBe(true)
            expect(t.calls).toHaveLength(1)
            expect(t.ledger.idsOf(second)).toEqual(['a'])
            expect(t.ledger.idsOf(first)).toEqual([])
            expect(t.realtime.retainQueryFilters).toHaveBeenCalledTimes(1)
            expect(t.realtime.releaseQueryFilters).not.toHaveBeenCalled()

            t.unloadSubset(second)
            await wait(1100)
            expect(t.ledger.has('a')).toBe(false)
            expect(t.realtime.releaseQueryFilters).toHaveBeenCalledTimes(1)
        })

        it('is not adopted by a load with a different request', async () => {
            const t = setup('on-demand', 1000)
            const first = named('x')
            const load = t.loadSubset(first)
            t.calls[0].resolve([row('a', 'x')])
            await load
            t.unloadSubset(first)
            const other = t.loadSubset(named('y'))
            expect(t.calls).toHaveLength(2)
            t.calls[1].resolve([])
            await other
            expect(t.ledger.idsOf(first)).toEqual(['a'])
        })

        it('expires after the window, releasing its rows and filters', async () => {
            const t = setup('on-demand', 20)
            const opts = named('x')
            const load = t.loadSubset(opts)
            t.calls[0].resolve([row('a', 'x')])
            await load
            t.unloadSubset(opts)
            expect(t.ledger.has('a')).toBe(true)
            await wait(60)
            expect(t.ledger.has('a')).toBe(false)
            expect(t.realtime.releaseQueryFilters).toHaveBeenCalledTimes(1)
            expect(t.log).toContain('delete:a')
        })

        it('is adopted and then refetched when the load asks for a refetch', async () => {
            const t = setup('on-demand', 1000)
            const first = named('x')
            const load = t.loadSubset(first)
            t.calls[0].resolve([row('a', 'x')])
            await load
            t.unloadSubset(first)
            const second = { ...named('x'), refetch: true }
            const reloading = t.loadSubset(second)
            expect(t.ledger.idsOf(second)).toEqual(['a'])
            expect(t.calls).toHaveLength(2)
            t.calls[1].resolve([row('b', 'x')])
            await reloading
            expect(t.ledger.idsOf(second)).toEqual(['b'])
            expect(t.ledger.has('a')).toBe(false)
            t.unloadSubset(second)
            await wait(1100)
        })

        it('is expired by a reload instead of being refetched', async () => {
            const t = setup('on-demand', 1000)
            const opts = named('x')
            const load = t.loadSubset(opts)
            t.calls[0].resolve([row('a', 'x')])
            await load
            t.unloadSubset(opts)
            await t.adapter.reload()
            expect(t.calls).toHaveLength(1)
            expect(t.ledger.has('a')).toBe(false)
            expect(t.realtime.releaseQueryFilters).toHaveBeenCalledTimes(1)
        })

        it('is not parked when its load never landed, so an equal load fetches', async () => {
            const t = setup('on-demand', 1000)
            const abort = new AbortController()
            const first = { ...named('x'), signal: abort.signal }
            const load = t.loadSubset(first)
            abort.abort()
            t.unloadSubset(first)
            expect(t.realtime.releaseQueryFilters).toHaveBeenCalledTimes(1)
            t.calls[0].resolve([row('a', 'x')])
            await expect(load).rejects.toBeInstanceOf(LoadSubsetOperationAbortedError)

            const second = named('x')
            const next = t.loadSubset(second)
            expect(t.calls).toHaveLength(2)
            t.calls[1].resolve([row('a', 'x')])
            await next
            expect(t.ledger.idsOf(second)).toEqual(['a'])
        })

        it('is released by expireParked', async () => {
            const t = setup('on-demand', 1000)
            const opts = named('x')
            const load = t.loadSubset(opts)
            t.calls[0].resolve([row('a', 'x')])
            await load
            t.unloadSubset(opts)
            t.adapter.expireParked()
            expect(t.ledger.has('a')).toBe(false)
            expect(t.realtime.releaseQueryFilters).toHaveBeenCalledTimes(1)
        })

        it('is forgotten by cleanup without a late release', async () => {
            const t = setup('on-demand', 20)
            const opts = named('x')
            const load = t.loadSubset(opts)
            t.calls[0].resolve([row('a', 'x')])
            await load
            t.unloadSubset(opts)
            t.cleanup()
            await wait(60)
            expect(t.realtime.releaseQueryFilters).not.toHaveBeenCalled()
            expect(t.realtime.resetQueryFilters).toHaveBeenCalledTimes(1)
        })
    })

    it('holdersFor lists the live, landed demands whose where matches the row', async () => {
        const t = setup('on-demand', 1000)
        const live = named('x')
        const other = named('y')
        const parked = { ...named('x'), limit: 1 }
        const loading = { ...named('x'), limit: 2 }
        for (const [index, opts] of [live, other, parked].entries()) {
            const load = t.loadSubset(opts)
            t.calls[index].resolve([])
            await load
        }
        t.unloadSubset(parked)
        void t.loadSubset(loading)
        expect(t.adapter.holdersFor(row('a', 'x'))).toEqual([live])
        expect(t.adapter.holdersFor(row('b', 'y'))).toEqual([other])
        expect(t.adapter.holdersFor(row('c', 'z'))).toEqual([])
        t.adapter.expireParked()
    })

    it('holdersFor is EAGER in eager mode', async () => {
        const t = setup('eager')
        t.calls[0].resolve([])
        await flush()
        expect(t.adapter.holdersFor(row('a'))).toEqual([EAGER])
    })

    it('isDeleted reports an id deleted while a fetch is in flight, and forgets it after', async () => {
        const t = setup()
        const load = t.loadSubset({})
        t.adapter.noteDeleted('a')
        expect(t.adapter.isDeleted('a')).toBe(true)
        t.calls[0].resolve([row('a'), row('b')])
        await load
        expect(t.adapter.isDeleted('a')).toBe(false)
        expect(t.ledger.has('a')).toBe(false)
    })

    it('reloads called during a reload share one follow-up reload', async () => {
        const t = setup()
        const opts: LoadSubsetOptions = {}
        const load = t.loadSubset(opts)
        t.calls[0].resolve([row('a')])
        await load
        const first = t.adapter.reload()
        const second = t.adapter.reload()
        const third = t.adapter.reload()
        expect(t.calls).toHaveLength(2)
        t.calls[1].resolve([row('a')])
        await first
        await flush()
        expect(t.calls).toHaveLength(3)
        t.calls[2].resolve([row('a'), row('b')])
        await Promise.all([second, third])
        expect(t.calls).toHaveLength(3)
        expect(t.ledger.idsOf(opts)).toEqual(['a', 'b'])
    })

    it('a superseded load resolves only after the newer load has landed its rows', async () => {
        const t = setup()
        const opts: LoadSubsetOptions = {}
        let landedFirst: boolean | undefined
        const first = Promise.resolve(t.loadSubset(opts)).then(() => {
            landedFirst = t.ledger.has('b')
        })
        const reload = t.adapter.reload()
        t.calls[0].resolve([row('a')])
        await flush()
        expect(landedFirst).toBeUndefined()
        t.calls[1].resolve([row('b')])
        await Promise.all([first, reload])
        expect(landedFirst).toBe(true)
        expect(t.ledger.idsOf(opts)).toEqual(['b'])
    })

    it('a reload queued behind another installs what its own result returns', async () => {
        const t = setup()
        const opts: LoadSubsetOptions = {}
        const load = t.loadSubset(opts)
        t.calls[0].resolve([row('a')])
        await load
        t.membership.land('topic', [row('a')])
        const older = t.adapter.reload()
        const newer = t.adapter.reload()
        t.calls[1].resolve([])
        await older
        expect(t.ledger.has('a')).toBe(false)
        await flush()
        t.calls[2].resolve([row('a')])
        await newer
        expect(t.ledger.idsOf(opts)).toEqual(['a'])
    })

    it('an aborted load keeps the accepted holder of a row it returned', async () => {
        const t = setup()
        const visible = deferred()
        t.receipt(() => withAcceptedReceipt(visible.promise, true))
        t.membership.land(ACCEPTED, [row('a')])
        const abort = new AbortController()
        const opts: LoadSubsetOptions = { signal: abort.signal }
        const load = t.loadSubset(opts)
        t.calls[0].resolve([row('a')])
        await flush()
        abort.abort()
        visible.resolve()
        await expect(load).rejects.toBeInstanceOf(LoadSubsetOperationAbortedError)
        t.unloadSubset(opts)
        expect(t.ledger.idsOf(ACCEPTED)).toEqual(['a'])
    })
})
