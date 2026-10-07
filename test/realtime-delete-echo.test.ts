import { useLiveQuery } from '@tanstack/react-db'
import { renderHook, waitFor } from '@testing-library/react'
import type { RecordSubscription } from 'pocketbase'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCollection } from '../src'
import { realtimeClientFor } from '../src/transport'

import {
    authenticateTestUser,
    clearAuth,
    createTestLogger,
    getTestAuthorId,
    getTestSlug,
    pb,
    resetLogger,
    setLogger,
    type TestLogger,
    waitForLoadFinish,
} from './helpers'
import type { Books, Schema } from './schema'

/**
 * Regression coverage for a realtime delete echo whose record was already
 * removed from the synced store before the echo arrived (see
 * handleRealtimeEvent in build-collection.ts). While sync runs the handler
 * releases nothing and logs nothing, so the tests assert on (a) no uncaught
 * error and (b) the row staying absent.
 */
describe('realtime delete echo idempotency', () => {
    let testLogger: TestLogger
    const captured: Error[] = []

    const onUncaught = (err: Error) => captured.push(err)
    const onUnhandledRejection = (reason: unknown) =>
        captured.push(reason instanceof Error ? reason : new Error(String(reason)))

    beforeAll(async () => {
        await authenticateTestUser()
        process.on('uncaughtException', onUncaught)
        process.on('unhandledRejection', onUnhandledRejection)
    })

    afterAll(() => {
        process.off('uncaughtException', onUncaught)
        process.off('unhandledRejection', onUnhandledRejection)
        clearAuth()
    })

    beforeEach(() => {
        captured.length = 0
        testLogger = createTestLogger()
        setLogger(testLogger)
    })

    afterEach(() => {
        resetLogger()
        vi.restoreAllMocks()
    })

    const seedBook = async () => {
        const authorId = await getTestAuthorId()
        return pb.collection('books').create<Books>({
            title: `Echo Idempotency ${Date.now().toString().slice(-8)}`,
            isbn: getTestSlug('rde'),
            genre: 'Fiction',
            author: authorId,
            published_date: '',
            page_count: 0,
        })
    }

    /**
     * Capture the realtime handler the collection registers, so a test can
     * replay an event exactly as a redelivered SSE event arrives. The real
     * subscription is still established underneath.
     */
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

    /**
     * Record the id of every delete event the collection's realtime listener
     * has finished handling.
     */
    const trackDeleteDeliveries = () => {
        const handled: string[] = []
        const client = realtimeClientFor(pb)
        const real = client.subscribe.bind(client)
        vi.spyOn(client, 'subscribe').mockImplementation((topic, listener) => {
            if (!topic.startsWith('books/')) return real(topic, listener)
            return real(topic, event => {
                listener(event)
                const { action, record } = event as RecordSubscription<Books>
                if (action === 'delete') handled.push(record.id)
            })
        })
        return handled
    }

    const ignoredEchoLogs = () =>
        testLogger.messages.debug.filter(m => m.msg.includes('Ignoring delete echo'))

    it('on-demand: a redelivered delete echo for an already-removed key is a no-op', async () => {
        const handlerRef = captureRealtimeHandler()
        const collection = createCollection<Schema>(pb)('books', {
            syncMode: 'on-demand',
        })

        const { result } = renderHook(() => useLiveQuery(q => q.from({ books: collection })))
        await waitFor(
            () => {
                expect(result.current.isLoading).toBe(false)
                expect(result.current.data.length).toBeGreaterThan(0)
            },
            { timeout: 10000 }
        )
        await collection.waitForSubscription()

        const seed = await seedBook()
        await waitFor(() => expect(result.current.data.find(b => b.id === seed.id)).toBeDefined())

        // The same delete delivered twice, as an SSE redelivery after a
        // reconnect does: the first removes the row, the second finds it gone.
        const echo: RecordSubscription<Books> = { action: 'delete', record: seed }
        handlerRef.current?.(echo)
        expect(collection.base.has(seed.id)).toBe(false)
        expect(() => handlerRef.current?.(echo)).not.toThrow()
        // Ledger rule 5: a delete for an absent key releases nothing; no log while sync runs.
        expect(ignoredEchoLogs()).toHaveLength(0)
        await waitFor(() => expect(result.current.data.find(b => b.id === seed.id)).toBeUndefined())

        await pb
            .collection('books')
            .delete(seed.id)
            .catch(() => {})
    }, 25000)

    it('on-demand: real delete echo for a pruned key does not surface an uncaught error', async () => {
        const handledDeletes = trackDeleteDeliveries()
        const collection = createCollection<Schema>(pb)('books', {
            syncMode: 'on-demand',
        })

        const { result } = renderHook(() => useLiveQuery(q => q.from({ books: collection })))
        await waitFor(
            () => {
                expect(result.current.isLoading).toBe(false)
                expect(result.current.data.length).toBeGreaterThan(0)
            },
            { timeout: 10000 }
        )
        await collection.waitForSubscription()

        const seed = await seedBook()
        await waitFor(() => expect(result.current.data.find(b => b.id === seed.id)).toBeDefined())

        // Ledger rule 3: a reload whose result omits the row releases its refs,
        // so the row leaves the synced store.
        const books = pb.collection('books')
        const realGetFullList = books.getFullList.bind(books)
        const getFullList = vi
            .spyOn(books, 'getFullList')
            .mockImplementation(async (...args: Parameters<typeof realGetFullList>) => {
                const items = await realGetFullList(...args)
                return items.filter(item => item.id !== seed.id) as typeof items
            })
        await collection.reload()
        await waitFor(() => expect(collection.base.has(seed.id)).toBe(false))
        getFullList.mockRestore()

        // The genuine SSE delete echo now runs against an absent key.
        await pb.collection('books').delete(seed.id)
        await waitFor(() => expect(handledDeletes).toContain(seed.id), { timeout: 5000 })
        expect(captured).toHaveLength(0)
        // Ledger rule 5: a delete for an absent key releases nothing; no log while sync runs.
        expect(ignoredEchoLogs()).toHaveLength(0)
        expect(result.current.data.find(b => b.id === seed.id)).toBeUndefined()
    }, 25000)

    it('on-demand: normal delete echo still removes the row', async () => {
        const collection = createCollection<Schema>(pb)('books', {
            syncMode: 'on-demand',
        })

        const { result } = renderHook(() => useLiveQuery(q => q.from({ books: collection })))
        await waitFor(
            () => {
                expect(result.current.isLoading).toBe(false)
                expect(result.current.data.length).toBeGreaterThan(0)
            },
            { timeout: 10000 }
        )
        await collection.waitForSubscription()

        const seed = await seedBook()
        await waitFor(() => expect(result.current.data.find(b => b.id === seed.id)).toBeDefined())

        await pb.collection('books').delete(seed.id)

        await waitFor(
            () => expect(result.current.data.find(b => b.id === seed.id)).toBeUndefined(),
            {
                timeout: 5000,
            }
        )
        expect(ignoredEchoLogs()).toHaveLength(0)
        expect(collection.base.has(seed.id)).toBe(false)
    }, 25000)

    it('eager default: optimistic delete + echo does not throw', async () => {
        const collection = createCollection<Schema>(pb)('books')

        const { result } = renderHook(() => useLiveQuery(q => q.from({ books: collection })))
        await waitForLoadFinish(result)
        await collection.waitForSubscription()

        const seed = await seedBook()
        await waitFor(() => expect(result.current.data.find(b => b.id === seed.id)).toBeDefined())

        const tx = collection.delete(seed.id)
        await tx.when('settled')
        await new Promise(r => setTimeout(r, 1500))

        expect(
            captured.filter(e => /Delete operation: Item with key/i.test(e.message))
        ).toHaveLength(0)
        expect(result.current.data.find(b => b.id === seed.id)).toBeUndefined()
    }, 25000)
})
