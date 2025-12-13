import { renderHook, waitFor } from '@testing-library/react'
import { useLiveQuery } from '@tanstack/react-db'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'

import {
    pb,
    createTestQueryClient,
    authenticateTestUser,
    clearAuth,
    getTestSlug,
    getTestAuthorId,
    createCollectionFactory,
    newRecordId,
    waitForLoadFinish,
} from './helpers'
import type { Books } from './schema'

describe('Collection - Mutations', () => {
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

    it('should support insert mutations with automatic PocketBase sync', async () => {
        const factory = createCollectionFactory(queryClient)
        const collection = factory.create('books', {
            omitOnInsert: ['created', 'updated'] as const
        })

        const { result } = renderHook(() => useLiveQuery((q) => q.from({ books: collection })))

        await waitForLoadFinish(result)
        const initialCount = result.current.data.length

        const authorId = await getTestAuthorId()
        const newBook = {
            id: newRecordId(),
            title: `Mutation Insert Test ${Date.now().toString().slice(-8)}`,
            genre: 'Fiction' as const,
            isbn: getTestSlug('ins'),
            author: authorId,
            published_date: '',
            page_count: 0,
        }

        const tx = collection.insert(newBook)

        expect(['pending', 'persisting']).toContain(tx.state)

        await tx.isPersisted.promise

        expect(tx.state).toBe('completed')

        // Verify in PocketBase
        const books = await pb.collection('books').getFullList({ filter: `isbn = "${newBook.isbn}"` })
        expect(books.length).toBeGreaterThan(0)
        expect(books[0].title).toBe(newBook.title)

        // Cleanup
        try {
            await pb.collection('books').delete(books[0].id)
        } catch (_error) {
            // Ignore cleanup errors
        }
    }, 15000)

    it('should support update mutations on existing records', async () => {
        const factory = createCollectionFactory(queryClient)
        const collection = factory.create('books', { syncMode: 'eager' })

        const { result } = renderHook(() => useLiveQuery((q) => q.from({ books: collection })))

        await waitForLoadFinish(result, 10000)
        expect(result.current.data.length).toBeGreaterThan(0)

        // Get an existing book from the collection
        const existingBook = result.current.data[0]
        const originalPageCount = existingBook.page_count
        const updatedPageCount = originalPageCount + 1

        const tx = collection.update(existingBook.id, (draft) => {
            draft.page_count = updatedPageCount
        })

        expect(['pending', 'persisting']).toContain(tx.state)

        await tx.isPersisted.promise

        expect(tx.state).toBe('completed')

        // Verify in PocketBase
        const serverBook = await pb.collection('books').getOne(existingBook.id)
        expect(serverBook.page_count).toBe(updatedPageCount)

        // Restore original page count
        await pb.collection('books').update(existingBook.id, { page_count: originalPageCount })
    }, 15000)

    it('should update liveQuery data when a record is inserted', async () => {
        const factory = createCollectionFactory(queryClient)
        const collection = factory.create('books', {
            syncMode: 'on-demand',
            omitOnInsert: ['created', 'updated'] as const,
        })

        const { result, unmount } = renderHook(() => useLiveQuery((q) => q.from({ books: collection })))

        // For on-demand sync, we need to wait for data to actually load (not just isLoading: false)
        await waitFor(
            () => {
                expect(result.current.isLoading).toBe(false)
                expect(result.current.data.length).toBeGreaterThan(0)
            },
            { timeout: 10000 }
        )

        const authorId = await getTestAuthorId()
        const newBook = {
            id: newRecordId(),
            title: `LiveQuery Update Test ${Date.now().toString().slice(-8)}`,
            genre: 'Fiction' as const,
            isbn: getTestSlug('lqu'),
            author: authorId,
            published_date: '',
            page_count: 0,
        }

        const tx = collection.insert(newBook)
        await tx.isPersisted.promise

        // Verify liveQuery data updated to include the new record
        await waitFor(
            () => {
                const insertedBook = result.current.data.find((b) => b.id === newBook.id)
                expect(insertedBook).toBeDefined()
                expect(insertedBook?.title).toBe(newBook.title)
            },
            { timeout: 5000 }
        )

        unmount()

        const { result: reread  } = renderHook(() => useLiveQuery((q) => q.from({ books: collection })))
        await waitFor(
            () => {
                const insertedBook = reread.current.data.find((b) => b.id === newBook.id)
                expect(insertedBook).toBeDefined()
            }
        )

        // Cleanup
        try {
            await pb.collection('books').delete(newBook.id)
        } catch (_error) {
            // Ignore cleanup errors
        }
    }, 15000)

    it('should handle insert and delete in same batch (optimistic cancellation)', async () => {
        const factory = createCollectionFactory(queryClient)
        const collection = factory.create('books', {
            syncMode: 'eager',
            onInsert: async () => {},
            onUpdate: async () => {},
            onDelete: async () => {},
        })

        const { result } = renderHook(() => useLiveQuery((q) => q.from({ books: collection })))

        await waitForLoadFinish(result)
        const initialCount = result.current.data.length

        const authorId = await getTestAuthorId()
        const newBook: Books = {
            id: newRecordId(),
            title: 'Cancel Test',
            genre: 'Fiction',
            isbn: getTestSlug('cnl'),
            author: authorId,
            published_date: '',
            page_count: 0,
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
        }

        collection.utils.writeBatch(() => {
            collection.insert(newBook)
            collection.delete(newBook.id)
        })

        await waitFor(
            () => {
                expect(result.current.data.length).toBe(initialCount)
            },
            { timeout: 5000 }
        )

        expect(result.current.data.find((b) => b.id === newBook.id)).toBeUndefined()
    }, 15000)
})
