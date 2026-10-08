import { eq, useLiveQuery } from '@tanstack/react-db'
import { act, renderHook, waitFor } from '@testing-library/react'
import PocketBase from 'pocketbase'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCollection, getSyncStatus, subscribeSyncStatus, useSyncStatus } from '../src'
import { createSyncStatusStore, type LoadStatus, type RealtimeStatus } from '../src/sync-status'
import { realtimeClientFor, transportFor } from '../src/transport'
import type { Schema } from './schema'

const microtasks = () => new Promise<void>(resolve => queueMicrotask(resolve))

class IdleEventSource {
    addEventListener() {}
    removeEventListener() {}
    close() {}
}

describe('sync status store', () => {
    function setup() {
        let realtime: RealtimeStatus = { state: 'disabled' }
        const loads: LoadStatus[] = []
        const store = createSyncStatusStore({ realtime: () => realtime, loads: () => loads })
        const seen: unknown[] = []
        store.subscribe(status => seen.push(status))
        return {
            store,
            seen,
            setRealtime: (next: RealtimeStatus) => {
                realtime = next
            },
            loads,
        }
    }

    it('returns the same snapshot until a value changes', async () => {
        const t = setup()
        const first = t.store.get()
        t.store.refresh()
        await microtasks()
        expect(t.store.get()).toBe(first)
        expect(t.seen).toEqual([])

        t.setRealtime({ state: 'connecting' })
        t.store.refresh()
        const second = t.store.get()
        expect(second).not.toBe(first)
        expect(second.loads).toBe(first.loads)
        await microtasks()
        expect(t.seen).toEqual([second])

        t.setRealtime({ state: 'connecting' })
        t.store.refresh()
        await microtasks()
        expect(t.store.get()).toBe(second)
        expect(t.seen).toEqual([second])
    })

    it('notifies once per microtask, after the last change, and never synchronously', async () => {
        const t = setup()
        t.setRealtime({ state: 'connecting' })
        t.store.refresh()
        t.setRealtime({ state: 'connected' })
        t.store.refresh()
        t.loads.push({ retrying: 1, failed: 0 })
        t.store.refresh()
        expect(t.seen).toEqual([])
        await microtasks()
        expect(t.seen).toEqual([
            { realtime: { state: 'connected' }, loads: { retrying: 1, failed: 0 } },
        ])
        expect(t.seen[0]).toBe(t.store.get())

        t.setRealtime({ state: 'disabled' })
        t.store.refresh()
        t.setRealtime({ state: 'connected' })
        t.store.refresh()
        await microtasks()
        expect(t.seen).toHaveLength(1)
    })

    it('keeps the realtime object while only loads change, and compares reconnecting by value', async () => {
        const t = setup()
        t.setRealtime({ state: 'reconnecting', attempt: 1, nextRetryAt: 10, since: 5 })
        t.store.refresh()
        const realtime = t.store.get().realtime
        t.setRealtime({ state: 'reconnecting', attempt: 1, nextRetryAt: 10, since: 5 })
        t.loads.push({ retrying: 1, failed: 0, failingSince: 7 })
        t.store.refresh()
        await microtasks()
        expect(t.store.get().realtime).toBe(realtime)
        expect(t.seen.at(-1)).toBe(t.store.get())
        expect(t.store.get().loads).toEqual({ retrying: 1, failed: 0, failingSince: 7 })
        t.setRealtime({ state: 'reconnecting', attempt: 2, nextRetryAt: 30, since: 5 })
        t.store.refresh()
        expect(t.store.get().realtime).toEqual({
            state: 'reconnecting',
            attempt: 2,
            nextRetryAt: 30,
            since: 5,
        })
    })

    it('sums loads across sources and takes the oldest failingSince', () => {
        const t = setup()
        t.loads.push({ retrying: 2, failed: 0, failingSince: 20 })
        t.loads.push({ retrying: 0, failed: 1 })
        t.loads.push({ retrying: 1, failed: 1, failingSince: 15 })
        t.store.refresh()
        expect(t.store.get().loads).toEqual({ retrying: 3, failed: 2, failingSince: 15 })
    })
})

