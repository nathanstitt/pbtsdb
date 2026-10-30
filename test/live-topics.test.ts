import { eq, useLiveQuery } from '@tanstack/react-db'
import { renderHook, waitFor } from '@testing-library/react'
import type { SendOptions } from 'pocketbase'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createCollection, LIVE_TOPIC_WINDOW_MS, subscribeTopic } from '../src'
import { logger } from '../src/logger'
import {
    realtimeClientFor,
    reconnectRealtime,
    setRealtimeBackoff,
    setRealtimeEventSource,
} from '../src/transport'
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

function subscriptionsOf(options: SendOptions): string[] {
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body
    return (body as { subscriptions?: string[] } | undefined)?.subscriptions ?? []
}

function isTopicPost(url: string, options: SendOptions, topic: string): boolean {
    return (
        url.endsWith('/api/realtime') &&
        options.method === 'POST' &&
        subscriptionsOf(options).includes(topic)
    )
}

const failWith = (status: number) => () =>
    Promise.resolve(
        new Response(JSON.stringify({ message: 'Refused by the test.' }), {
            status,
            headers: { 'Content-Type': 'application/json' },
        })
    )

const refused = failWith(400)

// Fails the first subscriptions POST that carries `topic` with `status`,
// and holds the second until `release` is called.
function refuseFirstTopicPost(topic: string, status = 400) {
    const release = gate()
    const clientIds: unknown[] = []
    pb.beforeSend = async (url: string, options: SendOptions) => {
        if (isTopicPost(url, options, topic)) {
            clientIds.push((options.body as { clientId?: unknown } | undefined)?.clientId)
            if (clientIds.length === 1) options.fetch = failWith(status)
            if (clientIds.length === 2) await release.opened
        }
        return { url, options }
    }
    return { attempts: () => clientIds.length, clientIds, release: release.open }
}

function countViewRequests(): () => number {
    let count = 0
    pb.beforeSend = (url: string, options: SendOptions) => {
        if (url.includes(VIEW_PATH)) count += 1
        return { url, options }
    }
    return () => count
}

// Drops the shared connection, then connects again at once.
function reconnectNow(): void {
    realtimeClientFor(pb).simulateDisconnect()
    reconnectRealtime(pb)
}

// A connection that opens and never confirms anything.
const idleSource = () => ({
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    close: () => undefined,
})

// The window timer is a named function: matching the name as well as the
// delay leaves every other 100 ms timer in the process running as usual.
function isLiveTopicWindow(handler: TimerHandler, timeout: number | undefined): boolean {
    return (
        timeout === LIVE_TOPIC_WINDOW_MS &&
        typeof handler === 'function' &&
        handler.name === 'closeLiveTopicWindow'
    )
}

type HeldWindow = { handle: ReturnType<typeof setTimeout>; run: () => void; cleared: boolean }

