import { eq, useLiveQuery } from '@tanstack/react-db'
import { renderHook, waitFor } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createCollection } from '../src'
import {
    disconnectRealtime,
    realtimeClientFor,
    resetRealtime,
    transportFor,
} from '../src/transport'
import {
    authenticateTestUser,
    clearAuth,
    createAuthorsCollection,
    createBooksCollection,
    pb,
    waitForLoadFinish,
} from './helpers'
import type { Schema } from './schema'

describe('reconnect refetch lifecycle', () => {
    beforeAll(async () => {
        await authenticateTestUser()
    })

    afterAll(() => {
        clearAuth()
    })

    it('registers its reconnect listener while syncing and removes it on cleanup', async () => {
        const reconnectListenerCount = () => transportFor(pb).reconnectListenerCount()
        const baseline = reconnectListenerCount()

        const books = createBooksCollection()
        expect(reconnectListenerCount()).toBe(baseline)

        const { result } = renderHook(() => useLiveQuery(q => q.from({ books })))
        await waitForLoadFinish(result)
        await books.waitForSubscription()

        await waitFor(() => expect(reconnectListenerCount()).toBe(baseline + 1))

        await books.cleanup()

        await waitFor(() => expect(reconnectListenerCount()).toBe(baseline))
    }, 20000)

    it('tracks two collections on the same pb independently', async () => {
        const reconnectListenerCount = () => transportFor(pb).reconnectListenerCount()
        const baseline = reconnectListenerCount()

        const books = createBooksCollection()
        const authors = createAuthorsCollection()

        const booksHook = renderHook(() => useLiveQuery(q => q.from({ books })))
        await waitForLoadFinish(booksHook.result)
        await books.waitForSubscription()
        await waitFor(() => expect(reconnectListenerCount()).toBe(baseline + 1))

        const authorsHook = renderHook(() => useLiveQuery(q => q.from({ authors })))
        await waitForLoadFinish(authorsHook.result)
        await authors.waitForSubscription()
        await waitFor(() => expect(reconnectListenerCount()).toBe(baseline + 2))

        await authors.cleanup()
        await waitFor(() => expect(reconnectListenerCount()).toBe(baseline + 1))

        await books.cleanup()
        await waitFor(() => expect(reconnectListenerCount()).toBe(baseline))
    }, 20000)

    it('refetches a ready, open collection after a non-resumed reconnect', async () => {
        const books = createBooksCollection()
        const { result } = renderHook(() => useLiveQuery(q => q.from({ books })))
        await waitForLoadFinish(result)
        await books.waitForSubscription()

        const getFullList = vi.spyOn(pb.collection('books'), 'getFullList')
        getFullList.mockClear()

        realtimeClientFor(pb).simulateDisconnect()
        await waitFor(() => expect(getFullList).toHaveBeenCalledTimes(1), { timeout: 10000 })

        await books.cleanup()
        getFullList.mockRestore()
    }, 20000)

    it('does not refetch a collection that is not ready when the connection reconnects', async () => {
        // Holds the collection's first load open, so its reconnect listener
        // registers (status 'loading') while `isReady()` is still false.
        let releaseFirstLoad: (() => void) | undefined
        const firstLoadGate = new Promise<void>(resolve => {
            releaseFirstLoad = resolve
        })
        const booksService = pb.collection('books')
        const original = booksService.getFullList.bind(booksService)
        const getFullList = vi.spyOn(booksService, 'getFullList')
        getFullList.mockImplementation(async (...args) => {
            await firstLoadGate
            return original(...args)
        })

        const books = createBooksCollection()
        const { result } = renderHook(() => useLiveQuery(q => q.from({ books })))

        await waitFor(() => {
            expect((books as unknown as { isSubscribed: () => boolean }).isSubscribed()).toBe(true)
        })
        expect((books as unknown as { isReady: () => boolean }).isReady()).toBe(false)

        const idBeforeDisconnect = realtimeClientFor(pb).clientId()
        realtimeClientFor(pb).simulateDisconnect()
        await waitFor(() => expect(realtimeClientFor(pb).clientId()).not.toBe(idBeforeDisconnect), {
            timeout: 10000,
        })
        expect(getFullList).toHaveBeenCalledTimes(1)

        releaseFirstLoad?.()
        await waitForLoadFinish(result)
        const callsBeforeReadyReconnect = getFullList.mock.calls.length
        expect(callsBeforeReadyReconnect).toBe(1)

        const idBeforeReadyReconnect = realtimeClientFor(pb).clientId()
        realtimeClientFor(pb).simulateDisconnect()
        await waitFor(
            () => expect(realtimeClientFor(pb).clientId()).not.toBe(idBeforeReadyReconnect),
            { timeout: 10000 }
        )
        await waitForLoadFinish(result)
        await waitFor(
            () => expect(getFullList).toHaveBeenCalledTimes(callsBeforeReadyReconnect + 1),
            { timeout: 10000 }
        )
        getFullList.mockRestore()
        await books.cleanup()
    }, 20000)

    it('resets the session and reloads when the auth record changes, not on a same-record change', async () => {
        const books = createBooksCollection()
        const { result } = renderHook(() => useLiveQuery(q => q.from({ books })))
        await waitForLoadFinish(result)
        await books.waitForSubscription()
        const getFullList = vi.spyOn(pb.collection('books'), 'getFullList')
        getFullList.mockClear()
        try {
            const idBeforeSave = realtimeClientFor(pb).clientId()
            pb.authStore.save(pb.authStore.token, pb.authStore.record)
            await new Promise(resolve => setTimeout(resolve, 200))
            expect(realtimeClientFor(pb).clientId()).toBe(idBeforeSave)
            expect(getFullList).not.toHaveBeenCalled()

            clearAuth()
            await waitFor(() => expect(realtimeClientFor(pb).clientId()).not.toBe(idBeforeSave), {
                timeout: 10000,
            })
            await waitFor(() => expect(getFullList).toHaveBeenCalledTimes(1), { timeout: 10000 })
        } finally {
            await authenticateTestUser()
            await waitFor(() => expect(books.isSubscribed()).toBe(true), { timeout: 10000 })
            await books.cleanup()
            getFullList.mockRestore()
        }
    }, 30000)

    it('an auth record change releases waiting subsets so a remount fetches', async () => {
        const books = createCollection<Schema>(pb)('books', {
            syncMode: 'on-demand',
            subsetGcTime: 5000,
        })
        const mount = () =>
            renderHook(() =>
                useLiveQuery(q =>
                    q.from({ books }).where(({ books }) => eq(books.genre, 'Fiction'))
                )
            )
        const getList = vi.spyOn(pb.collection('books'), 'getList')
        const getFullList = vi.spyOn(pb.collection('books'), 'getFullList')
        const requests = () => getList.mock.calls.length + getFullList.mock.calls.length
        const first = mount()
        let second: ReturnType<typeof mount> | undefined
        try {
            await waitForLoadFinish(first.result)
            await books.waitForSubscription()
            first.unmount()
            const before = requests()

            const record = pb.authStore.record
            if (!record) throw new Error('not authenticated')
            pb.authStore.save(pb.authStore.token, { ...record, id: 'other0000000000' })
            second = mount()
            await waitForLoadFinish(second.result)
            expect(requests()).toBeGreaterThan(before)
        } finally {
            second?.unmount()
            await authenticateTestUser()
            await books.cleanup()
            getList.mockRestore()
            getFullList.mockRestore()
        }
    }, 30000)

    it('an auth change followed at once by disconnectRealtime still reloads under the new auth', async () => {
        const books = createBooksCollection()
        const { result } = renderHook(() => useLiveQuery(q => q.from({ books })))
        await waitForLoadFinish(result)
        await books.waitForSubscription()
        const getFullList = vi.spyOn(pb.collection('books'), 'getFullList')
        getFullList.mockClear()
        try {
            const record = pb.authStore.record
            if (!record) throw new Error('not authenticated')
            pb.authStore.save(pb.authStore.token, { ...record, id: 'other0000000001' })
            disconnectRealtime(pb)
            await waitFor(() => expect(getFullList).toHaveBeenCalledTimes(1), { timeout: 10000 })
            await new Promise(resolve => setTimeout(resolve, 300))
            expect(realtimeClientFor(pb).isConnected()).toBe(false)
        } finally {
            resetRealtime(pb)
            await authenticateTestUser()
            await books.cleanup()
            getFullList.mockRestore()
        }
    }, 30000)

    it('disconnectRealtime keeps the connection closed until resetRealtime, which reloads', async () => {
        const books = createBooksCollection()
        const { result } = renderHook(() => useLiveQuery(q => q.from({ books })))
        await waitForLoadFinish(result)
        await books.waitForSubscription()
        const getFullList = vi.spyOn(pb.collection('books'), 'getFullList')
        getFullList.mockClear()
        try {
            disconnectRealtime(pb)
            expect(realtimeClientFor(pb).isConnected()).toBe(false)
            await new Promise(resolve => setTimeout(resolve, 500))
            expect(realtimeClientFor(pb).isConnected()).toBe(false)
            expect(getFullList).not.toHaveBeenCalled()

            resetRealtime(pb)
            await waitFor(() => expect(realtimeClientFor(pb).isConnected()).toBe(true), {
                timeout: 10000,
            })
            await waitFor(() => expect(getFullList).toHaveBeenCalledTimes(1), { timeout: 10000 })
        } finally {
            resetRealtime(pb)
            await books.cleanup()
            getFullList.mockRestore()
        }
    }, 30000)

    it('resetRealtime reconnects a ready, subscribed collection and triggers one refetch', async () => {
        const books = createBooksCollection()
        const { result } = renderHook(() => useLiveQuery(q => q.from({ books })))
        await waitForLoadFinish(result)
        await books.waitForSubscription()
        expect((books as unknown as { isSubscribed: () => boolean }).isSubscribed()).toBe(true)

        const getFullList = vi.spyOn(pb.collection('books'), 'getFullList')
        getFullList.mockClear()

        const idBeforeReset = realtimeClientFor(pb).clientId()
        resetRealtime(pb)
        await waitFor(() => expect(realtimeClientFor(pb).clientId()).not.toBe(idBeforeReset), {
            timeout: 10000,
        })
        await waitFor(
            () =>
                expect((books as unknown as { isSubscribed: () => boolean }).isSubscribed()).toBe(
                    true
                ),
            { timeout: 10000 }
        )
        await waitFor(() => expect(getFullList).toHaveBeenCalledTimes(1), { timeout: 10000 })

        await books.cleanup()
        getFullList.mockRestore()
    }, 20000)
})