describe('getSyncStatus', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    function fresh() {
        vi.stubGlobal('EventSource', IdleEventSource)
        const pb = new PocketBase('http://status.test')
        const collection = createCollection<Schema>(pb)
        return { pb, collection }
    }

    it('starts disabled with no loads, and the snapshot is stable', () => {
        const { pb, collection } = fresh()
        collection('books', { syncMode: 'on-demand' })
        const status = getSyncStatus(pb)
        expect(status).toEqual({
            realtime: { state: 'disabled' },
            loads: { retrying: 0, failed: 0 },
        })
        expect(getSyncStatus(pb)).toBe(status)
    })

    it('reports a query sleeping in retry, and clears it once the load succeeds', async () => {
        const { pb, collection } = fresh()
        const books = collection('books', {
            syncMode: 'on-demand',
            loadRetryDelays: [100_000],
            collectionOptions: { gcTime: 60_000 },
        })
        let failing = true
        vi.spyOn(pb.collection('books'), 'getFullList').mockImplementation(async () => {
            if (failing) throw new Error('offline')
            return []
        })
        const seen: ReturnType<typeof getSyncStatus>[] = []
        const stop = subscribeSyncStatus(pb, status => seen.push(status))
        const { result, unmount } = renderHook(() =>
            useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fiction')))
        )
        try {
            await waitFor(() => expect(getSyncStatus(pb).loads.retrying).toBe(1))
            expect(getSyncStatus(pb).loads.failingSince).toBeTypeOf('number')
            await waitFor(() => expect(seen.at(-1)).toBe(getSyncStatus(pb)))
            expect(result.current.isLoading).toBe(true)

            failing = false
            await books.reload()
            await waitFor(() => expect(getSyncStatus(pb).loads.retrying).toBe(0))
            expect(getSyncStatus(pb).loads.failingSince).toBeUndefined()
        } finally {
            stop()
            unmount()
            await books.cleanup()
        }
    })

    it('counts a collection only while it syncs, so recreated collections do not accumulate', async () => {
        const { pb, collection } = fresh()
        const transport = transportFor(pb)
        expect(transport.loadSourceCount()).toBe(0)
        vi.spyOn(pb.collection('books'), 'getFullList').mockRejectedValue(
            Object.assign(new Error('forbidden'), { status: 403 })
        )
        for (let round = 0; round < 3; round++) {
            const books = collection('books', {
                syncMode: 'on-demand',
                collectionOptions: { gcTime: 60_000 },
            })
            const { result, unmount } = renderHook(() =>
                useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fiction')))
            )
            await waitFor(() => expect(result.current.isError).toBe(true))
            expect(getSyncStatus(pb).loads.failed).toBe(1)
            expect(transport.loadSourceCount()).toBe(1)
            unmount()
            await books.cleanup()
            expect(getSyncStatus(pb).loads.failed).toBe(0)
            expect(transport.loadSourceCount()).toBe(0)
        }
    })

    it('tracks the realtime connection of the client', async () => {
        const { pb, collection } = fresh()
        const books = collection('books', { syncMode: 'on-demand' })
        vi.spyOn(pb.collection('books'), 'getFullList').mockResolvedValue([])
        const { unmount } = renderHook(() => useLiveQuery(q => q.from({ b: books })))
        try {
            await waitFor(() => expect(getSyncStatus(pb).realtime).toEqual({ state: 'connecting' }))
            realtimeClientFor(pb).disable()
            expect(getSyncStatus(pb).realtime).toEqual({ state: 'disabled' })
        } finally {
            unmount()
            await books.cleanup()
        }
    })
})

describe('useSyncStatus', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('re-renders only when the status changes', async () => {
        vi.stubGlobal('EventSource', IdleEventSource)
        const pb = new PocketBase('http://hook.test')
        createCollection<Schema>(pb)('books', { syncMode: 'on-demand' })
        let renders = 0
        const { result } = renderHook(() => {
            renders += 1
            return useSyncStatus(pb)
        })
        expect(result.current.realtime).toEqual({ state: 'disabled' })
        const before = renders
        await act(async () => {
            void realtimeClientFor(pb).subscribe('books', () => undefined)
            await microtasks()
        })
        expect(result.current.realtime).toEqual({ state: 'connecting' })
        expect(renders).toBe(before + 1)
        await act(async () => {
            realtimeClientFor(pb).disable()
            await microtasks()
        })
        expect(result.current.realtime).toEqual({ state: 'disabled' })
    })

    it('reports a live query retrying from the same tree', async () => {
        vi.stubGlobal('EventSource', IdleEventSource)
        const pb = new PocketBase('http://tree.test')
        const books = createCollection<Schema>(pb)('books', {
            syncMode: 'on-demand',
            loadRetryDelays: [100_000],
            collectionOptions: { gcTime: 60_000 },
        })
        vi.spyOn(pb.collection('books'), 'getFullList').mockRejectedValue(new Error('offline'))
        const { result, unmount } = renderHook(() => {
            const status = useSyncStatus(pb)
            const query = useLiveQuery(q =>
                q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fiction'))
            )
            return { status, query }
        })
        try {
            await waitFor(() => expect(result.current.status.loads.retrying).toBe(1))
            expect(result.current.query.isLoading).toBe(true)
        } finally {
            unmount()
            await books.cleanup()
        }
    })
})