// Holds every live-topic window instead of starting its timer, so a test
// decides when each one closes. A window cleared while held never closes.
function holdWindows() {
    const realSetTimeout = globalThis.setTimeout
    const realClearTimeout = globalThis.clearTimeout
    const held: HeldWindow[] = []
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        handler: TimerHandler,
        timeout?: number,
        ...args: unknown[]
    ) => {
        if (!isLiveTopicWindow(handler, timeout) || typeof handler !== 'function') {
            return realSetTimeout(handler, timeout, ...args)
        }
        const handle = realSetTimeout(() => undefined, 0)
        held.push({ handle, run: () => handler(...args), cleared: false })
        return handle
    }) as typeof setTimeout)
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((
        handle?: ReturnType<typeof setTimeout>
    ) => {
        for (const window of held) if (window.handle === handle) window.cleared = true
        realClearTimeout(handle)
    }) as typeof clearTimeout)
    return {
        count: () => held.length,
        close: (index: number) => {
            const window = held[index]
            if (window && !window.cleared) window.run()
        },
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
        setRealtimeEventSource(pb, undefined)
        setRealtimeBackoff(pb, undefined)
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

    it('subscribes a refused topic again on the next reconnect, then reloads', async () => {
        const author = await createAuthor()
        // Keeps a topic on the connection, so a reconnect happens after the
        // refused topic leaves it.
        const keep = await subscribeTopic(pb, 'test/keep', () => undefined)
        try {
            const post = refuseFirstTopicPost(TOPIC)
            const counts = createCountsCollection()
            const { result } = mountCount(counts, author)
            await waitFor(() => expect(result.current.data?.[0]?.book_count).toBe(0))
            await waitFor(() => expect(post.attempts()).toBe(1))
            await waitFor(() => expect(realtimeClientFor(pb).topics()).not.toContain(TOPIC))

            reconnectNow()
            await waitFor(() => expect(post.attempts()).toBe(2))
            // Settles the reconnect's own reload: only the retry's
            // confirmation can bring in a write made now.
            await counts.utils.reload()
            await createBook(author)
            post.release()
            await waitFor(() => expect(result.current.data?.[0]?.book_count).toBe(1))

            await createBook(author)
            await sendSignal(TOPIC)
            await waitFor(() => expect(result.current.data?.[0]?.book_count).toBe(2))
        } finally {
            await keep()
        }
    })

    it('reconnects after a subscriptions POST fails with a 500, then reloads', async () => {
        const author = await createAuthor()
        setRealtimeBackoff(pb, () => 0)
        const post = refuseFirstTopicPost(TOPIC, 500)
        const counts = createCountsCollection()
        const { result } = mountCount(counts, author)
        await waitFor(() => expect(result.current.data?.[0]?.book_count).toBe(0))

        // No reconnectNow(): the failed POST itself reconnects, and the
        // retry goes out on the new connection.
        await waitFor(() => expect(post.attempts()).toBe(2))
        expect(post.clientIds[1]).not.toBe(post.clientIds[0])
        await counts.utils.reload()
        await createBook(author)
        post.release()
        await waitFor(() => expect(result.current.data?.[0]?.book_count).toBe(1))

        await createBook(author)
        await sendSignal(TOPIC)
        await waitFor(() => expect(result.current.data?.[0]?.book_count).toBe(2))
    })

    it('keeps the connection after a subscriptions POST is refused with a 400', async () => {
        const author = await createAuthor()
        const keep = await subscribeTopic(pb, 'test/keep', () => undefined)
        try {
            const connectedId = realtimeClientFor(pb).clientId()
            const post = refuseFirstTopicPost(TOPIC)
            const counts = createCountsCollection()
            const { result } = mountCount(counts, author)
            await waitFor(() => expect(result.current.data).toHaveLength(1))
            await waitFor(() => expect(realtimeClientFor(pb).topics()).not.toContain(TOPIC))
            await barrier()
            expect(realtimeClientFor(pb).clientId()).toBe(connectedId)
            expect(post.attempts()).toBe(1)
        } finally {
            await keep()
        }
    })

    // With no topic left on the connection, an auth change opens no new
    // connection, so no reconnect can retry the refused topic.
    it('subscribes a refused topic again after an auth change', async () => {
        const author = await createAuthor()
        let refusing = true
        pb.beforeSend = (url: string, options: SendOptions) => {
            if (refusing && url.endsWith('/api/realtime') && options.method === 'POST') {
                options.fetch = refused
            }
            return { url, options }
        }
        const counts = createCountsCollection()
        const { result } = mountCount(counts, author)
        await waitFor(() => expect(result.current.data?.[0]?.book_count).toBe(0))
        await waitFor(() => expect(realtimeClientFor(pb).topics()).toEqual([]))
        refusing = false

        clearAuth()
        await authenticateTestUser()
        await waitFor(() => expect(realtimeClientFor(pb).topics()).toContain(TOPIC))
        await waitFor(() => expect(result.current.data?.[0]?.book_count).toBe(0))
        await confirmTopics()
        await counts.utils.reload()

        await createBook(author)
        await sendSignal(TOPIC)
        await waitFor(() => expect(result.current.data?.[0]?.book_count).toBe(1))
    })

    it('stops retrying a refused topic after cleanup', async () => {
        const topic = 'collection/live_refused_cleanup'
        const author = await createAuthor()
        const keep = await subscribeTopic(pb, 'test/keep', () => undefined)
        try {
            const post = refuseFirstTopicPost(topic)
            const counts = createCountsCollection([topic])
            const { result, unmount } = mountCount(counts, author)
            await waitFor(() => expect(result.current.data).toHaveLength(1))
            await waitFor(() => expect(post.attempts()).toBe(1))
            await waitFor(() => expect(realtimeClientFor(pb).topics()).not.toContain(topic))
            unmount()
            await counts.cleanup()

            reconnectNow()
            // The barrier's subscribe settles after the reconnect's POST,
            // and the reconnect listeners run before it continues.
            await barrier()
            expect(realtimeClientFor(pb).topics()).not.toContain(topic)
            expect(post.attempts()).toBe(1)
        } finally {
            await keep()
        }
    })

    it('leaves a topic whose subscribe resolves after cleanup', async () => {
        const topic = 'collection/live_late'
        const author = await createAuthor()
        const post = gate()
        holdRealtimePost = post.opened
        holdRequests()
        const counts = createCountsCollection([topic])
        const { result, unmount } = mountCount(counts, author)
        await waitFor(() => expect(result.current.data).toHaveLength(1))
        unmount()
        await counts.cleanup()
        expect(realtimeClientFor(pb).topics()).toContain(topic)

        post.open()
        await waitFor(() => expect(realtimeClientFor(pb).topics()).not.toContain(topic))
    })

    it('logs no error for a subscribe that a disconnect refuses after cleanup', async () => {
        const topic = 'collection/live_disconnect'
        const author = await createAuthor()
        const client = realtimeClientFor(pb)
        client.disconnect()
        setRealtimeEventSource(pb, idleSource)
        const subscribe = vi.spyOn(client, 'subscribe')
        const error = vi.spyOn(logger, 'error')
        const counts = createCountsCollection([topic])
        const { result, unmount } = mountCount(counts, author)
        await waitFor(() => expect(result.current.data).toHaveLength(1))
        unmount()
        await counts.cleanup()

        client.disconnect()
        // Its handlers were attached first, so they have run once these settle.
        await Promise.allSettled(subscribe.mock.results.map(call => call.value))
        expect(error).not.toHaveBeenCalledWith(
            'Failed to subscribe to a live topic',
            expect.anything()
        )
    })

    it('drops a window that is open at cleanup', async () => {
        const author = await createAuthor()
        const counts = createCountsCollection()
        const first = mountCount(counts, author)
        await waitFor(() => expect(first.result.current.data?.[0]?.book_count).toBe(0))
        await confirmTopics()
        await counts.utils.reload()
        const windows = holdWindows()
        await sendSignal(TOPIC)
        await barrier()
        expect(windows.count()).toBe(1)
        first.unmount()
        await counts.cleanup()

        // A restarted sync would take the stale window's reload.
        const second = mountCount(counts, author)
        await waitFor(() => expect(second.result.current.data?.[0]?.book_count).toBe(0))
        await confirmTopics()
        await counts.utils.reload()
        const viewRequests = countViewRequests()
        windows.close(0)
        await counts.utils.reload()
        expect(viewRequests()).toBe(1)
    })

    it('refuses an empty topic and a topic over 2500 characters at build', () => {
        expect(() => createCountsCollection([''])).toThrow('liveTopics')
        expect(() => createCountsCollection(['x'.repeat(2501)])).toThrow('liveTopics')
    })
})
