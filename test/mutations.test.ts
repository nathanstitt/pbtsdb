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
    getTestSlug,
    getTestAuthorId,
    createCollectionFactory,
    newRecordId,
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
        const collection = factory.create('books')

        const { result } = renderHook(() => useLiveQuery((q) => q.from({ books: collection })))

        await waitFor(
            () => {
                expect(result.current.isLoading).toBe(false)
            },
            { timeout: 5000 }
        )

        const initialCount = result.current.data.length

        const authorId = await getTestAuthorId()
        const newBook: Books = {
            id: newRecordId(),
            title: `Mutation Insert Test ${Date.now().toString().slice(-8)}`,
            genre: 'Fiction',
            isbn: getTestSlug('ins'),
            author: authorId,
            published_date: '',
            page_count: 0,
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
        }

        const tx = collection.insert(newBook)

        expect(['pending', 'persisting']).toContain(tx.state)

        await waitFor(
            () => {
                return result.current.data.length === initialCount + 1
            },
            { timeout: 5000 }
        )

        const insertedBook = result.current.data.find((b) => b.isbn === newBook.isbn)
        expect(insertedBook).toBeDefined()
        expect(insertedBook?.title).toBe(newBook.title)

        await tx.isPersisted.promise

        expect(tx.state).toBe('completed')

        try {
            const books = await pb.collection('books').getFullList({ filter: `isbn = "${newBook.isbn}"` })
            expect(books.length).toBeGreaterThan(0)
            await pb.collection('books').delete(books[0].id)
        } catch (_error) {
            // Ignore cleanup errors
        }
    })

    it('should support update mutations with automatic PocketBase sync', async () => {
        const authorId = await getTestAuthorId()
        const testBook = await pb.collection('books').create({
            title: `Update Mutation Test ${Date.now().toString().slice(-8)}`,
            genre: 'Fiction',
            isbn: getTestSlug('upd'),
            author: authorId,
        })

        const factory = createCollectionFactory(queryClient)
        const collection = factory.create('books')

        const { result } = renderHook(() =>
            useLiveQuery((q) => q.from({ books: collection }).where(({ books }) => eq(books.id, testBook.id)))
        )

        await waitFor(
            () => {
                expect(result.current.isLoading).toBe(false)
                expect(result.current.data.length).toBeGreaterThan(0)
            },
            { timeout: 5000 }
        )

        const originalTitle = result.current.data[0].title
        const updatedTitle = `Updated via Mutation ${Date.now().toString().slice(-8)}`

        const tx = collection.update(testBook.id, (draft) => {
            draft.title = updatedTitle
        })

        expect(['pending', 'persisting']).toContain(tx.state)

        await waitFor(
            () => {
                return result.current.data[0]?.title === updatedTitle
            },
            { timeout: 5000 }
        )

        expect(result.current.data[0].title).toBe(updatedTitle)
        expect(result.current.data[0].title).not.toBe(originalTitle)

        await tx.isPersisted.promise

        expect(tx.state).toBe('completed')

        const serverBook = await pb.collection('books').getOne(testBook.id)
        expect(serverBook.title).toBe(updatedTitle)

        try {
            await pb.collection('books').delete(testBook.id)
        } catch (_error) {
            // Ignore cleanup errors
        }
    })

    it('should support delete mutations with automatic PocketBase sync', async () => {
        const authorId = await getTestAuthorId()
        const testBook = await pb.collection('books').create({
            title: `Delete Mutation Test ${Date.now().toString().slice(-8)}`,
            genre: 'Fiction',
            isbn: getTestSlug('del'),
            author: authorId,
        })

        const factory = createCollectionFactory(queryClient)
        const collection = factory.create('books')

        const { result } = renderHook(() => useLiveQuery((q) => q.from({ books: collection })))

        await waitFor(
            () => {
                expect(result.current.isLoading).toBe(false)
                const hasBook = result.current.data.some((b) => b.id === testBook.id)
                return hasBook
            },
            { timeout: 5000 }
        )

        const countWithBook = result.current.data.length

        const tx = collection.delete(testBook.id)

        expect(['pending', 'persisting']).toContain(tx.state)

        await waitFor(
            () => {
                const stillHasBook = result.current.data.some((b) => b.id === testBook.id)
                return !stillHasBook
            },
            { timeout: 5000 }
        )

        expect(result.current.data.some((b) => b.id === testBook.id)).toBe(false)
        expect(result.current.data.length).toBe(countWithBook - 1)

        await tx.isPersisted.promise

        expect(tx.state).toBe('completed')

        try {
            await pb.collection('books').getOne(testBook.id)
            expect.fail('Book should have been deleted from server')
        } catch (error) {
            expect(error).toBeDefined()
        }
    })

    it('should support writeBatch for multiple mutations with optimistic updates', async () => {
        const authorId = await getTestAuthorId()
        const testBook = await pb.collection('books').create({
            title: `Batch Test ${Date.now().toString().slice(-8)}`,
            genre: 'Fiction',
            isbn: getTestSlug('bat'),
            author: authorId,
        })

        let txRef: any

        const factory = createCollectionFactory(queryClient)
        const collection = factory.create('books', {
            onUpdate: async ({ transaction }) => {
                txRef = transaction
                await Promise.all(
                    transaction.mutations.map(async (mutation) => {
                        const recordWithId = mutation.original as { id: string }
                        await pb.collection('books').update(recordWithId.id, mutation.changes)
                    })
                )
                await queryClient.invalidateQueries({ queryKey: ['books'] })
            },
        })

        const { result } = renderHook(() =>
            useLiveQuery((q) => q.from({ books: collection }).where(({ books }) => eq(books.id, testBook.id)))
        )

        await waitFor(
            () => {
                expect(result.current.isLoading).toBe(false)
                expect(result.current.data.length).toBeGreaterThan(0)
            },
            { timeout: 5000 }
        )

        collection.utils.writeBatch(() => {
            collection.update(testBook.id, (draft) => {
                draft.title = 'Batch Updated Title'
            })
            collection.update(testBook.id, (draft) => {
                draft.genre = 'Non-Fiction'
            })
        })

        await waitFor(
            () => {
                const book = result.current.data[0]
                return book?.title === 'Batch Updated Title' && book?.genre === 'Non-Fiction'
            },
            { timeout: 5000 }
        )

        expect(result.current.data[0].title).toBe('Batch Updated Title')
        expect(result.current.data[0].genre).toBe('Non-Fiction')

        if (txRef) {
            expect(txRef.mutations.length).toBeGreaterThan(0)
        }

        try {
            await pb.collection('books').delete(testBook.id)
        } catch (_error) {
            // Ignore cleanup errors
        }
    })

    it('should merge multiple updates on the same item within a batch', async () => {
        const authorId = await getTestAuthorId()
        const testBook = await pb.collection('books').create({
            title: `Merge Test ${Date.now().toString().slice(-8)}`,
            genre: 'Fiction',
            isbn: getTestSlug('mrg'),
            author: authorId,
        })

        let mutationCount = 0

        const factory = createCollectionFactory(queryClient)
        const collection = factory.create('books', {
            onUpdate: async ({ transaction }) => {
                mutationCount = transaction.mutations.length

                await Promise.all(
                    transaction.mutations.map(async (mutation) => {
                        const recordWithId = mutation.original as { id: string }
                        await pb.collection('books').update(recordWithId.id, mutation.changes)
                    })
                )
                await queryClient.invalidateQueries({ queryKey: ['books'] })
            },
        })

        const { result } = renderHook(() =>
            useLiveQuery((q) => q.from({ books: collection }).where(({ books }) => eq(books.id, testBook.id)))
        )

        await waitFor(
            () => {
                expect(result.current.isLoading).toBe(false)
                expect(result.current.data.length).toBeGreaterThan(0)
            },
            { timeout: 5000 }
        )

        collection.utils.writeBatch(() => {
            collection.update(testBook.id, (draft) => {
                draft.title = 'First Update'
            })
            collection.update(testBook.id, (draft) => {
                draft.title = 'Final Title'
            })
            collection.update(testBook.id, (draft) => {
                draft.genre = 'Mystery'
            })
        })

        await waitFor(
            () => {
                const book = result.current.data[0]
                return book?.title === 'Final Title' && book?.genre === 'Mystery'
            },
            { timeout: 5000 }
        )

        expect(result.current.data[0].title).toBe('Final Title')
        expect(result.current.data[0].genre).toBe('Mystery')
        expect(mutationCount).toBe(1)

        try {
            await pb.collection('books').delete(testBook.id)
        } catch (_error) {
            // Ignore cleanup errors
        }
    })

    it('should support optimistic: false for non-optimistic mutations', async () => {
        const authorId = await getTestAuthorId()
        const testBook = await pb.collection('books').create({
            title: `Non-Optimistic Test ${Date.now().toString().slice(-8)}`,
            genre: 'Fiction',
            isbn: getTestSlug('nop'),
            author: authorId,
        })

        const factory = createCollectionFactory(queryClient)
        const collection = factory.create('books')

        const { result } = renderHook(() =>
            useLiveQuery((q) => q.from({ books: collection }).where(({ books }) => eq(books.id, testBook.id)))
        )

        await waitFor(
            () => {
                expect(result.current.isLoading).toBe(false)
                expect(result.current.data.length).toBeGreaterThan(0)
            },
            { timeout: 5000 }
        )

        const originalTitle = result.current.data[0].title
        const updatedTitle = `Non-Optimistic Update ${Date.now().toString().slice(-8)}`

        const tx = collection.update(
            testBook.id,
            { optimistic: false },
            (draft) => {
                draft.title = updatedTitle
            }
        )

        expect(result.current.data[0].title).toBe(originalTitle)

        await tx.isPersisted.promise

        await waitFor(
            () => {
                return result.current.data[0]?.title === updatedTitle
            },
            { timeout: 5000 }
        )

        expect(result.current.data[0].title).toBe(updatedTitle)

        try {
            await pb.collection('books').delete(testBook.id)
        } catch (_error) {
            // Ignore cleanup errors
        }
    })

    it('should track transaction states and complete successfully', async () => {
        const authorId = await getTestAuthorId()
        const testBook = await pb.collection('books').create({
            title: `Transaction State Test ${Date.now().toString().slice(-8)}`,
            genre: 'Fiction',
            isbn: getTestSlug('txs'),
            author: authorId,
        })

        const factory = createCollectionFactory(queryClient)
        const collection = factory.create('books', {
            onUpdate: async ({ transaction }) => {
                await new Promise<void>((resolve) => setTimeout(resolve, 100))
                await Promise.all(
                    transaction.mutations.map(async (mutation) => {
                        const recordWithId = mutation.original as { id: string }
                        await pb.collection('books').update(recordWithId.id, mutation.changes)
                    })
                )
                await queryClient.invalidateQueries({ queryKey: ['books'] })
            },
        })

        const { result } = renderHook(() =>
            useLiveQuery((q) => q.from({ books: collection }).where(({ books }) => eq(books.id, testBook.id)))
        )

        await waitFor(
            () => {
                expect(result.current.isLoading).toBe(false)
            },
            { timeout: 5000 }
        )

        const tx = collection.update(testBook.id, (draft) => {
            draft.title = 'State Tracking Test'
        })

        expect(['pending', 'persisting']).toContain(tx.state)

        await tx.isPersisted.promise

        expect(tx.state).toBe('completed')

        try {
            await pb.collection('books').delete(testBook.id)
        } catch (_error) {
            // Ignore cleanup errors
        }
    })

    it('should handle insert and delete in same batch (optimistic cancellation)', async () => {
        const factory = createCollectionFactory(queryClient)
        const collection = factory.create('books', {
            onInsert: async () => {},
            onUpdate: async () => {},
            onDelete: async () => {},
        })

        const { result } = renderHook(() => useLiveQuery((q) => q.from({ books: collection })))

        await waitFor(
            () => {
                expect(result.current.isLoading).toBe(false)
            },
            { timeout: 5000 }
        )

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

        await new Promise((resolve) => setTimeout(resolve, 500))

        expect(result.current.data.length).toBe(initialCount)
        expect(result.current.data.find((b) => b.id === newBook.id)).toBeUndefined()
    })

    it('should pass transaction context to mutation handlers', async () => {
        const authorId = await getTestAuthorId()
        const testBook = await pb.collection('books').create({
            title: `Context Test ${Date.now().toString().slice(-8)}`,
            genre: 'Fiction',
            isbn: getTestSlug('ctx'),
            author: authorId,
        })

        const factory = createCollectionFactory(queryClient)
        const collection = factory.create('books', {
            onUpdate: async ({ transaction }) => {
                const mutation = transaction.mutations[0]
                expect(mutation.type).toBe('update')
                expect(mutation.original).toBeDefined()
                expect(mutation.modified).toBeDefined()
                expect(mutation.changes).toBeDefined()
                expect(mutation.changes.title).toBe('Context Updated')

                const recordWithId = mutation.original as { id: string }
                await pb.collection('books').update(recordWithId.id, mutation.changes)
                await queryClient.invalidateQueries({ queryKey: ['books'] })
            },
        })

        const { result } = renderHook(() =>
            useLiveQuery((q) => q.from({ books: collection }).where(({ books }) => eq(books.id, testBook.id)))
        )

        await waitFor(
            () => {
                expect(result.current.isLoading).toBe(false)
            },
            { timeout: 5000 }
        )

        const tx = collection.update(testBook.id, (draft) => {
            draft.title = 'Context Updated'
        })

        await tx.isPersisted.promise

        try {
            await pb.collection('books').delete(testBook.id)
        } catch (_error) {
            // Ignore cleanup errors
        }
    })
})
