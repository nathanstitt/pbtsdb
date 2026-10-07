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
    pb,
    waitForLoadFinish,
} from './helpers'
import type { Books, Schema } from './schema'

/**
 * pbtsdb writes realtime rows through the collection's sync session. TanStack
 * DB keeps the object a sync source writes as the stored row and, in
 * development, throws SyncRowReusedWithoutPreviousValueError when the source
 * writes an object it already wrote after changing it in place. pbtsdb copies
 * each row it writes, so neither a reused event object nor a later change to
 * it can reach the store.
 */
describe('realtime rows written through the sync session', () => {
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

    const captureRealtimeHandler = () => {
        const ref: { current: ((event: RecordSubscription<Books>) => void) | null } = {
            current: null,
        }
        const client = realtimeClientFor(pb)
        const real = client.subscribe.bind(client)
        vi.spyOn(client, 'subscribe').mockImplementation((topic, listener) => {
            if (topic.startsWith('books/')) {
                ref.current = listener as unknown as (event: RecordSubscription<Books>) => void
            }
            return real(topic, listener)
        })
        return ref
    }

    const later = (record: Books, ms: number) =>
        `${new Date(Date.parse(record.updated.replace(' ', 'T')) + ms)
            .toISOString()
            .replace('T', ' ')
            .replace('Z', '')}Z`

    it('stores a copy of each event record, so a reused record cannot rewrite the row', async () => {
        const handlerRef = captureRealtimeHandler()
        const seed = await pb.collection('books').create<Books>({
            title: `Reuse ${Date.now().toString().slice(-8)}`,
            isbn: getTestSlug('reuse'),
            genre: 'Fiction',
            author: await getTestAuthorId(),
            published_date: '',
            page_count: 1,
        })
        const collection = createCollection<Schema>(pb, queryClient)('books', {
            syncMode: 'on-demand',
        })
        const { result } = renderHook(() => useLiveQuery(q => q.from({ books: collection })))
        await waitForLoadFinish(result, 10000)
        await collection.waitForSubscription()
        await waitFor(() => expect(collection.has(seed.id)).toBe(true), { timeout: 10000 })

        const record: Books = { ...seed, title: 'first', updated: later(seed, 1000) }
        const event: RecordSubscription<Books> = { action: 'update', record }
        handlerRef.current?.(event)
        expect(collection.get(seed.id)?.title).toBe('first')

        // The same object, changed in place and delivered again.
        record.title = 'second'
        record.updated = later(seed, 2000)
        expect(() => handlerRef.current?.(event)).not.toThrow()
        expect(collection.get(seed.id)?.title).toBe('second')

        // A change to the caller's object after delivery leaves the row alone.
        record.title = 'changed behind the store'
        expect(collection.get(seed.id)?.title).toBe('second')
        expect(collection.base.get(seed.id)?.title).toBe('second')

        await pb
            .collection('books')
            .delete(seed.id)
            .catch(() => {})
    }, 30000)
})
