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
    filings: { commit: ReturnType<typeof vi.fn>; undo: ReturnType<typeof vi.fn> }
}

function deferred() {
    let resolve: () => void = () => undefined
    const promise = new Promise<void>(done => {
        resolve = done
    })
    return { promise, resolve }
}

type SetupExtra = {
    realtimeMode?: 'collection' | 'query'
    withViewExpand?: (opts: LoadSubsetOptions) => LoadSubsetOptions
    loadRetryDelays?: readonly number[]
}

function setup(
    syncMode: 'eager' | 'on-demand' = 'on-demand',
    subsetGcTime = 0,
    extra: SetupExtra = {}
) {
    const calls: Call[] = []
    let served: Row[] | undefined
    const fetcher: Fetcher<Row> = {
        fetchRecords: (request, options) =>
            new Promise<FetchResult<Row>>((resolve, reject) => {
                const filings = { commit: vi.fn(), undo: vi.fn() }
                calls.push({
                    request,
                    options,
                    resolve: rows => resolve({ rows, fromStore: false, filings }),
                    reject,
                    filings,
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
    const onLoadStatusChange = vi.fn()
    const adapter = createSyncAdapter<Row>({
        collectionName: 'rows',
        syncMode,
        realtimeMode: extra.realtimeMode ?? 'query',
        subsetGcTime,
        loadRetryDelays: extra.loadRetryDelays ?? [],
        ledger,
        store,
        membership,
        fetcher,
        subsets,
        realtime,
        registry: () => ({
            tagFor: () => undefined,
            withViewExpand: extra.withViewExpand ?? (opts => opts),
        }),
        onCleanup,
        onLoadStatusChange,
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
        onLoadStatusChange,
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
const until = async (ready: () => boolean) => {
    for (let i = 0; i < 50 && !ready(); i++) await flush()
    expect(ready()).toBe(true)
}

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
        t.adapter.noteDeleted('a', '*')
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

    it('holdersFor counts a where the client cannot evaluate as a match', async () => {
        // The request is built from the view registry's options, so the
        // converter never sees the opaque where; only the matcher does.
        const t = setup('on-demand', 1000, {
            realtimeMode: 'collection',
            withViewExpand: () => ({}),
        })
        const opaque: LoadSubsetOptions = {
            where: {
                type: 'func',
                name: 'no_such_function',
                args: [],
            } as unknown as LoadSubsetOptions['where'],
        }
        const load = t.loadSubset(opaque)
        t.calls[0].resolve([])
        await load
        expect(t.adapter.holdersFor(row('a', 'x'))).toEqual([opaque])
    })

    it('a second load with the same options object releases the first demand first', async () => {
        const t = setup()
        const opts = named('x')
        const first = t.loadSubset(opts)
        t.calls[0].resolve([row('a', 'x')])
        await first
        const second = t.loadSubset(opts)
        expect(t.realtime.releaseQueryFilters).toHaveBeenCalledTimes(1)
        expect(t.realtime.retainQueryFilters).toHaveBeenCalledTimes(2)
        t.calls[1].resolve([row('a', 'x')])
        await second
        expect(t.ledger.idsOf(opts)).toEqual(['a'])
        t.unloadSubset(opts)
        expect(t.realtime.releaseQueryFilters).toHaveBeenCalledTimes(2)
        expect(t.ledger.has('a')).toBe(false)
    })

    it('holdersFor is EAGER in eager mode', async () => {
        const t = setup('eager')
        t.calls[0].resolve([])
        await flush()
        expect(t.adapter.holdersFor(row('a'))).toEqual([EAGER])
    })

    it('an installed result commits its filings; a discarded one undoes them', async () => {
        const t = setup()
        const opts: LoadSubsetOptions = {}
        const first = t.loadSubset(opts)
        const reload = t.adapter.reload()
        t.calls[1].resolve([row('b')])
        await reload
        expect(t.calls[1].filings.commit).toHaveBeenCalledTimes(1)
        expect(t.calls[1].filings.undo).not.toHaveBeenCalled()
        t.calls[0].resolve([row('a')])
        await first
        expect(t.calls[0].filings.undo).toHaveBeenCalledTimes(1)
        expect(t.calls[0].filings.commit).not.toHaveBeenCalled()

        const abort = new AbortController()
        const aborted = t.loadSubset({ signal: abort.signal })
        abort.abort()
        t.calls[2].resolve([row('c')])
        await expect(aborted).rejects.toBeInstanceOf(LoadSubsetOperationAbortedError)
        expect(t.calls[2].filings.undo).toHaveBeenCalledTimes(1)
    })

    describe('a failed load', () => {
        it('retries after each delay and then installs', async () => {
            const t = setup('on-demand', 0, { loadRetryDelays: [0, 0] })
            const opts = named('x')
            const load = t.loadSubset(opts)
            t.calls[0].reject(new Error('down'))
            await until(() => t.calls.length === 2)
            t.calls[1].resolve([row('a', 'x')])
            await load
            expect(t.ledger.idsOf(opts)).toEqual(['a'])
        })

        it('keeps retrying at the last delay, and a reload() wakes the wait and loads it', async () => {
            const t = setup('on-demand', 0, { loadRetryDelays: [0, 100000] })
            const opts = named('x')
            const load = t.loadSubset(opts)
            t.calls[0].reject(new Error('down'))
            await until(() => t.calls.length === 2)
            t.calls[1].reject(new Error('still down'))
            await flush()
            expect(t.calls).toHaveLength(2)

            const reload = t.adapter.reload()
            expect(t.calls).toHaveLength(3)
            t.calls[2].resolve([row('a', 'x')])
            await Promise.all([load, reload])
            expect(t.ledger.idsOf(opts)).toEqual(['a'])
            expect(t.realtime.releaseQueryFilters).not.toHaveBeenCalled()
        })

        it('does not retry a response the server gave on purpose', async () => {
            const t = setup('on-demand', 0, { loadRetryDelays: [0] })
            const forbidden = Object.assign(new Error('forbidden'), { status: 403 })
            const load = t.loadSubset(named('x'))
            t.calls[0].reject(forbidden)
            await expect(load).rejects.toBe(forbidden)
            expect(t.calls).toHaveLength(1)
        })

        it('a 401 waits with no timer until a reload wakes it', async () => {
            const t = setup('on-demand', 0, { loadRetryDelays: [0] })
            const opts = named('x')
            const load = t.loadSubset(opts)
            t.calls[0].reject(Object.assign(new Error('unauthorized'), { status: 401 }))
            await flush()
            await flush()
            expect(t.calls).toHaveLength(1)

            const reload = t.adapter.reload()
            expect(t.calls).toHaveLength(2)
            t.calls[1].resolve([row('a', 'x')])
            await Promise.all([load, reload])
            expect(t.ledger.idsOf(opts)).toEqual(['a'])
        })

        it('counts a demand sleeping in retry, and not once it loads', async () => {
            const t = setup('on-demand', 0, { loadRetryDelays: [100000] })
            const opts = named('x')
            expect(t.adapter.loadStatus()).toEqual({ retrying: 0, failed: 0 })
            const load = t.loadSubset(opts)
            expect(t.adapter.loadStatus()).toEqual({ retrying: 0, failed: 0 })
            const before = Date.now()
            t.calls[0].reject(new Error('down'))
            await flush()
            const status = t.adapter.loadStatus()
            expect(status.retrying).toBe(1)
            expect(status.failed).toBe(0)
            expect(status.failingSince).toBeGreaterThanOrEqual(before)
            expect(t.onLoadStatusChange).toHaveBeenCalled()

            const reload = t.adapter.reload()
            await until(() => t.calls.length === 2)
            t.calls[1].resolve([row('a', 'x')])
            await Promise.all([load, reload])
            expect(t.adapter.loadStatus()).toEqual({ retrying: 0, failed: 0 })
        })

        it('keeps failingSince across retries and reports the oldest of several', async () => {
            const t = setup('on-demand', 0, { loadRetryDelays: [0, 100000] })
            const first = t.loadSubset(named('x'))
            t.calls[0].reject(new Error('down'))
            await flush()
            const since = t.adapter.loadStatus().failingSince
            expect(since).toBeDefined()
            await until(() => t.calls.length === 2)
            t.calls[1].reject(new Error('still down'))
            await flush()
            expect(t.adapter.loadStatus().failingSince).toBe(since)

            const second = t.loadSubset(named('y'))
            await until(() => t.calls.length === 3)
            t.calls[2].reject(new Error('down'))
            await flush()
            expect(t.adapter.loadStatus()).toEqual({ retrying: 2, failed: 0, failingSince: since })
            t.cleanup()
            expect(t.adapter.loadStatus()).toEqual({ retrying: 0, failed: 0 })
            await expect(first).rejects.toBeInstanceOf(LoadSubsetOperationAbortedError)
            await expect(second).rejects.toBeInstanceOf(LoadSubsetOperationAbortedError)
        })

        it('does not count a demand once it is unloaded or parked', async () => {
            const t = setup('on-demand', 100000, { loadRetryDelays: [100000] })
            const fresh = named('x')
            const load = t.loadSubset(fresh)
            t.calls[0].reject(new Error('down'))
            await flush()
            expect(t.adapter.loadStatus().retrying).toBe(1)
            t.unloadSubset(fresh)
            await load
            expect(t.adapter.loadStatus().retrying).toBe(0)

            const landed = named('y')
            await (async () => {
                const load = t.loadSubset(landed)
                t.calls[1].resolve([row('a', 'y')])
                await load
            })()
            void t.adapter.reload().catch(() => undefined)
            t.calls[2].reject(new Error('down'))
            await flush()
            expect(t.adapter.loadStatus().retrying).toBe(1)
            t.unloadSubset(landed)
            expect(t.adapter.loadStatus().retrying).toBe(0)
            t.cleanup()
        })

        it('counts a load the server refused as failed until its demand reloads or leaves', async () => {
            const t = setup('on-demand', 0, { loadRetryDelays: [0] })
            const opts = named('x')
            const load = t.loadSubset(opts)
            t.calls[0].reject(Object.assign(new Error('forbidden'), { status: 403 }))
            await expect(load).rejects.toMatchObject({ status: 403 })
            expect(t.adapter.loadStatus()).toEqual({ retrying: 0, failed: 1 })

            const reload = t.adapter.reload()
            expect(t.adapter.loadStatus()).toEqual({ retrying: 0, failed: 0 })
            t.calls[1].resolve([row('a', 'x')])
            await reload
            expect(t.adapter.loadStatus()).toEqual({ retrying: 0, failed: 0 })

            const again = t.adapter.reload()
            t.calls[2].reject(Object.assign(new Error('gone'), { status: 404 }))
            await expect(again).rejects.toMatchObject({ status: 404 })
            expect(t.adapter.loadStatus().failed).toBe(1)
            t.unloadSubset(opts)
            expect(t.adapter.loadStatus()).toEqual({ retrying: 0, failed: 0 })
        })

        it('counts the eager load while it retries and when it fails for good', async () => {
            const t = setup('eager', 0, { loadRetryDelays: [100000] })
            t.calls[0].reject(new Error('down'))
            await flush()
            expect(t.adapter.loadStatus().retrying).toBe(1)
            const reload = t.adapter.reload()
            await until(() => t.calls.length === 2)
            t.calls[1].resolve([row('a')])
            await reload
            expect(t.adapter.loadStatus()).toEqual({ retrying: 0, failed: 0 })

            const u = setup('eager', 0, { loadRetryDelays: [0] })
            u.calls[0].reject(Object.assign(new Error('forbidden'), { status: 403 }))
            await until(() => u.markError.mock.calls.length === 1)
            expect(u.adapter.loadStatus()).toEqual({ retrying: 0, failed: 1 })
            u.cleanup()
            expect(u.adapter.loadStatus()).toEqual({ retrying: 0, failed: 0 })
        })

        it('a reload() queued behind another wakes a waiting retry at once', async () => {
            const t = setup('on-demand', 0, { loadRetryDelays: [100000] })
            const opts = named('x')
            const load = t.loadSubset(opts)
            t.calls[0].resolve([row('a', 'x')])
            await load
            const first = t.adapter.reload()
            expect(t.calls).toHaveLength(2)
            t.calls[1].reject(new Error('down'))
            await flush()
            await flush()
            expect(t.calls).toHaveLength(2)

            const second = t.adapter.reload()
            await until(() => t.calls.length === 3)
            t.calls[2].resolve([row('b', 'x')])
            await first
            // The queued reload still runs once the first settles.
            await until(() => t.calls.length === 4)
            t.calls[3].resolve([row('b', 'x')])
            await second
            expect(t.ledger.idsOf(opts)).toEqual(['b'])
        })

        it('wakeRetries ends an eager retry wait', async () => {
            const t = setup('eager', 0, { loadRetryDelays: [100000] })
            t.calls[0].reject(new Error('down'))
            await flush()
            expect(t.calls).toHaveLength(1)
            t.adapter.wakeRetries()
            await until(() => t.calls.length === 2)
            t.calls[1].resolve([row('a')])
            await until(() => t.markReady.mock.calls.length === 1)
        })

        it('retries a server error and a rate limit', async () => {
            const t = setup('on-demand', 0, { loadRetryDelays: [0] })
            const opts = named('x')
            const load = t.loadSubset(opts)
            t.calls[0].reject(Object.assign(new Error('busy'), { status: 503 }))
            await until(() => t.calls.length === 2)
            t.calls[1].reject(Object.assign(new Error('slow down'), { status: 429 }))
            await until(() => t.calls.length === 3)
            t.calls[2].resolve([row('a', 'x')])
            await load
            expect(t.ledger.idsOf(opts)).toEqual(['a'])
        })

        it('stops retrying when the demand is unloaded meanwhile', async () => {
            const t = setup('on-demand', 0, { loadRetryDelays: [0, 0] })
            const opts = named('x')
            const load = t.loadSubset(opts)
            t.calls[0].reject(new Error('down'))
            t.unloadSubset(opts)
            await load
            expect(t.calls).toHaveLength(1)
        })

        it('an eager first load retries before it marks the error', async () => {
            const t = setup('eager', 0, { loadRetryDelays: [0] })
            t.calls[0].reject(new Error('down'))
            await until(() => t.calls.length === 2)
            expect(t.markError).not.toHaveBeenCalled()
            t.calls[1].resolve([row('a')])
            await flush()
            expect(t.markReady).toHaveBeenCalledTimes(1)
            expect(t.ledger.has('a')).toBe(true)
        })
    })

    it('a delete on a filter topic tombstones only fetches whose demand holds that filter', async () => {
        const t = setup()
        const x = named('x')
        const y = named('y')
        const xFilter = realtimeFiltersFor(toRequest(x))?.[0]
        if (!xFilter) throw new Error('no filter for x')
        const loadX = t.loadSubset(x)
        const loadY = t.loadSubset(y)
        t.adapter.noteDeleted('a', xFilter)
        t.calls[0].resolve([row('a', 'x')])
        t.calls[1].resolve([row('a', 'y')])
        await Promise.all([loadX, loadY])
        expect(t.ledger.idsOf(x)).toEqual([])
        expect(t.ledger.idsOf(y)).toEqual(['a'])
    })

    it('a parked subset adopted during a reload is fetched again', async () => {
        const t = setup('on-demand', 1000)
        const opts = named('x')
        const load = t.loadSubset(opts)
        t.calls[0].resolve([row('a', 'x')])
        await load
        const reload = t.adapter.reload()
        expect(t.calls).toHaveLength(2)
        t.unloadSubset(opts)
        const again = named('x')
        expect(t.loadSubset(again)).toBe(true)
        expect(t.ledger.idsOf(again)).toEqual(['a'])
        expect(t.calls).toHaveLength(3)
        t.calls[1].resolve([row('a', 'x')])
        t.calls[2].resolve([row('b', 'x')])
        await reload
        await until(() => t.ledger.idsOf(again).join() === 'b')
        expect(t.calls[1].filings.undo).toHaveBeenCalledTimes(1)
        t.unloadSubset(again)
        t.adapter.expireParked()
    })

    it('isDeleted reports an id deleted while a fetch is in flight, and forgets it after', async () => {
        const t = setup()
        const load = t.loadSubset({})
        t.adapter.noteDeleted('a', '*')
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
