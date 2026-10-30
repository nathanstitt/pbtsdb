import { eq, useLiveQuery } from '@tanstack/react-db'
import { renderHook, waitFor } from '@testing-library/react'
import type { SendOptions } from 'pocketbase'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createCollection } from '../src'
import {
    disconnectRealtime,
    realtimeClientFor,
    resetRealtime,
    setRealtimeBackoff,
    transportFor,
} from '../src/transport'
import {
    authenticateTestUser,
    clearAuth,
    createAuthorsCollection,
    createBooksCollection,
    getTestSlug,
    newRecordId,
    pb,
    waitForLoadFinish,
} from './helpers'
import type { Schema } from './schema'

const isAuthorBooksTopic = (topic: string, author: string) =>
    topic.startsWith('books/') && topic.includes(author)

// Fails the first subscriptions POST that carries the books topic of
// `author` with a 500, and holds the second until `release` is called.
function failFirstBooksPost(author: string) {
    let release: () => void = () => undefined
    const released = new Promise<void>(resolve => {
        release = resolve
    })
    let attempts = 0
    pb.beforeSend = async (url: string, options: SendOptions) => {
        const body = options.body as { subscriptions?: string[] } | undefined
        if (
            url.endsWith('/api/realtime') &&
            options.method === 'POST' &&
            body?.subscriptions?.some(topic => isAuthorBooksTopic(topic, author))
        ) {
            attempts += 1
            if (attempts === 1) {
                options.fetch = () =>
                    Promise.resolve(
                        new Response(JSON.stringify({ message: 'Unavailable.' }), {
                            status: 500,
                            headers: { 'Content-Type': 'application/json' },
                        })
                    )
            }
            if (attempts === 2) await released
        }
        return { url, options }
    }
    return { attempts: () => attempts, release }
}

async function createAuthor(): Promise<string> {
    const author = newRecordId()
    await pb.collection('authors').create({ id: author, name: author, email: `${author}@gap.test` })
    return author
}

async function createBook(author: string): Promise<string> {
    const id = newRecordId()
    await pb.collection('books').create({
        id,
        title: 'Gap',
        isbn: getTestSlug('isbn'),
        genre: 'Fiction',
        author,
        page_count: 1,
        published_date: '',
    })
    return id
}

