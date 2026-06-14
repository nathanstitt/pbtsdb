import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import type { QueryClient } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
    authenticateTestUser,
    clearAuth,
    createCollectionFactory,
    createTestLogger,
    createTestQueryClient,
    pb,
    resetLogger,
    setLogger,
    waitForLoadFinish,
} from './helpers'

describe('Collection - Relations', () => {
    let queryClient: QueryClient
    const testLogger = createTestLogger()

    beforeAll(async () => {
        await authenticateTestUser()
        setLogger(testLogger)
    })

    afterAll(() => {
        clearAuth()
        resetLogger()
    })

    beforeEach(() => {
        queryClient = createTestQueryClient()
        testLogger.clear()
    })

    afterEach(() => {
        queryClient.clear()
    })

    it('should join books with authors using manual join pattern', async () => {
        const factory = createCollectionFactory(queryClient)

        // Create collections with relations config
        const authorsCollection = factory.create('authors', { syncMode: 'eager' })
        const booksCollection = factory.create('books', { syncMode: 'eager' })

        const { result } = renderHook(() =>
            useLiveQuery(q =>
                q
                    .from({ book: booksCollection })
                    .join(
                        { author: authorsCollection },
                        ({ book, author }) => eq(book.author, author.id),
                        'left'
                    )
                    .select(({ book, author }) => ({
                        ...book,
                        expand: {
                            author: author ? { ...author } : undefined,
                        },
                    }))
            )
        )

        await waitForLoadFinish(result, 10000)
        expect(result.current.data).toBeDefined()
        expect(result.current.data.length).toBeGreaterThanOrEqual(1)

        // Verify the joined data structure
        const bookWithAuthor = result.current.data[0]

        // Original book fields should exist
        expect(bookWithAuthor.id).toBeDefined()
        expect(bookWithAuthor.title).toBeDefined()
        expect(bookWithAuthor.author).toBeDefined() // FK ID still exists

        // With on-demand sync mode and manual joins, the expand structure is created client-side
        // by the select() function. The expand property should exist with author data from the join.
        const authorData = bookWithAuthor.expand.author
        expect(authorData?.id).toBeDefined()
        if (!authorData) throw new Error('Expected author expand to be defined')

        expect(authorData.name).toBeDefined()

        // The author ID should match the FK
        expect(authorData.id).toBe(bookWithAuthor.author)

        // Type inference test - these should be typed correctly
        const authorId: string = authorData.id
        const authorName: string = authorData.name
        expect(authorId).toBeTypeOf('string')
        expect(authorName).toBeTypeOf('string')
    }, 15000)

    it('should auto-expand relations when configured with expand option', async () => {
        const factory = createCollectionFactory(queryClient)
        const authorsCollection = factory.create('authors', { syncMode: 'eager' })
        const booksCollection = factory.create('books', {
            syncMode: 'eager',
            expand: {
                author: authorsCollection,
            },
        })

        const { result } = renderHook(() => useLiveQuery(q => q.from({ books: booksCollection })))

        await waitForLoadFinish(result)
        expect(result.current.data).toBeDefined()
        expect(result.current.data.length).toBeGreaterThan(0)

        const firstBook = result.current.data[0]

        // Type checking: These should compile without errors
        expect(firstBook.expand).toBeDefined()

        const authorName: string | undefined = firstBook.expand?.author?.name
        expect(authorName).toBeTypeOf('string')
    })

    it('should filter on relation fields with auto-expand', async () => {
        const factory = createCollectionFactory(queryClient)
        const authorsCollection = factory.create('authors', { syncMode: 'eager' })
        const booksCollection = factory.create('books', {
            syncMode: 'eager',
            expand: {
                author: authorsCollection,
            },
        })

        // Get an author ID to filter by
        const allBooks = await pb.collection('books').getList(1, 10, {
            expand: 'author',
        })
        expect(allBooks.items.length).toBeGreaterThan(0)

        // Find a book with an author
        const bookWithAuthor = allBooks.items.find(b => b.author)
        if (!bookWithAuthor) {
            // Skip if no books have authors
            return
        }

        const testAuthorId = bookWithAuthor.author

        const { result } = renderHook(() =>
            useLiveQuery(q =>
                q
                    .from({ books: booksCollection })
                    .where(({ books }) => eq(books.author, testAuthorId))
            )
        )

        await waitForLoadFinish(result)
        expect(result.current.data).toBeDefined()
        expect(result.current.data.length).toBeGreaterThan(0)

        // All results should have the same author
        result.current.data.forEach(book => {
            expect(book.author).toBe(testAuthorId)
        })
    })

    it('should warn when eager expand target store is not ready', async () => {
        const factory = createCollectionFactory(queryClient)
        const authorsCollection = factory.create('authors', { syncMode: 'eager' })
        const booksCollection = factory.create('books', {
            syncMode: 'eager',
            expand: {
                author: authorsCollection,
            },
        })

        const { result } = renderHook(() => useLiveQuery(q => q.from({ books: booksCollection })))

        await waitForLoadFinish(result)
        expect(result.current.data).toBeDefined()
        expect(result.current.data.length).toBeGreaterThan(0)

        // When an eager store is used as an expand target but isn't ready yet,
        // we expect a warning to be logged (expand data won't be upserted)
        const notReadyWarnings = testLogger.messages.warn.filter(
            w => w.msg.includes('not syncing') && w.msg.includes('not yet ready')
        )
        expect(notReadyWarnings.length).toBeGreaterThan(0)

        // The expand data should still be present on the record from PocketBase
        const firstBook = result.current.data[0]
        expect(firstBook.expand).toBeDefined()
        expect(firstBook.expand?.author).toBeDefined()
    })

    it('should allow chaining where() and orderBy() with auto-expand', async () => {
        const factory = createCollectionFactory(queryClient)
        const authorsCollection = factory.create('authors', { syncMode: 'eager' })
        const booksCollection = factory.create('books', {
            expand: {
                author: authorsCollection,
            },
        })

        // Get test data
        const allBooks = await pb.collection('books').getList(1, 10)
        const testGenre = allBooks.items[0].genre

        const { result } = renderHook(() =>
            useLiveQuery(q =>
                q
                    .from({ books: booksCollection })
                    .where(({ books }) => eq(books.genre, testGenre))
                    .orderBy(({ books }) => books.title)
            )
        )

        await waitForLoadFinish(result)
        expect(result.current.data).toBeDefined()
        expect(result.current.data.length).toBeGreaterThan(0)

        // Warning is expected when eager target store isn't ready
        const notReadyWarnings = testLogger.messages.warn.filter(
            w => w.msg.includes('not syncing') && w.msg.includes('not yet ready')
        )
        expect(notReadyWarnings.length).toBeGreaterThan(0)

        // Verify expand works with filtering
        const firstBook = result.current.data[0]
        expect(firstBook.genre).toBe(testGenre)
        expect(firstBook.expand?.author).toBeDefined()

        // Verify ordering
        for (let i = 1; i < result.current.data.length; i++) {
            expect(result.current.data[i].title >= result.current.data[i - 1].title).toBe(true)
        }
    })
})
