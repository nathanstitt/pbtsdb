import { renderHook, waitFor } from '@testing-library/react'
import { useLiveQuery } from '@tanstack/react-db'
import { eq } from '@tanstack/db'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'

import {
    pb,
    createTestQueryClient,
    authenticateTestUser,
    clearAuth,
    createBooksCollection,
    waitForLoadFinish,
} from './helpers'

describe('Collection - Basic Operations', () => {
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

    it('should fetch books with simple filter using pocketbase api', async () => {
        const result = await pb.collection('books').getList(1, 1)
        expect(result).toBeDefined()
        expect(Array.isArray(result.items)).toBe(true)
        expect(result.items.length).toBeGreaterThanOrEqual(1)
    }, 10000)

    it('should fetch book by isbn using tanstack db collection', async () => {
        const booksCollection = createBooksCollection(queryClient, { syncMode: 'eager' })

        const { result, unmount } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ books: booksCollection })
            )
        )

        await waitForLoadFinish(result)
        expect(result.current.data).toBeDefined()
        expect(result.current.data.length).toBeGreaterThanOrEqual(1)
        const book = result.current.data[0]
        const bookTitle: string = book.title
        expect(bookTitle).toBeTypeOf('string')

        unmount()
    })

    it('should fetch a single book using findOne with where clause', async () => {
        const booksCollection = createBooksCollection(queryClient)

        // First, get all books to find one we can query
        const { result: listResult, unmount: unmountList } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ books: booksCollection })
            )
        )

        await waitForLoadFinish(listResult)
        expect(listResult.current.data.length).toBeGreaterThan(0)

        const targetBook = listResult.current.data[0]
        const targetIsbn = targetBook.isbn

        // Now use findOne to fetch the same book by ISBN
        const { result: findOneResult, unmount: unmountFindOne } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ books: booksCollection })
                    .where(({ books }) => eq(books.isbn, targetIsbn))
                    .findOne()
            )
        )

        await waitForLoadFinish(findOneResult)

        // Verify findOne returns a single object, not an array
        expect(findOneResult.current.data).not.toBeInstanceOf(Array)
        expect(findOneResult.current.data?.id).toBe(targetBook.id)
        expect(findOneResult.current.data?.isbn).toBe(targetIsbn)
        expect(findOneResult.current.data?.title).toBe(targetBook.title)

        unmountFindOne()
        unmountList()
    }, 15000)

    it('should return undefined when findOne matches no records', async () => {
        const booksCollection = createBooksCollection(queryClient)

        // Query for a book with an ISBN that doesn't exist
        const nonExistentIsbn = `nonexistent-${Date.now()}`

        const { result, unmount } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ books: booksCollection })
                    .where(({ books }) => eq(books.isbn, nonExistentIsbn))
                    .findOne()
            )
        )

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        })

        // Verify findOne returns undefined when no match
        expect(result.current.data).toBeUndefined()

        unmount()
    }, 15000)

})