describe('reconnect refetch lifecycle', () => {
    beforeAll(async () => {
        await authenticateTestUser()
    })

    afterAll(() => {
        clearAuth()
    })

    it('registers its reconnect listener while syncing and removes it on cleanup', async () => {
        const reconnectListenerCount = () => transportFor(pb).reconnectListenerCount()
        const baseline = reconnectListenerCount()

        const books = createBooksCollection()
        expect(reconnectListenerCount()).toBe(baseline)

        const { result } = renderHook(() => useLiveQuery(q => q.from({ books })))
        await waitForLoadFinish(result)
        await books.waitForSubscription()

        await waitFor(() => expect(reconnectListenerCount()).toBe(baseline + 1))

        await books.cleanup()

        await waitFor(() => expect(reconnectListenerCount()).toBe(baseline))
    }, 20000)

    it('tracks two collections on the same pb independently', async () => {
        const reconnectListenerCount = () => transportFor(pb).reconnectListenerCount()
        const baseline = reconnectListenerCount()

        const books = createBooksCollection()
        const authors = createAuthorsCollection()

        const booksHook = renderHook(() => useLiveQuery(q => q.from({ books })))
        await waitForLoadFinish(booksHook.result)
        await books.waitForSubscription()
        await waitFor(() => expect(reconnectListenerCount()).toBe(baseline + 1))

        const authorsHook = renderHook(() => useLiveQuery(q => q.from({ authors })))
        await waitForLoadFinish(authorsHook.result)
        await authors.waitForSubscription()
        await waitFor(() => expect(reconnectListenerCount()).toBe(baseline + 2))

        await authors.cleanup()
        await waitFor(() => expect(reconnectListenerCount()).toBe(baseline + 1))

        await books.cleanup()
        await waitFor(() => expect(reconnectListenerCount()).toBe(baseline))
    }, 20000)

    it('refetches a ready, open collection after a non-resumed reconnect', async () => {
        const books = createBooksCollection()
        const { result } = renderHook(() => useLiveQuery(q => q.from({ books })))
        await waitForLoadFinish(result)
        await books.waitForSubscription()

        const getFullList = vi.spyOn(pb.collection('books'), 'getFullList')
        getFullList.mockClear()

        realtimeClientFor(pb).simulateDisconnect()
        await waitFor(() => expect(getFullList).toHaveBeenCalledTimes(1), { timeout: 10000 })

        await books.cleanup()
        getFullList.mockRestore()
    }, 20000)

    it('does not refetch a collection that is not ready when the connection reconnects', async () => {
        // Holds the collection's first load open, so its reconnect listener
        // registers (status 'loading') while `isReady()` is still false.
        let releaseFirstLoad: (() => void) | undefined
        const firstLoadGate = new Promise<void>(resolve => {
            releaseFirstLoad = resolve
        })
        const booksService = pb.collection('books')
        const original = booksService.getFullList.bind(booksService)
        const getFullList = vi.spyOn(booksService, 'getFullList')
        getFullList.mockImplementation(async (...args) => {
            await firstLoadGate
            return original(...args)
        })

        const books = createBooksCollection()
        const { result } = renderHook(() => useLiveQuery(q => q.from({ books })))

        await waitFor(() => {
            expect((books as unknown as { isSubscribed: () => boolean }).isSubscribed()).toBe(true)
        })
        expect((books as unknown as { isReady: () => boolean }).isReady()).toBe(false)

        const idBeforeDisconnect = realtimeClientFor(pb).clientId()
        realtimeClientFor(pb).simulateDisconnect()
        await waitFor(() => expect(realtimeClientFor(pb).clientId()).not.toBe(idBeforeDisconnect), {
            timeout: 10000,
        })
        expect(getFullList).toHaveBeenCalledTimes(1)

        releaseFirstLoad?.()
        await waitForLoadFinish(result)
        const callsBeforeReadyReconnect = getFullList.mock.calls.length
        expect(callsBeforeReadyReconnect).toBe(1)

        const idBeforeReadyReconnect = realtimeClientFor(pb).clientId()
        realtimeClientFor(pb).simulateDisconnect()
        await waitFor(
            () => expect(realtimeClientFor(pb).clientId()).not.toBe(idBeforeReadyReconnect),
            { timeout: 10000 }
        )
        await waitForLoadFinish(result)
        await waitFor(
            () => expect(getFullList).toHaveBeenCalledTimes(callsBeforeReadyReconnect + 1),
            { timeout: 10000 }
        )
        getFullList.mockRestore()
        await books.cleanup()
    }, 20000)

    it('resets the session and reloads when the auth record changes, not on a same-record change', async () => {
        const books = createBooksCollection()
        const { result } = renderHook(() => useLiveQuery(q => q.from({ books })))
        await waitForLoadFinish(result)
        await books.waitForSubscription()
        const getFullList = vi.spyOn(pb.collection('books'), 'getFullList')
        getFullList.mockClear()
        try {
            const idBeforeSave = realtimeClientFor(pb).clientId()
            pb.authStore.save(pb.authStore.token, pb.authStore.record)
            await new Promise(resolve => setTimeout(resolve, 200))
            expect(realtimeClientFor(pb).clientId()).toBe(idBeforeSave)
            expect(getFullList).not.toHaveBeenCalled()

            clearAuth()
            await waitFor(() => expect(realtimeClientFor(pb).clientId()).not.toBe(idBeforeSave), {
                timeout: 10000,
            })
            await waitFor(() => expect(getFullList).toHaveBeenCalledTimes(1), { timeout: 10000 })
        } finally {
            await authenticateTestUser()
            await waitFor(() => expect(books.isSubscribed()).toBe(true), { timeout: 10000 })
            await books.cleanup()
            getFullList.mockRestore()
        }
    }, 30000)

    it('an auth record change releases waiting subsets so a remount fetches', async () => {
        const books = createCollection<Schema>(pb)('books', {
            syncMode: 'on-demand',
            subsetGcTime: 5000,
        })
        const mount = () =>
            renderHook(() =>
                useLiveQuery(q =>
                    q.from({ books }).where(({ books }) => eq(books.genre, 'Fiction'))
                )
            )
        const getList = vi.spyOn(pb.collection('books'), 'getList')
        const getFullList = vi.spyOn(pb.collection('books'), 'getFullList')
        const requests = () => getList.mock.calls.length + getFullList.mock.calls.length
        const first = mount()
        let second: ReturnType<typeof mount> | undefined
        try {
            await waitForLoadFinish(first.result)
            await books.waitForSubscription()
            first.unmount()
            const before = requests()

            const record = pb.authStore.record
            if (!record) throw new Error('not authenticated')
            pb.authStore.save(pb.authStore.token, { ...record, id: 'other0000000000' })
            second = mount()
            await waitForLoadFinish(second.result)
            expect(requests()).toBeGreaterThan(before)
        } finally {
            second?.unmount()
            await authenticateTestUser()
            await books.cleanup()
            getList.mockRestore()
            getFullList.mockRestore()
        }
    }, 30000)

    it('an auth change followed at once by disconnectRealtime still reloads under the new auth', async () => {
        const books = createBooksCollection()
        const { result } = renderHook(() => useLiveQuery(q => q.from({ books })))
        await waitForLoadFinish(result)
        await books.waitForSubscription()
        const getFullList = vi.spyOn(pb.collection('books'), 'getFullList')
        getFullList.mockClear()
        try {
            const record = pb.authStore.record
            if (!record) throw new Error('not authenticated')
            pb.authStore.save(pb.authStore.token, { ...record, id: 'other0000000001' })
            disconnectRealtime(pb)
            await waitFor(() => expect(getFullList).toHaveBeenCalledTimes(1), { timeout: 10000 })
            await new Promise(resolve => setTimeout(resolve, 300))
            expect(realtimeClientFor(pb).isConnected()).toBe(false)
        } finally {
            resetRealtime(pb)
            await authenticateTestUser()
            await books.cleanup()
            getFullList.mockRestore()
        }
    }, 30000)

    it('disconnectRealtime keeps the connection closed until resetRealtime, which reloads', async () => {
        const books = createBooksCollection()
        const { result } = renderHook(() => useLiveQuery(q => q.from({ books })))
        await waitForLoadFinish(result)
        await books.waitForSubscription()
        const getFullList = vi.spyOn(pb.collection('books'), 'getFullList')
        getFullList.mockClear()
        try {
            disconnectRealtime(pb)
            expect(realtimeClientFor(pb).isConnected()).toBe(false)
            await new Promise(resolve => setTimeout(resolve, 500))
            expect(realtimeClientFor(pb).isConnected()).toBe(false)
            expect(getFullList).not.toHaveBeenCalled()

            resetRealtime(pb)
            await waitFor(() => expect(realtimeClientFor(pb).isConnected()).toBe(true), {
                timeout: 10000,
            })
            await waitFor(() => expect(getFullList).toHaveBeenCalledTimes(1), { timeout: 10000 })
        } finally {
            resetRealtime(pb)
            await books.cleanup()
            getFullList.mockRestore()
        }
    }, 30000)

    it('resetRealtime reconnects a ready, subscribed collection and triggers one refetch', async () => {
        const books = createBooksCollection()
        const { result } = renderHook(() => useLiveQuery(q => q.from({ books })))
        await waitForLoadFinish(result)
        await books.waitForSubscription()
        expect((books as unknown as { isSubscribed: () => boolean }).isSubscribed()).toBe(true)

        const getFullList = vi.spyOn(pb.collection('books'), 'getFullList')
        getFullList.mockClear()

        const idBeforeReset = realtimeClientFor(pb).clientId()
        resetRealtime(pb)
        await waitFor(() => expect(realtimeClientFor(pb).clientId()).not.toBe(idBeforeReset), {
            timeout: 10000,
        })
        await waitFor(
            () =>
                expect((books as unknown as { isSubscribed: () => boolean }).isSubscribed()).toBe(
                    true
                ),
            { timeout: 10000 }
        )
        await waitFor(() => expect(getFullList).toHaveBeenCalledTimes(1), { timeout: 10000 })

        await books.cleanup()
        getFullList.mockRestore()
    }, 20000)

    describe('a subscriptions POST that fails with a 500', () => {
        const originalBeforeSend = pb.beforeSend
        const built: { cleanup: () => Promise<void> }[] = []

        afterEach(async () => {
            pb.beforeSend = originalBeforeSend
            setRealtimeBackoff(pb, undefined)
            await Promise.all(built.splice(0).map(collection => collection.cleanup()))
        })

        // Each test filters on a new author, so its topic is new to the
        // connection and its subscribe always sends a POST.
        async function mountAuthorBooks() {
            const author = await createAuthor()
            const post = failFirstBooksPost(author)
            const books = createCollection<Schema>(pb)('books', {
                syncMode: 'on-demand',
                realtime: 'query',
            })
            built.push(books)
            const hook = renderHook(() =>
                useLiveQuery(q => q.from({ books }).where(({ books }) => eq(books.author, author)))
            )
            await waitForLoadFinish(hook.result)
            const hasTopic = () =>
                realtimeClientFor(pb)
                    .topics()
                    .some(topic => isAuthorBooksTopic(topic, author))
            return { author, post, books, hook, hasTopic }
        }

        it('keeps the record subscription, which opens on the reconnect and reloads the gap', async () => {
            setRealtimeBackoff(pb, () => 0)
            const { author, post, books, hook, hasTopic } = await mountAuthorBooks()
            const ids = () => hook.result.current.data?.map(book => book.id)

            // The reconnect's POST carries the kept topic; it is held here.
            await waitFor(() => expect(post.attempts()).toBe(2))
            expect(hasTopic()).toBe(true)
            expect(books.isSubscribed()).toBe(false)

            // Written before the server has the topic: only a reload brings it in.
            const gap = await createBook(author)
            post.release()
            await waitFor(() => expect(ids()).toContain(gap))

            await books.waitForSubscription()
            const live = await createBook(author)
            await waitFor(() => expect(ids()).toContain(live))
        })

        it('leaves no topic when the collection is cleaned up while the subscription waits', async () => {
            setRealtimeBackoff(pb, () => 60_000)
            const { post, books, hook, hasTopic } = await mountAuthorBooks()
            await waitFor(() => expect(post.attempts()).toBe(1))
            await waitFor(() => expect(realtimeClientFor(pb).status().state).toBe('reconnecting'))
            expect(hasTopic()).toBe(true)

            hook.unmount()
            await books.cleanup()
            await waitFor(() => expect(hasTopic()).toBe(false))
            // A POST made now carries every topic still registered.
            const unsubscribe = await realtimeClientFor(pb).subscribe('test/probe', () => undefined)
            await unsubscribe()
            expect(post.attempts()).toBe(1)
        })
    })
})
