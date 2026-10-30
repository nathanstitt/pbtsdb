import { eq, useLiveQuery } from '@tanstack/react-db'
import { renderHook, waitFor } from '@testing-library/react'
import type { SendOptions } from 'pocketbase'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createCollection, LIVE_TOPIC_WINDOW_MS, subscribeTopic } from '../src'
import { realtimeClientFor } from '../src/transport'
import {
    authenticateTestUser,
    clearAuth,
    getTestSlug,
    newRecordId,
    pb,
    sendSignal,
} from './helpers'
import type { Schema } from './schema'

const TOPIC = 'collection/author_book_counts'
const VIEW_PATH = '/api/collections/author_book_counts/records'

// Cleaned up after every test, a failed one too: a collection left syncing
// keeps its topics, so a later test's subscribe would need no POST.
const built: { cleanup: () => Promise<void> }[] = []

function track<T extends { cleanup: () => Promise<void> }>(collection: T): T {
    built.push(collection)
    return collection
}

function createCountsCollection(liveTopics: readonly string[] = [TOPIC]) {
    return track(
        createCollection<Schema>(pb)('author_book_counts', {
            syncMode: 'on-demand',
            realtime: 'query',
            liveTopics,
        })
    )
}

function createEagerCountsCollection() {
    return track(createCollection<Schema>(pb)('author_book_counts', { liveTopics: [TOPIC] }))
}

type CountsCollection = ReturnType<typeof createCountsCollection>

async function createAuthor(): Promise<string> {
    const id = newRecordId()
    await pb.collection('authors').create({ id, name: `Live ${id}`, email: `${id}@live.test` })
    return id
}

async function createBook(author: string): Promise<void> {
    await pb.collection('books').create({
        title: 'Live',
        isbn: getTestSlug('isbn'),
        genre: 'Fiction',
        author,
        page_count: 1,
        published_date: '',
    })
}

// Every gate opens after each test, so a failed test leaves no request held.
const gates: (() => void)[] = []

function gate() {
    let open: () => void = () => undefined
    const opened = new Promise<void>(resolve => {
        open = resolve
    })
    gates.push(open)
    return { opened, open }
}

const originalBeforeSend = pb.beforeSend
let holdRealtimePost: Promise<void> | undefined
// Holds the response of the next view request after the server has
// answered it, so the rows it carries are read before a later write.
let holdViewResponse: { release: Promise<void>; onRead: () => void } | undefined

function holdRequests(): void {
    pb.beforeSend = async (url: string, options: SendOptions) => {
        if (holdRealtimePost && url.endsWith('/api/realtime') && options.method === 'POST') {
            await holdRealtimePost
        }
        const held = holdViewResponse
        if (held && url.includes(VIEW_PATH)) {
            holdViewResponse = undefined
            options.fetch = async (input, init) => {
                const response = await fetch(input, init)
                held.onRead()
                await held.release
                return response
            }
        }
        return { url, options }
    }
}

// Holds every live-topic window instead of starting its timer, so a test
// decides when each one closes. Other timers run as usual.
function holdWindows() {
    const realSetTimeout = globalThis.setTimeout
    const held: (() => void)[] = []
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        handler: TimerHandler,
        timeout?: number,
        ...args: unknown[]
    ) => {
        if (timeout !== LIVE_TOPIC_WINDOW_MS || typeof handler !== 'function') {
            return realSetTimeout(handler, timeout, ...args)
        }
        held.push(() => handler(...args))
        return realSetTimeout(() => undefined, 0)
    }) as typeof setTimeout)
    return {
        count: () => held.length,
        close: (index: number) => held[index]?.(),
    }
}

// A message on the barrier topic arrives after every message the server
// sent before it on the same connection.
async function barrier(): Promise<void> {
    const reached = vi.fn()
    const unsubscribe = await subscribeTopic(pb, 'test/barrier', reached)
    try {
        await sendSignal('test/barrier')
        await waitFor(() => expect(reached).toHaveBeenCalled())
    } finally {
        await unsubscribe()
    }
}

function mountCount(counts: CountsCollection, author: string) {
    return renderHook(() =>
        useLiveQuery(q => q.from({ c: counts }).where(({ c }) => eq(c.id, author)))
    )
}

// `topics()` lists a topic as soon as it is registered, before the server
// has it. Every subscriptions POST carries the whole list, so once a later
// subscribe resolves, every topic registered before it is confirmed too.
async function confirmTopics(): Promise<void> {
    const unsubscribe = await subscribeTopic(pb, 'test/confirm', () => undefined)
    await unsubscribe()
}

