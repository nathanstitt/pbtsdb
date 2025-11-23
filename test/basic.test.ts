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
    createCollectionFactory,
    getTestAuthorId,
    getTestSlug
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
        const booksCollection = createBooksCollection(queryClient)

        const { result } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ books: booksCollection })
            )
        )

        // Wait for the collection to load and have data
        await waitFor(
            () => {
                expect(result.current.isLoading).toBe(false)
            },
            { timeout: 5000 }
        )

        expect(result.current.isLoading).toBe(false)
        expect(result.current.data).toBeDefined()
        expect(result.current.data.length).toBeGreaterThanOrEqual(1)
        const book = result.current.data[0]
        const bookTitle: string = book.title
        expect(bookTitle).toBeTypeOf('string')
    })

    it('should accept relations config for type safety', async () => {
        const factory = createCollectionFactory(queryClient)

        // Create collections with relations config
        const authorsCollection = factory.create('authors')
        const booksCollection = factory.create('books', {
            relations: {
                author: authorsCollection  // Type-checked field name
            }
        })

        // Verify collections are created successfully
        expect(booksCollection).toBeDefined()
        expect(authorsCollection).toBeDefined()

        // Note: Actual join logic would be in useLiveQuery as shown in JSDoc example
        // This test validates that the API accepts relations configuration
    })

    it('should fetch a single book using findOne with where clause', async () => {
        const booksCollection = createBooksCollection(queryClient)

        // First, get all books to find one we can query
        const { result: listResult } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ books: booksCollection })
            )
        )

        // Wait for initial data load
        await waitFor(
            () => {
                expect(listResult.current.isLoading).toBe(false)
                expect(listResult.current.data.length).toBeGreaterThan(0)
            },
            { timeout: 5000 }
        )

        const targetBook = listResult.current.data[0]
        const targetIsbn = targetBook.isbn

        // Now use findOne to fetch the same book by ISBN
        const { result: findOneResult } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ books: booksCollection })
                    .where(({ books }) => eq(books.isbn, targetIsbn))
                    .findOne()
            )
        )

        // Wait for findOne query to complete
        await waitFor(
            () => {
                expect(findOneResult.current.isLoading).toBe(false)
            },
            { timeout: 5000 }
        )

        // Verify findOne returns a single object, not an array
        expect(findOneResult.current.data).toBeDefined()
        expect(findOneResult.current.data).not.toBeInstanceOf(Array)
        expect(findOneResult.current.data?.id).toBe(targetBook.id)
        expect(findOneResult.current.data?.isbn).toBe(targetIsbn)
        expect(findOneResult.current.data?.title).toBe(targetBook.title)
    }, 15000)

    it('should return undefined when findOne matches no records', async () => {
        const booksCollection = createBooksCollection(queryClient)

        // Query for a book with an ISBN that doesn't exist
        const nonExistentIsbn = `nonexistent-${Date.now()}`

        const { result } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ books: booksCollection })
                    .where(({ books }) => eq(books.isbn, nonExistentIsbn))
                    .findOne()
            )
        )

        // Wait for query to complete
        await waitFor(
            () => {
                expect(result.current.isLoading).toBe(false)
            },
            { timeout: 5000 }
        )

        // Verify findOne returns undefined when no match
        expect(result.current.data).toBeUndefined()
    }, 15000)

    it('should fetch a single book using findOne by record ID', async () => {
        const booksCollection = createBooksCollection(queryClient)

        // Create a test book
        const authorId = await getTestAuthorId()
        const testBook = await pb.collection('books').create({
            title: `FindOne Test ${Date.now().toString().slice(-8)}`,
            genre: 'Fiction',
            isbn: getTestSlug('fnd'),
            author: authorId
        })

        // Use findOne to fetch the book by ID
        const { result } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ books: booksCollection })
                    .where(({ books }) => eq(books.id, testBook.id))
                    .findOne()
            )
        )

        // Wait for query to complete
        await waitFor(
            () => {
                expect(result.current.isLoading).toBe(false)
                expect(result.current.data).toBeDefined()
            },
            { timeout: 5000 }
        )

        // Verify findOne returns the correct single record
        expect(result.current.data).toBeDefined()
        expect(result.current.data).not.toBeInstanceOf(Array)
        expect(result.current.data?.id).toBe(testBook.id)
        expect(result.current.data?.title).toBe(testBook.title)
        expect(result.current.data?.isbn).toBe(testBook.isbn)

        // Cleanup
        try {
            await pb.collection('books').delete(testBook.id)
        } catch (_error) {
            // Ignore cleanup errors
        }
    }, 15000)
})
