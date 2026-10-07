import { useLiveQuery } from '@tanstack/react-db'
import type { QueryClient } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { realtimeClientFor, transportFor } from '../src/transport'
import {
    authenticateTestUser,
    clearAuth,
    createAuthorsCollection,
    createBooksCollection,
    createTestQueryClient,
    pb,
    waitForLoadFinish,
} from './helpers'

describe('reconnect refetch lifecycle', () => {
    let queryClient: QueryClient

    beforeAll(async () => {
        await authenticateTestUser()
    })

    afterAll(() => {
        clearAuth()
    })

    beforeEach(() => {
        queryClient = createTestQueryClient()
    })

    afterEach(() => {
        queryClient.clear()
    })

    it('registers its reconnect listener while syncing and removes it on cleanup', async () => {
        const reconnectListenerCount = () => transportFor(pb).reconnectListenerCount()
        const baseline = reconnectListenerCount()

        const books = createBooksCollection(queryClient)
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

        const books = createBooksCollection(queryClient)
        const authors = createAuthorsCollection(queryClient)

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
        const books = createBooksCollection(queryClient)
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
        // A second collection keeps the shared connection open and reconnecting,
        // while `books` here is never subscribed to, so it stays "not ready".
        const authors = createAuthorsCollection(queryClient)
        const authorsHook = renderHook(() => useLiveQuery(q => q.from({ authors })))
        await waitForLoadFinish(authorsHook.result)
        await authors.waitForSubscription()

        const books = createBooksCollection(queryClient)
        const getFullList = vi.spyOn(pb.collection('books'), 'getFullList')
        getFullList.mockClear()

        realtimeClientFor(pb).simulateDisconnect()
        await new Promise(resolve => setTimeout(resolve, 1000))
        expect(getFullList).not.toHaveBeenCalled()

        getFullList.mockRestore()
        await books.cleanup()
        await authors.cleanup()
    }, 20000)
})
