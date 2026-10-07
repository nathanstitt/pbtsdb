import { eq } from '@tanstack/db'
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
    topicFilter,
    waitForLoadFinish,
} from './helpers'
import type { Books, Schema } from './schema'

type RecordIdentity = { id: string; collectionId: string; collectionName: string }

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

    it('query mode: a delete releases only the delivering topic and its subsets', async () => {
        const handlers = new Map<string, (event: RecordSubscription<Books>) => void>()
        const client = realtimeClientFor(pb)
        const real = client.subscribe.bind(client)
        vi.spyOn(client, 'subscribe').mockImplementation((topic, listener) => {
            const filter = topic.startsWith('books/') ? topicFilter(topic) : undefined
            if (filter) {
                handlers.set(filter, listener as unknown as (e: RecordSubscription<Books>) => void)
            }
            return real(topic, listener)
        })
        const authorId = await getTestAuthorId()
        const title = `Per Topic ${getTestSlug('ptd')}`
        const create = (isbn: string) =>
            pb.collection('books').create<Books & RecordIdentity>({
                title,
                isbn,
                genre: 'Fiction',
                author: authorId,
                published_date: '',
                page_count: 0,
            })
        const shared = await create(getTestSlug('ptd-a'))
        const created = [shared.id]
        try {
            const collection = createCollection<Schema>(pb)('books', {
                syncMode: 'on-demand',
                realtime: 'query',
            })
            const byTitle = renderHook(() =>
                useLiveQuery(q =>
                    q.from({ books: collection }).where(({ books }) => eq(books.title, title))
                )
            )
            const byIsbn = renderHook(() =>
                useLiveQuery(q =>
                    q.from({ books: collection }).where(({ books }) => eq(books.isbn, shared.isbn))
                )
            )
            const handlerFor = (value: string) =>
                [...handlers].find(([filter]) => filter.includes(value))?.[1]
            await waitFor(
                () => {
                    expect(byTitle.result.current.data.map(b => b.id)).toEqual([shared.id])
                    expect(byIsbn.result.current.data.map(b => b.id)).toEqual([shared.id])
                    expect(handlerFor(title)).toBeDefined()
                    expect(handlerFor(shared.isbn)).toBeDefined()
                },
                { timeout: 10000 }
            )
            const titleTopic = handlerFor(title)
            const isbnTopic = handlerFor(shared.isbn)
            if (!titleTopic || !isbnTopic) throw new Error('topic handlers not captured')

            // A leave event: a delete carrying only the id, on one topic.
            const leave = (book: RecordIdentity): RecordSubscription<Books> => {
                const record: RecordIdentity = {
                    id: book.id,
                    collectionId: book.collectionId,
                    collectionName: book.collectionName,
                }
                return { action: 'delete', record: record as unknown as Books }
            }

            isbnTopic(leave(shared))
            expect(collection.base.has(shared.id)).toBe(true)
            expect(byTitle.result.current.data.map(b => b.id)).toEqual([shared.id])

            titleTopic(leave(shared))
            expect(collection.base.has(shared.id)).toBe(false)
            await waitFor(() => expect(byTitle.result.current.data).toEqual([]))

            // A row only the title topic holds: created after both loads.
            const topicOnly = await create(getTestSlug('ptd-b'))
            created.push(topicOnly.id)
            await waitFor(() => expect(collection.base.has(topicOnly.id)).toBe(true), {
                timeout: 5000,
            })
            titleTopic(leave(topicOnly))
            expect(collection.base.has(topicOnly.id)).toBe(false)

            byTitle.unmount()
            byIsbn.unmount()
            expect(captured).toHaveLength(0)
        } finally {
            await Promise.all(
                created.map(id =>
                    pb
                        .collection('books')
                        .delete(id)
                        .catch(() => {})
                )
            )
        }
    }, 25000)
})
