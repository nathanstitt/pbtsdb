import { eq, useLiveQuery } from '@tanstack/react-db'
import { act, renderHook, waitFor } from '@testing-library/react'
import PocketBase from 'pocketbase'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCollection, getSyncStatus, subscribeSyncStatus, useSyncStatus } from '../src'
import { createSyncStatusStore, type LoadStatus, type RealtimeStatus } from '../src/sync-status'
import { realtimeClientFor } from '../src/transport'
import type { Schema } from './schema'

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

    it('returns the same snapshot until a value changes', () => {
        const t = setup()
        const first = t.store.get()
        t.store.refresh()
        expect(t.store.get()).toBe(first)
        expect(t.seen).toEqual([])

        t.setRealtime({ state: 'connecting' })
        t.store.refresh()
        const second = t.store.get()
        expect(second).not.toBe(first)
        expect(second.loads).toBe(first.loads)
        expect(t.seen).toEqual([second])

        t.setRealtime({ state: 'connecting' })
        t.store.refresh()
        expect(t.store.get()).toBe(second)
    })

    it('keeps the realtime object while only loads change, and compares reconnecting by value', () => {
        const t = setup()
        t.setRealtime({ state: 'reconnecting', attempt: 1, nextRetryAt: 10, since: 5 })
        t.store.refresh()
        const realtime = t.store.get().realtime
        t.setRealtime({ state: 'reconnecting', attempt: 1, nextRetryAt: 10, since: 5 })
        t.loads.push({ retrying: 1, failed: 0, failingSince: 7 })
        t.store.refresh()
        expect(t.store.get().realtime).toBe(realtime)
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
            expect(seen.at(-1)).toBe(getSyncStatus(pb))
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

    it('re-renders only when the status changes', () => {
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
        act(() => {
            void realtimeClientFor(pb).subscribe('books', () => undefined)
        })
        expect(result.current.realtime).toEqual({ state: 'connecting' })
        expect(renders).toBe(before + 1)
        act(() => {
            realtimeClientFor(pb).disable()
        })
        expect(result.current.realtime).toEqual({ state: 'disabled' })
    })
})
