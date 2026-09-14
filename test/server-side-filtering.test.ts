import { eq, inArray } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import type { QueryClient } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import PocketBase from 'pocketbase'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createCollection } from '../src'
import {
    authenticateTestUser,
    clearAuth,
    createBooksCollection,
    createTestQueryClient,
    getTestSlug,
    pb,
} from './helpers'
import type { Schema } from './schema'

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

    // Runs on a client left at SDK defaults: auto-cancellation keys on method
    // and path, and the shared test client turns it off.
    it('fetches an id subset too long for one PocketBase filter in several requests', async () => {
        const slug = getTestSlug('bulk')
        const ids: string[] = []
        try {
            for (let i = 0; i < 150; i++) {
                const tag = await pb
                    .collection('tags')
                    .create({ name: `${slug}-${i}`, color: '#336699' })
                ids.push(tag.id)
            }
            const client = new PocketBase(pb.baseURL)
            client.authStore.save(pb.authStore.token, pb.authStore.record)
            const tags = createCollection<Schema>(client, queryClient)('tags', {
                syncMode: 'on-demand',
            })
            const getFullListSpy = vi.spyOn(client.collection('tags'), 'getFullList')
            const { result } = renderHook(() =>
                useLiveQuery(q => q.from({ tags }).where(({ tags }) => inArray(tags.id, ids)))
            )
            await waitFor(
                () => {
                    expect(result.current.data).toHaveLength(ids.length)
                },
                { timeout: 10000 }
            )
            const filters = getFullListSpy.mock.calls.map(
                call => (call[0] as { filter?: string } | undefined)?.filter ?? ''
            )
            expect(filters.length).toBeGreaterThan(1)
            for (const filter of filters) expect(filter.length).toBeLessThanOrEqual(3500)
        } finally {
            await Promise.all(ids.map(id => pb.collection('tags').delete(id)))
        }
    }, 20000)

    it('should pass filter to PocketBase getFullList when .where() is present', async () => {
        const booksCollection = createBooksCollection(queryClient, { syncMode: 'on-demand' })

        // Get a valid genre to filter by
        const allBooks = await pb.collection('books').getFullList()
        expect(allBooks.length).toBeGreaterThan(0)
        const testGenre = allBooks[0].genre

        // Spy on PocketBase getFullList to verify it's called with filter options
        const getFullListSpy = vi.spyOn(pb.collection('books'), 'getFullList')

        const { result } = renderHook(() =>
            useLiveQuery(q =>
                q.from({ books: booksCollection }).where(({ books }) => eq(books.genre, testGenre))
            )
        )

        // Wait for data to be populated (not just isLoading to be false)
        await waitFor(
            () => {
                expect(result.current.data.length).toBeGreaterThan(0)
            },
            { timeout: 10000 }
        )

        // Verify getFullList was called with filter parameter (server-side filtering)
        expect(getFullListSpy).toHaveBeenCalled()

        // Find the call with filter
        const calls = getFullListSpy.mock.calls
        const callWithFilter = calls.find(call => {
            const options = call[0] as { filter?: string } | undefined
            return options && typeof options === 'object' && 'filter' in options && options.filter
        })

        expect(callWithFilter).toBeDefined()
        if (!callWithFilter) throw new Error('expected a getFullList call with a filter')

        // Verify the filter parameter was passed correctly
        const [options] = callWithFilter
        expect((options as { filter?: string })?.filter).toBe(`genre = "${testGenre}"`)

        // All returned records must match the filter
        result.current.data.forEach(book => {
            expect(book.genre).toBe(testGenre)
        })
    }, 15000)

    // Note: TanStack DB does NOT pass limit to loadSubsetOptions - limiting is applied client-side.
    // This test verifies that client-side limiting works correctly.
    it('should apply limit client-side when .limit() is present', async () => {
        const booksCollection = createBooksCollection(queryClient, { syncMode: 'on-demand' })

        const { result } = renderHook(() =>
            useLiveQuery(q =>
                q
                    .from({ books: booksCollection })
                    .orderBy(({ books }) => books.id) // Required by TanStack DB when using limit
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

        // Verify results respect the limit (client-side limiting)
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
            useLiveQuery(q =>
                q.from({ books: booksCollection }).where(({ books }) => eq(books.genre, testGenre))
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
        const allBooks = await pb.collection('books').getFullList()
        expect(allBooks.length).toBeGreaterThan(0)
        const testGenre = allBooks[0].genre

        const { result } = renderHook(() =>
            useLiveQuery(q =>
                q
                    .from({ books: booksCollection })
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
