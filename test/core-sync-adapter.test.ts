import { eq, useLiveQuery } from '@tanstack/react-db'
import { renderHook, waitFor } from '@testing-library/react'
import type { RecordSubscription } from 'pocketbase'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createCollection } from '../src'
import { disconnectRealtime, realtimeClientFor, resetRealtime } from '../src/transport'
import {
    authenticateTestUser,
    clearAuth,
    getTestAuthorId,
    getTestSlug,
    newRecordId,
    pb,
    waitForLoadFinish,
} from './helpers'
import type { Books, Schema } from './schema'

async function newBook(genre: Books['genre'], prefix: string) {
    return {
        id: newRecordId(),
        title: `${prefix} ${Date.now().toString().slice(-8)}`,
        genre,
        isbn: getTestSlug('core'),
        author: await getTestAuthorId(),
        published_date: '',
        page_count: 0,
    }
}

async function removeBook(id: string): Promise<void> {
    try {
        await pb.collection('books').delete(id)
    } catch (_error) {
        // ignore cleanup errors
    }
}

describe('core sync adapter', () => {
    beforeAll(async () => {
        await authenticateTestUser()
    })

    afterAll(() => {
        clearAuth()
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('settles an insert whose handler reloads (refetchOnMutation)', async () => {
        const books = createCollection<Schema>(pb)('books', {
            syncMode: 'on-demand',
            refetchOnMutation: true,
            omitOnInsert: ['created', 'updated'] as const,
        })
        const { result } = renderHook(() =>
            useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fiction')))
        )
        await waitForLoadFinish(result)
        const book = await newBook('Fiction', 'reload-in-handler')
        try {
            const tx = books.insert(book)
            await tx.when('settled')
            expect(tx.state).toBe('completed')
            await waitFor(() => expect(result.current.data.some(b => b.id === book.id)).toBe(true))
        } finally {
            await removeBook(book.id)
            await books.cleanup()
        }
    }, 15000)

    it('settles a custom handler that calls accept()', async () => {
        const seed = await pb.collection('books').create<Books>(await newBook('Fiction', 'accept'))
        let accept: (rows: Books[]) => Promise<void> = async () => undefined
        const books = createCollection<Schema>(pb)('books', {
            syncMode: 'on-demand',
            onUpdate: async ({ transaction }) => {
                const rows = await Promise.all(
                    transaction.mutations.map(mutation =>
                        pb.collection('books').update<Books>(mutation.original.id, mutation.changes)
                    )
                )
                await accept(rows)
            },
        })
        accept = rows => books.utils.accept(rows)
        const { result } = renderHook(() =>
            useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.id, seed.id)))
        )
        try {
            await waitForLoadFinish(result)
            const tx = books.update(seed.id, draft => {
                draft.title = 'accepted from the handler'
            })
            await tx.when('settled')
            expect(tx.state).toBe('completed')
            expect(books.get(seed.id)?.title).toBe('accepted from the handler')
        } finally {
            await removeBook(seed.id)
            await books.cleanup()
        }
    }, 15000)

    it('settles a custom delete handler that calls evict(), with the row gone at settle', async () => {
        // Swallow delete echoes for books, so only evict() can remove the row.
        const client = realtimeClientFor(pb)
        const real = client.subscribe.bind(client)
        vi.spyOn(client, 'subscribe').mockImplementation((topic, listener) => {
            if (!topic.startsWith('books/')) return real(topic, listener)
            return real(topic, event => {
                if ((event as RecordSubscription<Books>).action !== 'delete') listener(event)
            })
        })
        const seed = await pb.collection('books').create<Books>(await newBook('Fiction', 'evict'))
        let evict: (ids: string[]) => Promise<void> = async () => undefined
        const books = createCollection<Schema>(pb)('books', {
            syncMode: 'on-demand',
            onDelete: async ({ transaction }) => {
                const ids = transaction.mutations.map(mutation => mutation.original.id)
                await Promise.all(ids.map(id => pb.collection('books').delete(id)))
                await evict(ids)
            },
        })
        evict = ids => books.evict(ids)
        const { result } = renderHook(() =>
            useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fiction')))
        )
        try {
            await waitForLoadFinish(result)
            await books.waitForSubscription()
            expect(books.get(seed.id)).toBeDefined()
            const tx = books.delete(seed.id)
            await tx.when('settled')
            expect(tx.state).toBe('completed')
            expect(books.get(seed.id)).toBeUndefined()
            await new Promise(resolve => setTimeout(resolve, 300))
            expect(books.get(seed.id)).toBeUndefined()
            expect(result.current.data.some(b => b.id === seed.id)).toBe(false)
        } finally {
            await removeBook(seed.id)
            await books.cleanup()
        }
    }, 15000)

    it('evict() is a no-op on a collection that is not syncing', async () => {
        const books = createCollection<Schema>(pb)('books', { syncMode: 'on-demand' })
        await expect(books.evict(['missing'])).resolves.toBeUndefined()
        expect(books.status).toBe('idle')
    })

    it('a saved row leaves with its query while another query keeps the collection live', async () => {
        const seed = await pb.collection('books').create<Books>(await newBook('Fiction', 'saved'))
        const books = createCollection<Schema>(pb)('books', {
            syncMode: 'on-demand',
            realtime: 'query',
            subsetGcTime: 0,
            collectionOptions: { gcTime: 60_000 },
        })
        const fiction = renderHook(() =>
            useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fiction')))
        )
        const mystery = renderHook(() =>
            useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Mystery')))
        )
        try {
            await waitForLoadFinish(fiction.result)
            await waitForLoadFinish(mystery.result)
            await books.waitForSubscription()
            const tx = books.update(seed.id, draft => {
                draft.title = 'saved from a handler'
            })
            await tx.when('settled')
            await waitFor(() => expect(books.get(seed.id)?.title).toBe('saved from a handler'))
            fiction.unmount()
            await waitFor(() => expect(books.get(seed.id)).toBeUndefined(), { timeout: 10000 })
            expect(books.isSubscribed()).toBe(true)
        } finally {
            mystery.unmount()
            await removeBook(seed.id)
            await books.cleanup()
        }
    }, 20000)

    it('releases a row only a topic held when that topic closes', async () => {
        const control = await pb
            .collection('books')
            .create<Books>(await newBook('Fiction', 'control'))
        const books = createCollection<Schema>(pb)('books', {
            syncMode: 'on-demand',
            realtime: 'query',
            subsetGcTime: 0,
            collectionOptions: { gcTime: 60_000 },
        })
        const { result, unmount } = renderHook(() =>
            useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fiction')))
        )
        let createdId: string | undefined
        try {
            await waitForLoadFinish(result)
            await books.waitForSubscription()
            // A parent-style holder: realtime going idle releases ACCEPTED in
            // on-demand mode, so an accepted row would leave too.
            expect(await books.writeFiled([control], { parent: 'control' })).toBe(true)
            const created = await pb
                .collection('books')
                .create<Books>(await newBook('Fiction', 'topic'))
            createdId = created.id
            await waitFor(() => expect(books.get(created.id)).toBeDefined())
            unmount()
            await waitFor(() => expect(books.isSubscribed()).toBe(false))
            await waitFor(() => expect(books.get(created.id)).toBeUndefined())
            expect(books.get(control.id)).toBeDefined()
        } finally {
            if (createdId) await removeBook(createdId)
            await removeBook(control.id)
            await books.cleanup()
        }
    }, 15000)

    it('a row the user created stays in a matching live query when no echo comes', async () => {
        disconnectRealtime(pb)
        const books = createCollection<Schema>(pb)('books', {
            syncMode: 'on-demand',
            subsetGcTime: 300,
            omitOnInsert: ['created', 'updated'] as const,
            collectionOptions: { gcTime: 60_000 },
        })
        const { result } = renderHook(() =>
            useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fiction')))
        )
        const created = await newBook('Fiction', 'no-echo')
        try {
            await waitForLoadFinish(result)
            expect(realtimeClientFor(pb).isConnected()).toBe(false)
            const tx = books.insert(created)
            await tx.when('settled')
            expect(tx.state).toBe('completed')
            expect(result.current.data.some(b => b.id === created.id)).toBe(true)
            await new Promise(resolve => setTimeout(resolve, 1000))
            expect(books.get(created.id)).toBeDefined()
            expect(result.current.data.some(b => b.id === created.id)).toBe(true)
        } finally {
            resetRealtime(pb)
            await removeBook(created.id)
            await books.cleanup()
        }
    }, 15000)

    it('a written row no live topic covers leaves after subsetGcTime; one a query loaded stays', async () => {
        const seed = await pb.collection('books').create<Books>(await newBook('Fiction', 'kept'))
        const books = createCollection<Schema>(pb)('books', {
            syncMode: 'on-demand',
            realtime: 'query',
            subsetGcTime: 300,
            collectionOptions: { gcTime: 60_000 },
        })
        const { result } = renderHook(() =>
            useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fiction')))
        )
        try {
            await waitForLoadFinish(result)
            await books.waitForSubscription()
            const orphan = {
                ...(await newBook('Thriller', 'orphan')),
                created: '2026-01-01 00:00:00.000Z',
                updated: '2026-01-01 00:00:00.000Z',
            } as Books
            await books.accept([orphan])
            expect(books.get(orphan.id)).toBeDefined()
            await waitFor(() => expect(books.get(orphan.id)).toBeUndefined(), { timeout: 3000 })
            expect(books.get(seed.id)).toBeDefined()
        } finally {
            await removeBook(seed.id)
            await books.cleanup()
        }
    }, 15000)

    it('on-demand: realtime going idle releases ACCEPTED', async () => {
        const seed = await pb.collection('books').create<Books>(await newBook('Mystery', 'idle'))
        const books = createCollection<Schema>(pb)('books', {
            syncMode: 'on-demand',
            realtime: 'query',
            subsetGcTime: 0,
            collectionOptions: { gcTime: 60_000 },
        })
        const { result, unmount } = renderHook(() =>
            useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fiction')))
        )
        try {
            await waitForLoadFinish(result)
            await books.waitForSubscription()
            await books.accept([seed])
            expect(books.get(seed.id)).toBeDefined()
            unmount()
            await waitFor(() => expect(books.isSubscribed()).toBe(false))
            await waitFor(() => expect(books.get(seed.id)).toBeUndefined())
        } finally {
            await removeBook(seed.id)
            await books.cleanup()
        }
    }, 15000)

    it('reload() evicts a row that a topic echoed and the server no longer returns', async () => {
        const seed = await pb.collection('books').create<Books>(await newBook('Fiction', 'evict'))
        const books = createCollection<Schema>(pb)('books', { syncMode: 'on-demand' })
        const { result } = renderHook(() =>
            useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fiction')))
        )
        try {
            await waitForLoadFinish(result)
            await books.waitForSubscription()
            await pb.collection('books').update(seed.id, { genre: 'Mystery' })
            await waitFor(() => expect(books.get(seed.id)?.genre).toBe('Mystery'))
            await books.reload()
            expect(books.get(seed.id)).toBeUndefined()
        } finally {
            await removeBook(seed.id)
            await books.cleanup()
        }
    }, 15000)
})
