import { eq, useLiveQuery } from '@tanstack/react-db'
import { renderHook, waitFor } from '@testing-library/react'
import type { RecordSubscription } from 'pocketbase'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createCollection } from '../src'
import { realtimeClientFor } from '../src/transport'
import {
    authenticateTestUser,
    clearAuth,
    getTestSlug,
    pb,
    topicFilter,
    waitForLoadFinish,
} from './helpers'
import type { Authors, BookMetadata, Books, Schema } from './schema'

/**
 * A row a parent filed into a relation target stays while a parent row in
 * the parent's store files it. It leaves when the last such parent row
 * leaves, when a parent fetch or echo no longer expands it, or when a
 * delete arrives on the hold's realtime topic.
 */
describe('relation filings', () => {
    const created: { collection: string; id: string }[] = []

    beforeAll(async () => {
        await authenticateTestUser()
    })

    afterAll(() => {
        clearAuth()
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        for (const { collection, id } of created.reverse()) {
            await pb
                .collection(collection)
                .delete(id)
                .catch(() => undefined)
        }
        created.length = 0
    })

    async function author(tag: string) {
        const row = await pb.collection('authors').create<Authors>({
            name: `Filing ${getTestSlug(tag)}`,
            bio: '',
            email: `${getTestSlug(tag)}@example.com`,
        })
        created.push({ collection: 'authors', id: row.id })
        return row
    }

    async function book(tag: string, authorId: string) {
        const row = await pb.collection('books').create<Books>({
            title: `Filing ${getTestSlug(tag)}`,
            isbn: getTestSlug(tag),
            genre: 'Fiction',
            author: authorId,
            published_date: '',
            page_count: 1,
        })
        created.push({ collection: 'books', id: row.id })
        return row
    }

    function collections(subsetGcTime = 0) {
        const c = createCollection<Schema>(pb)
        const authors = c('authors', {
            syncMode: 'on-demand',
            realtime: 'query',
            collectionOptions: { gcTime: 60_000 },
        })
        const books = c('books', {
            syncMode: 'on-demand',
            relations: { author: authors },
            alwaysFetchRelations: ['author'],
            subsetGcTime,
            collectionOptions: { gcTime: 60_000 },
        })
        return { authors, books }
    }

    const byId = (books: ReturnType<typeof collections>['books'], id: string) =>
        renderHook(() => useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.id, id))))

    it('a filed row leaves when the last parent row filing it leaves the store', async () => {
        const [a1, a2] = await Promise.all([author('a1'), author('a2')])
        const [b1, b2, keep] = await Promise.all([
            book('b1', a1.id),
            book('b2', a1.id),
            book('k', a2.id),
        ])
        const { authors, books } = collections()
        const q1 = byId(books, b1.id)
        const q2 = byId(books, b2.id)
        const alive = byId(books, keep.id)
        try {
            await waitForLoadFinish(q1.result)
            await waitForLoadFinish(q2.result)
            await waitForLoadFinish(alive.result)
            await books.waitForSubscription()
            expect(authors.get(a1.id)).toBeDefined()

            q1.unmount()
            await waitFor(() => expect(books.get(b1.id)).toBeUndefined(), { timeout: 10000 })
            expect(authors.get(a1.id)).toBeDefined()

            q2.unmount()
            await waitFor(() => expect(books.get(b2.id)).toBeUndefined(), { timeout: 10000 })
            expect(authors.get(a1.id)).toBeUndefined()
            expect(authors.get(a2.id)).toBeDefined()
            expect(books.isSubscribed()).toBe(true)
        } finally {
            q1.unmount()
            q2.unmount()
            alive.unmount()
            await books.cleanup()
            await authors.cleanup()
        }
    }, 40000)

    it('a parent echo whose expand no longer returns a filed row releases it and files the new one', async () => {
        const [a1, a2] = await Promise.all([author('a1'), author('a2')])
        const b1 = await book('b1', a1.id)
        const { authors, books } = collections()
        const q1 = byId(books, b1.id)
        try {
            await waitForLoadFinish(q1.result)
            await books.waitForSubscription()
            expect(authors.get(a1.id)).toBeDefined()

            await pb.collection('books').update(b1.id, { author: a2.id })
            await waitFor(() => expect(authors.get(a2.id)).toBeDefined(), { timeout: 10000 })
            await waitFor(() => expect(authors.get(a1.id)).toBeUndefined(), { timeout: 10000 })
        } finally {
            q1.unmount()
            await books.cleanup()
            await authors.cleanup()
        }
    }, 30000)

    it('a remount within subsetGcTime adopts the parked rows with no request and keeps the filings', async () => {
        const a1 = await author('a1')
        const b1 = await book('b1', a1.id)
        const { authors, books } = collections(5000)
        const getList = vi.spyOn(pb.collection('books'), 'getList')
        const getFullList = vi.spyOn(pb.collection('books'), 'getFullList')
        const requests = () => getList.mock.calls.length + getFullList.mock.calls.length
        const q1 = byId(books, b1.id)
        let q2: ReturnType<typeof byId> | undefined
        try {
            await waitForLoadFinish(q1.result)
            await books.waitForSubscription()
            expect(authors.get(a1.id)).toBeDefined()
            const before = requests()

            q1.unmount()
            expect(books.get(b1.id)).toBeDefined()
            q2 = byId(books, b1.id)
            await waitForLoadFinish(q2.result)
            expect(q2.result.current.data.map(b => b.id)).toEqual([b1.id])
            expect(requests()).toBe(before)
            expect(authors.get(a1.id)).toBeDefined()
        } finally {
            q2?.unmount()
            await books.cleanup()
            await authors.cleanup()
        }
    }, 30000)

    it('a parent is never visible without its relation across an echo that changes it', async () => {
        const [a1, a2] = await Promise.all([author('a1'), author('a2')])
        const b1 = await book('b1', a1.id)
        const { authors, books } = collections()
        const q1 = byId(books, b1.id)
        // At the moment each books change publishes, the author it points at
        // must already be in the authors store: relations land first, the
        // parent second, and the old relation is released after.
        const seen: { author: string; present: boolean }[] = []
        try {
            await waitForLoadFinish(q1.result)
            await books.waitForSubscription()
            expect(authors.get(a1.id)).toBeDefined()
            const subscription = books.subscribeChanges(
                changes => {
                    for (const change of changes) {
                        if (change.key !== b1.id || change.type === 'delete') continue
                        const author = change.value.author
                        seen.push({ author, present: authors.get(author) !== undefined })
                    }
                },
                { includeInitialState: false }
            )

            await pb.collection('books').update(b1.id, { author: a2.id })
            await waitFor(() => expect(books.get(b1.id)?.author).toBe(a2.id), { timeout: 10000 })
            await waitFor(() => expect(authors.get(a1.id)).toBeUndefined(), { timeout: 10000 })
            subscription.unsubscribe()
            expect(seen.map(entry => entry.author)).toContain(a2.id)
            expect(seen.every(entry => entry.present)).toBe(true)
        } finally {
            q1.unmount()
            await books.cleanup()
            await authors.cleanup()
        }
    }, 30000)

    it('a two-level path files every level and releases the whole subtree when the root row leaves', async () => {
        const a1 = await author('a1')
        const b1 = await book('b1', a1.id)
        const m1 = await pb.collection('book_metadata').create<BookMetadata>({
            book: b1.id,
            genre: 'Fiction',
            summary: getTestSlug('m1'),
            language: 'en',
        })
        created.push({ collection: 'book_metadata', id: m1.id })
        const c = createCollection<Schema>(pb)
        const authors = c('authors', {
            syncMode: 'on-demand',
            realtime: 'query',
            collectionOptions: { gcTime: 60_000 },
        })
        const books = c('books', {
            syncMode: 'on-demand',
            realtime: 'query',
            relations: { author: authors },
            collectionOptions: { gcTime: 60_000 },
        })
        const metadata = c('book_metadata', {
            syncMode: 'on-demand',
            relations: { book: books },
            alwaysFetchRelations: ['book.author'],
            subsetGcTime: 0,
            collectionOptions: { gcTime: 60_000 },
        })
        const q1 = renderHook(() =>
            useLiveQuery(q => q.from({ m: metadata }).where(({ m }) => eq(m.id, m1.id)))
        )
        try {
            await waitForLoadFinish(q1.result)
            await metadata.waitForSubscription()
            expect(books.get(b1.id)).toBeDefined()
            expect(authors.get(a1.id)).toBeDefined()

            q1.unmount()
            await waitFor(() => expect(metadata.get(m1.id)).toBeUndefined(), { timeout: 10000 })
            expect(books.get(b1.id)).toBeUndefined()
            expect(authors.get(a1.id)).toBeUndefined()
        } finally {
            q1.unmount()
            await metadata.cleanup()
            await books.cleanup()
            await authors.cleanup()
        }
    }, 30000)

    it("a delete on the hold's realtime topic releases the parent's filing", async () => {
        const handlers = new Map<string, (event: RecordSubscription<Authors>) => void>()
        const client = realtimeClientFor(pb)
        const real = client.subscribe.bind(client)
        vi.spyOn(client, 'subscribe').mockImplementation((topic, listener) => {
            const filter = topic.startsWith('authors/') ? topicFilter(topic) : undefined
            if (filter) {
                handlers.set(
                    filter,
                    listener as unknown as (e: RecordSubscription<Authors>) => void
                )
            }
            return real(topic, listener)
        })
        const a1 = await author('a1')
        const b1 = await book('b1', a1.id)
        const { authors, books } = collections()
        const q1 = byId(books, b1.id)
        try {
            await waitForLoadFinish(q1.result)
            await books.waitForSubscription()
            await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 10000 })
            expect(authors.get(a1.id)).toBeDefined()
            const handler = await (async () => {
                let found: ((event: RecordSubscription<Authors>) => void) | undefined
                await waitFor(() => {
                    found = [...handlers].find(([filter]) => filter.includes(a1.id))?.[1]
                    expect(found).toBeDefined()
                })
                return found
            })()
            if (!handler) throw new Error('no hold topic handler for the filed author')

            handler({
                action: 'delete',
                record: { id: a1.id } as unknown as Authors,
            })
            expect(authors.get(a1.id)).toBeUndefined()
            await waitFor(() => expect(authors.get(a1.id)).toBeUndefined())
        } finally {
            q1.unmount()
            await books.cleanup()
            await authors.cleanup()
        }
    }, 30000)
})
