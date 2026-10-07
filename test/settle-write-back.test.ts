import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import type { QueryClient } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { RecordSubscription } from 'pocketbase'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCollection } from '../src'
import { realtimeClientFor } from '../src/transport'

import {
    authenticateTestUser,
    clearAuth,
    createTestQueryClient,
    getTestAuthorId,
    getTestSlug,
    newRecordId,
    pb,
    waitForLoadFinish,
} from './helpers'
import type { Books, Schema } from './schema'

/**
 * TanStack DB 0.12 drops a transaction's optimistic state when its mutation
 * handler settles. A row the handler did not write back shows its previous
 * synced value from then until the realtime echo lands. The built-in handlers
 * write the server response while they run, so it publishes together with
 * the drop. Each test mutes the row's realtime echo, so only that write-back
 * can make the settled row right.
 */
describe('built-in handlers land the server row before they settle', () => {
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

    // Realtime events for these ids never reach the collection.
    const muteEchoes = () => {
        const muted = new Set<string>()
        const client = realtimeClientFor(pb)
        const real = client.subscribe.bind(client)
        vi.spyOn(client, 'subscribe').mockImplementation((topic, listener) =>
            real(topic, event => {
                const typed = event as unknown as RecordSubscription<Books>
                if (!topic.startsWith('books/') || !muted.has(typed.record.id)) listener(event)
            })
        )
        return muted
    }

    const seedBook = async (isbn: string) =>
        pb.collection('books').create<Books>({
            title: `Settle ${Date.now().toString().slice(-8)}`,
            isbn,
            genre: 'Fiction',
            author: await getTestAuthorId(),
            published_date: '',
            page_count: 1,
        })

    async function mountBooks(isbn: string) {
        const collection = createCollection<Schema>(pb, queryClient)('books', {
            syncMode: 'on-demand',
            omitOnInsert: ['created', 'updated'] as const,
        })
        const { result } = renderHook(() =>
            useLiveQuery(q =>
                q.from({ books: collection }).where(({ books }) => eq(books.isbn, isbn))
            )
        )
        await waitForLoadFinish(result, 10000)
        await collection.waitForSubscription()
        return { collection, result }
    }

    // Every change the collection publishes for `id`, in order.
    function recordChanges(
        collection: Awaited<ReturnType<typeof mountBooks>>['collection'],
        id: string
    ) {
        const changes: { type: string; title?: string }[] = []
        const subscription = collection.subscribeChanges(
            batch => {
                for (const change of batch) {
                    if (change.key === id) {
                        changes.push({ type: change.type, title: change.value?.title })
                    }
                }
            },
            { includeInitialState: false }
        )
        return { changes, unsubscribe: () => subscription.unsubscribe() }
    }

    it('update: the settled row is the server response, never the previous synced row', async () => {
        const muted = muteEchoes()
        const isbn = getTestSlug('settle-u')
        const seed = await seedBook(isbn)
        const { collection } = await mountBooks(isbn)
        await waitFor(() => expect(collection.has(seed.id)).toBe(true), { timeout: 10000 })
        muted.add(seed.id)
        const recorded = recordChanges(collection, seed.id)

        const title = `Renamed ${Date.now().toString().slice(-8)}`
        const tx = collection.update(seed.id, draft => {
            draft.title = title
        })
        await tx.when('settled')

        const settled = collection.get(seed.id)
        expect(settled?.title).toBe(title)
        expect(settled?.$hasPendingWrites).toBe(false)
        expect(collection.base.get(seed.id)?.title).toBe(title)
        await new Promise(r => setTimeout(r, 300))
        expect(collection.get(seed.id)?.title).toBe(title)
        expect(recorded.changes.map(change => change.title)).not.toContain(seed.title)
        recorded.unsubscribe()

        await pb
            .collection('books')
            .delete(seed.id)
            .catch(() => {})
    }, 30000)

    it('insert: the settled row carries server-assigned fields and never disappears', async () => {
        const muted = muteEchoes()
        const isbn = getTestSlug('settle-i')
        const { collection } = await mountBooks(isbn)
        const id = newRecordId()
        muted.add(id)
        const recorded = recordChanges(collection, id)

        const tx = collection.insert({
            id,
            title: `Inserted ${Date.now().toString().slice(-8)}`,
            isbn,
            genre: 'Fiction',
            author: await getTestAuthorId(),
            published_date: '',
            page_count: 1,
        })
        await tx.when('settled')

        const settled = collection.get(id)
        expect(settled?.created).toBeTruthy()
        expect(settled?.$hasPendingWrites).toBe(false)
        await new Promise(r => setTimeout(r, 300))
        expect(collection.has(id)).toBe(true)
        expect(recorded.changes.map(change => change.type)).not.toContain('delete')
        recorded.unsubscribe()

        await pb
            .collection('books')
            .delete(id)
            .catch(() => {})
    }, 30000)

    it('delete: the row stays gone once the handler settles', async () => {
        const muted = muteEchoes()
        const isbn = getTestSlug('settle-d')
        const seed = await seedBook(isbn)
        const { collection } = await mountBooks(isbn)
        await waitFor(() => expect(collection.has(seed.id)).toBe(true), { timeout: 10000 })
        muted.add(seed.id)
        const recorded = recordChanges(collection, seed.id)

        const tx = collection.delete(seed.id)
        await tx.when('settled')

        expect(collection.has(seed.id)).toBe(false)
        expect(collection.base.has(seed.id)).toBe(false)
        await new Promise(r => setTimeout(r, 300))
        expect(collection.has(seed.id)).toBe(false)
        expect(recorded.changes.map(change => change.type)).toEqual(['delete'])
        recorded.unsubscribe()
    }, 30000)
})
