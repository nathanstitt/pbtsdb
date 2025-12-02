import { renderHook, waitFor } from '@testing-library/react'
import { useLiveQuery } from '@tanstack/react-db'
import { eq } from '@tanstack/db'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'

import { pb, createTestQueryClient, authenticateTestUser, clearAuth, createBooksCollection } from './helpers'

describe('Server-Side Filtering (on-demand mode)', () => {
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
        vi.restoreAllMocks()
    })

    it('should pass filter to PocketBase getList when .where() is present', async () => {
        const booksCollection = createBooksCollection(queryClient, { syncMode: 'on-demand' })

        // Get a valid genre to filter by
        const allBooks = await pb.collection('books').getList(1, 10)
        expect(allBooks.items.length).toBeGreaterThan(0)
        const testGenre = allBooks.items[0].genre

        // Spy on PocketBase getList to verify it's called with filter options
        const getListSpy = vi.spyOn(pb.collection('books'), 'getList')

        const { result } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ books: booksCollection })
                    .where(({ books }) => eq(books.genre, testGenre))
            )
        )

        // Wait for data to be populated (not just isLoading to be false)
        await waitFor(
            () => {
                expect(result.current.data.length).toBeGreaterThan(0)
            },
            { timeout: 10000 }
        )

        // Verify getList was called with filter parameter (server-side filtering)
        expect(getListSpy).toHaveBeenCalled()

        // Find the call with filter
        const calls = getListSpy.mock.calls
        const callWithFilter = calls.find(call => {
            const options = call[2]
            return options && typeof options === 'object' && 'filter' in options && options.filter
        })

        expect(callWithFilter).toBeDefined()

        // Verify the filter parameter was passed correctly
        const [page, perPage, options] = callWithFilter!
        expect(page).toBe(1)
        expect(perPage).toBe(500)  // Default limit
        expect(options?.filter).toBe(`genre = "${testGenre}"`)

        // All returned records must match the filter
        result.current.data.forEach(book => {
            expect(book.genre).toBe(testGenre)
        })
    }, 15000)

    it('should pass limit to PocketBase getList when .limit() is present', async () => {
        const booksCollection = createBooksCollection(queryClient, { syncMode: 'on-demand' })

        // Spy on PocketBase getList
        const getListSpy = vi.spyOn(pb.collection('books'), 'getList')

        const { result } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ books: booksCollection })
                    .orderBy(({ books }) => books.id)  // Required by TanStack DB when using limit
                    .limit(2)
            )
        )

        // Wait for data to be populated
        await waitFor(
            () => {
                expect(result.current.data.length).toBeGreaterThan(0)
            },
            { timeout: 10000 }
        )

        // Verify getList was called
        expect(getListSpy).toHaveBeenCalled()

        // Find the call with limit=2 (perPage=2)
        const calls = getListSpy.mock.calls
        const callWithLimit = calls.find(call => call[1] === 2)

        expect(callWithLimit).toBeDefined()

        // Verify the limit parameter was passed correctly
        const [page, perPage] = callWithLimit!
        expect(page).toBe(1)
        expect(perPage).toBe(2)  // limit passed as perPage

        // Verify results respect the limit
        expect(result.current.data.length).toBeLessThanOrEqual(2)
    }, 15000)

    it('should verify server-side filtered results match expected count', async () => {
        const booksCollection = createBooksCollection(queryClient, { syncMode: 'on-demand' })

        // First get total count and genre distribution
        const allBooks = await pb.collection('books').getFullList()
        const totalCount = allBooks.length
        expect(totalCount).toBeGreaterThan(1)

        // Get a genre that doesn't match all books
        const genres = [...new Set(allBooks.map(b => b.genre))]
        expect(genres.length).toBeGreaterThan(1) // Ensure we have multiple genres
        const testGenre = genres[0]
        const expectedCount = allBooks.filter(b => b.genre === testGenre).length

        // Query with filter
        const { result } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ books: booksCollection })
                    .where(({ books }) => eq(books.genre, testGenre))
            )
        )

        // Wait for data to be populated
        await waitFor(
            () => {
                expect(result.current.data.length).toBeGreaterThan(0)
            },
            { timeout: 10000 }
        )

        // Verify all returned records match the filter
        result.current.data.forEach(book => {
            expect(book.genre).toBe(testGenre)
        })

        // Verify count matches expected (proving server returned correct data)
        expect(result.current.data.length).toBe(expectedCount)
    }, 15000)

    // Note: TanStack DB does NOT pass orderBy to loadSubsetOptions - sorting is always client-side.
    // This test verifies that client-side sorting works correctly.
    it('should sort results client-side when .orderBy() is present', async () => {
        const booksCollection = createBooksCollection(queryClient, { syncMode: 'on-demand' })

        // Use a filter to trigger on-demand fetch
        const allBooks = await pb.collection('books').getList(1, 10)
        expect(allBooks.items.length).toBeGreaterThan(0)
        const testGenre = allBooks.items[0].genre

        const { result } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ books: booksCollection })
                    .where(({ books }) => eq(books.genre, testGenre))
                    .orderBy(({ books }) => books.created, 'desc')
            )
        )

        // Wait for data to be populated
        await waitFor(
            () => {
                expect(result.current.data.length).toBeGreaterThan(0)
            },
            { timeout: 10000 }
        )

        // Check that results are sorted descending by created date (client-side sorting)
        if (result.current.data.length > 1) {
            const dates = result.current.data.map(b => new Date(b.created).getTime())
            for (let i = 1; i < dates.length; i++) {
                // Each date must be <= previous date (descending order)
                expect(dates[i]).toBeLessThanOrEqual(dates[i - 1])
            }
        }
    }, 15000)
})
