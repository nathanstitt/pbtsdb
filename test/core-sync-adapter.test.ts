import { eq, useLiveQuery } from '@tanstack/react-db'
import { renderHook, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createCollection } from '../src'
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

    it('releases a row only a topic held when that topic closes', async () => {
        const books = createCollection<Schema>(pb)('books', {
            syncMode: 'on-demand',
            realtime: 'query',
            collectionOptions: { gcTime: 60_000 },
        })
        const { result, unmount } = renderHook(() =>
            useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fiction')))
        )
        await waitForLoadFinish(result)
        await books.waitForSubscription()
        const created = await pb
            .collection('books')
            .create<Books>(await newBook('Fiction', 'topic'))
        try {
            await waitFor(() => expect(books.get(created.id)).toBeDefined())
            unmount()
            await waitFor(() => expect(books.isSubscribed()).toBe(false))
            await waitFor(() => expect(books.get(created.id)).toBeUndefined())
        } finally {
            await removeBook(created.id)
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
