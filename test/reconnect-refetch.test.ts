import { useLiveQuery } from '@tanstack/react-db'
import type { QueryClient } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { transportFor } from '../src/transport'
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
})
