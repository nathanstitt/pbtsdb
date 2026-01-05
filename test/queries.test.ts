import { renderHook, waitFor } from '@testing-library/react'
import { useLiveQuery } from '@tanstack/react-db'
import { and, eq, gt, gte, lt, lte, or } from '@tanstack/db'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'

import { pb, createTestQueryClient, authenticateTestUser, clearAuth, createBooksCollection, createCollectionFactory, waitForLoadFinish } from './helpers'

describe('Collection - Query Operators', () => {
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

    it('should filter books using eq operator', async () => {
        const booksCollection = createBooksCollection(queryClient, { syncMode: 'eager' })

        // First get all books to find a valid genre
        const allBooks = await pb.collection('books').getList(1, 10)
        expect(allBooks.items.length).toBeGreaterThan(0)
        const testGenre = allBooks.items[0].genre

        const { result } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ books: booksCollection })
                    .where(({ books }) => eq(books.genre, testGenre))
            )
        )

        await waitForLoadFinish(result)
        expect(result.current.data.length).toBeGreaterThan(0)

        // All results should have the filtered genre
        result.current.data.forEach(book => {
            expect(book.genre).toBe(testGenre)
        })
    })

    it('should filter books using gt operator with dates', async () => {
        const booksCollection = createBooksCollection(queryClient, { syncMode: 'eager' })

        // Use a date in the past to ensure we get some results
        const pastDate = new Date('2020-01-01')

        const { result } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ books: booksCollection })
                    .where(({ books }) => gt(books.created, pastDate.toISOString()))
            )
        )

        await waitForLoadFinish(result)
        expect(result.current.data.length).toBeGreaterThan(0)

        // All results should have created date after pastDate
        result.current.data.forEach(book => {
            expect(new Date(book.created).getTime()).toBeGreaterThan(pastDate.getTime())
        })
    })

    it('should filter books using gte operator', async () => {
        const booksCollection = createBooksCollection(queryClient, { syncMode: 'eager' })

        // Get a job's created date to use as threshold
        const allBooks = await pb.collection('books').getList(1, 1, { sort: '-created' })
        expect(allBooks.items.length).toBeGreaterThan(0)
        const thresholdDate = allBooks.items[0].created

        const { result } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ books: booksCollection })
                    .where(({ books }) => gte(books.created, thresholdDate))
            )
        )

        await waitFor(
            () => {
                expect(result.current.isLoading).toBe(false)
                expect(result.current.data.length).toBeGreaterThan(0)
            },
            { timeout: 10000 }
        )

        // All results should have created date >= threshold
        result.current.data.forEach(book => {
            expect(new Date(book.created).getTime()).toBeGreaterThanOrEqual(new Date(thresholdDate).getTime())
        })
    })

    it('should filter books using lt operator', async () => {
        const booksCollection = createBooksCollection(queryClient, { syncMode: 'eager' })

        // Use a future date to ensure we get some results
        const futureDate = new Date('2030-01-01')

        const { result } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ books: booksCollection })
                    .where(({ books }) => lt(books.created, futureDate.toISOString()))
            )
        )

        await waitForLoadFinish(result)
        expect(result.current.data.length).toBeGreaterThan(0)

        // All results should have created date before futureDate
        result.current.data.forEach(book => {
            expect(new Date(book.created).getTime()).toBeLessThan(futureDate.getTime())
        })
    })

    it('should filter books using lte operator', async () => {
        const booksCollection = createBooksCollection(queryClient, { syncMode: 'eager' })

        const futureDate = new Date('2030-01-01')

        const { result } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ books: booksCollection })
                    .where(({ books }) => lte(books.created, futureDate.toISOString()))
            )
        )

        await waitForLoadFinish(result)
        expect(result.current.data.length).toBeGreaterThan(0)

        // All results should have created date <= futureDate
        result.current.data.forEach(book => {
            expect(new Date(book.created).getTime()).toBeLessThanOrEqual(futureDate.getTime())
        })
    })

    it('should filter books using and operator', async () => {
        const booksCollection = createBooksCollection(queryClient)

        // Get test data
        const allBooks = await pb.collection('books').getList(1, 10)
        expect(allBooks.items.length).toBeGreaterThan(0)
        const testGenre = allBooks.items[0].genre
        const pastDate = new Date('2020-01-01')

        const { result } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ books: booksCollection })
                    .where(({ books }) => and(
                        eq(books.genre, testGenre),
                        gt(books.created, pastDate.toISOString())
                    ))
            )
        )

        await waitForLoadFinish(result)

        // All results should match both conditions
        result.current.data.forEach(book => {
            expect(book.genre).toBe(testGenre)
            expect(new Date(book.created).getTime()).toBeGreaterThan(pastDate.getTime())
        })
    })

    it('should filter books using or operator', async () => {
        const booksCollection = createBooksCollection(queryClient)

        // Get two different genres
        const allBooks = await pb.collection('books').getList(1, 20)
        expect(allBooks.items.length).toBeGreaterThan(0)

        // Find two different genre values
        const uniqueGenres = [...new Set(allBooks.items.map(b => b.genre))]
        const genre1 = uniqueGenres[0]
        const genre2 = uniqueGenres.length > 1 ? uniqueGenres[1] : genre1

        const { result } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ books: booksCollection })
                    .where(({ books }) => or(
                        eq(books.genre, genre1),
                        eq(books.genre, genre2)
                    ))
            )
        )

        await waitForLoadFinish(result)
        expect(result.current.data.length).toBeGreaterThan(0)

        // All results should match at least one condition
        result.current.data.forEach(book => {
            expect([genre1, genre2]).toContain(book.genre)
        })
    })

    it('should sort books by created date descending', async () => {
        const booksCollection = createBooksCollection(queryClient, { syncMode: 'eager' })

        const { result } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ books: booksCollection })
                    .orderBy(({ books }) => books.created, 'desc')
            )
        )

        await waitForLoadFinish(result)
        expect(result.current.data.length).toBeGreaterThanOrEqual(1)

        // Verify descending order if we have multiple results
        if (result.current.data.length > 1) {
            const dates = result.current.data.map(j => new Date(j.created).getTime())
            for (let i = 1; i < dates.length; i++) {
                expect(dates[i]).toBeLessThanOrEqual(dates[i - 1])
            }
        }
    })

    it('should support complex nested queries with and/or', async () => {
        const booksCollection = createBooksCollection(queryClient)

        const allBooks = await pb.collection('books').getList(1, 20)
        expect(allBooks.items.length).toBeGreaterThan(0)
        const testGenre = allBooks.items[0].genre
        const pastDate = new Date('2020-01-01')
        const futureDate = new Date('2030-01-01')

        const { result } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ books: booksCollection })
                    .where(({ books }) => and(
                        eq(books.genre, testGenre),
                        or(
                            gt(books.created, pastDate.toISOString()),
                            lt(books.updated, futureDate.toISOString())
                        )
                    ))
            )
        )

        await waitForLoadFinish(result)

        // All results should match the complex condition
        result.current.data.forEach(book => {
            expect(book.genre).toBe(testGenre)
            const meetsOrCondition =
                new Date(book.created).getTime() > pastDate.getTime() ||
                new Date(book.updated).getTime() < futureDate.getTime()
            expect(meetsOrCondition).toBe(true)
        })
    })

    it('should throw error for unsupported operators', async () => {
        const factory = createCollectionFactory(queryClient)

        // This test verifies that unsupported operators are rejected
        // by the query compilation, not by our converter
        // TanStack DB will throw a QueryCompilationError before reaching our code

        expect(() => {
            renderHook(() =>
                useLiveQuery((q) =>
                    q.from({ books: factory.create('books') })
                        // Testing unsupported structure
                        .where(() => ({ op: 'unsupported', field: ['name'], value: 'test' }) as any)
                )
            )
        }).toThrow()
    })
})