// Confirms the topics, then lets the reload their confirmation started
// finish: a reload called during another settles after it.
async function mountSettled(author: string) {
    const counts = createCountsCollection()
    const { result } = mountCount(counts, author)
    await waitFor(() => expect(result.current.data?.[0]?.book_count).toBe(0))
    await confirmTopics()
    await counts.utils.reload()
    return result
}

describe('liveTopics', () => {
    beforeAll(async () => {
        await authenticateTestUser()
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        for (const open of gates.splice(0)) open()
        pb.beforeSend = originalBeforeSend
        holdRealtimePost = undefined
        holdViewResponse = undefined
        await Promise.all(built.splice(0).map(collection => collection.cleanup()))
    })

    afterAll(() => {
        clearAuth()
    })

    it('reloads the collection on a message', async () => {
        const author = await createAuthor()
        const result = await mountSettled(author)

        await createBook(author)
        await sendSignal(TOPIC)
        await waitFor(() => expect(result.current.data?.[0]?.book_count).toBe(1))
    })

    it('coalesces a burst of messages into one reload', async () => {
        const author = await createAuthor()
        const result = await mountSettled(author)
        const windows = holdWindows()

        await createBook(author)
        await sendSignal(TOPIC, 5)
        await barrier()
        expect(windows.count()).toBe(1)
        expect(result.current.data?.[0]?.book_count).toBe(0)

        windows.close(0)
        await waitFor(() => expect(result.current.data?.[0]?.book_count).toBe(1))
    })

    it('keeps reloading under a steady stream of messages', async () => {
        const author = await createAuthor()
        const result = await mountSettled(author)
        const windows = holdWindows()

        await sendSignal(TOPIC)
        await barrier()
        // A message while the window is open neither restarts it nor opens
        // another, so a stream that never pauses still reloads.
        await sendSignal(TOPIC)
        await barrier()
        expect(windows.count()).toBe(1)

        await createBook(author)
        windows.close(0)
        await waitFor(() => expect(result.current.data?.[0]?.book_count).toBe(1))

        await sendSignal(TOPIC)
        await barrier()
        expect(windows.count()).toBe(2)
        await createBook(author)
        windows.close(1)
        await waitFor(() => expect(result.current.data?.[0]?.book_count).toBe(2))
    })

    it('reloads once the topic is confirmed after the first load', async () => {
        const author = await createAuthor()
        const post = gate()
        holdRealtimePost = post.opened
        holdRequests()
        const counts = createCountsCollection()
        const { result } = mountCount(counts, author)
        await waitFor(() => expect(result.current.data?.[0]?.book_count).toBe(0))

        // Written after the first fetch, before the server has the topic:
        // no message can report it to this client.
        await createBook(author)
        post.open()
        await waitFor(() => expect(result.current.data?.[0]?.book_count).toBe(1))
    })

    it('reloads an eager collection whose topic is confirmed during its first load', async () => {
        const author = await createAuthor()
        const post = gate()
        const response = gate()
        const read = gate()
        holdRealtimePost = post.opened
        holdViewResponse = { release: response.opened, onRead: read.open }
        holdRequests()
        const counts = createEagerCountsCollection()
        const { result } = mountCount(counts, author)

        // The first load's rows are read before the write, and the topic is
        // confirmed before that load finishes.
        await read.opened
        await createBook(author)
        post.open()
        await confirmTopics()
        expect(counts.status).toBe('loading')

        response.open()
        await waitFor(() => expect(result.current.data?.[0]?.book_count).toBe(1))
    })

    it('leaves its topics when the collection is cleaned up', async () => {
        const author = await createAuthor()
        const counts = createCountsCollection(['collection/live_cleanup'])
        const { result, unmount } = mountCount(counts, author)
        await waitFor(() => expect(result.current.data).toHaveLength(1))
        await waitFor(() =>
            expect(realtimeClientFor(pb).topics()).toContain('collection/live_cleanup')
        )
        unmount()
        await counts.cleanup()
        await waitFor(() =>
            expect(realtimeClientFor(pb).topics()).not.toContain('collection/live_cleanup')
        )
    })

    it('refuses an empty topic and a topic over 2500 characters at build', () => {
        expect(() => createCountsCollection([''])).toThrow('liveTopics')
        expect(() => createCountsCollection(['x'.repeat(2501)])).toThrow('liveTopics')
    })
})
