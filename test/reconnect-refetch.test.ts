import { useLiveQuery } from '@tanstack/react-db'
import { renderHook, waitFor } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { realtimeClientFor, resetRealtime, transportFor } from '../src/transport'
import {
    authenticateTestUser,
    clearAuth,
    createAuthorsCollection,
    createBooksCollection,
    pb,
    waitForLoadFinish,
} from './helpers'

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
        getFullList.mockRestore()
        await books.cleanup()
    }, 20000)

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
        expect(getFullList).toHaveBeenCalledTimes(1)

        await books.cleanup()
        getFullList.mockRestore()
    }, 20000)
})
