import {
    and,
    eq,
    type LiveQueryWindowCollection,
    lt,
    materialize,
    useLiveQuery,
} from '@tanstack/react-db'
import type { QueryClient } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCollection, realtimeClientFor } from '../src'
import {
    authenticateTestUser,
    clearAuth,
    createTestQueryClient,
    getTestSlug,
    pb,
    topicFilter,
    waitForLoadFinish,
} from './helpers'
import type { Schema } from './schema'

// Twenty-five books under one fresh author, page_count 1..25, so a sort by
// page_count is total and every window has a known answer.
const COUNT = 25

describe('paging', () => {
    let queryClient: QueryClient
    let authorId = ''
    let authorName = ''
    const bookIds: string[] = []

    beforeAll(async () => {
        await authenticateTestUser()
        const author = await pb.collection('authors').create({
            name: `Paging ${getTestSlug('author')}`,
            email: `${getTestSlug('paging')}@example.com`,
        })
        authorId = author.id
        authorName = author.name
        for (let i = 1; i <= COUNT; i++) {
            const book = await pb.collection('books').create({
                title: `Paging ${i}`,
                isbn: getTestSlug('isbn'),
                genre: 'Fantasy',
                author: authorId,
                page_count: i,
                published_date: '',
            })
            bookIds.push(book.id)
        }
    }, 60000)

    afterAll(async () => {
        for (const id of bookIds)
            await pb
                .collection('books')
                .delete(id)
                .catch(() => {})
        await pb
            .collection('authors')
            .delete(authorId)
            .catch(() => {})
        clearAuth()
    }, 60000)

    beforeEach(() => {
        queryClient = createTestQueryClient()
    })

    afterEach(() => {
        queryClient.clear()
        vi.restoreAllMocks()
    })

    function make() {
        const c = createCollection<Schema>(pb, queryClient)
        const authors = c('authors', { syncMode: 'on-demand', realtime: 'query' })
        const books = c('books', {
            syncMode: 'on-demand',
            realtime: 'query',
            relations: { author: authors },
        })
        return { authors, books }
    }

    const pageCounts = (rows: readonly { page_count: number }[]) => rows.map(r => r.page_count)

    it('load-more fetches only the delta, with the cursor in the filter', async () => {
        const { books } = make()
        const getList = vi.spyOn(pb.collection('books'), 'getList')
        const { result } = renderHook(() =>
            useLiveQuery(q =>
                q
                    .from({ b: books })
                    .where(({ b }) => eq(b.author, authorId))
                    .orderBy(({ b }) => b.page_count, 'asc')
                    .limit(10)
            )
        )
        await waitForLoadFinish(result)
        expect(pageCounts(result.current.data)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
        getList.mockClear()

        const windowed = result.current.collection as LiveQueryWindowCollection
        const settled = windowed.utils.setWindow({ offset: 0, limit: 20 })
        if (settled !== true) await settled
        await waitFor(() => expect(result.current.data.length).toBe(20))
        expect(pageCounts(result.current.data)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))

        // Exactly two requests: the cursor delta, plus TanStack's
        // OrderedSourceLoader boundary tie-check for rows sharing the new
        // window edge's exact sort value (`page_count = 20`, no
        // `orderBy`/`limit`). A regression that re-fetches the prefix instead
        // of the delta would add a third call (or change the delta's shape),
        // so both calls are asserted, not just filtered down to the one we
        // expect to find.
        expect(getList).toHaveBeenCalledTimes(2)
        const deltaCalls = getList.mock.calls.filter(([, , options]) =>
            /page_count [><]=? \d+/.test((options?.filter as string | undefined) ?? '')
        )
        expect(deltaCalls).toHaveLength(1)
        const [, perPage, options] = deltaCalls[0]
        expect(perPage).toBeLessThanOrEqual(10)
        expect(options?.filter).toContain(`author = "${authorId}"`)

        const boundaryCalls = getList.mock.calls.filter(([, , options]) =>
            /page_count = 20\b/.test((options?.filter as string | undefined) ?? '')
        )
        expect(boundaryCalls).toHaveLength(1)
        expect(boundaryCalls[0][2]?.filter).toContain(`author = "${authorId}"`)
    }, 30000)

    it('setWindow to a deep window shows that window', async () => {
        const { books } = make()
        const getList = vi.spyOn(pb.collection('books'), 'getList')
        const { result } = renderHook(() =>
            useLiveQuery(q =>
                q
                    .from({ b: books })
                    .where(({ b }) => eq(b.author, authorId))
                    .orderBy(({ b }) => b.page_count, 'asc')
                    .limit(10)
            )
        )
        await waitForLoadFinish(result)
        getList.mockClear()

        const windowed = result.current.collection as LiveQueryWindowCollection
        const settled = windowed.utils.setWindow({ offset: 10, limit: 10 })
        if (settled !== true) await settled
        await waitFor(() =>
            expect(pageCounts(result.current.data)).toEqual([
                11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
            ])
        )

        // Documents which path TanStack took: like the load-more test, it
        // asks for the delta via a cursor on the sort field, not a raw
        // offset page.
        const [, perPage, options] = getList.mock.calls[0]
        expect(perPage).toBeLessThanOrEqual(10)
        expect(options?.filter).toMatch(/page_count [><]=? \d+/)
    }, 30000)

    it('delivers a create echo to a sorted limited query and files its relation', async () => {
        const { authors, books } = make()
        const subscribe = vi.spyOn(realtimeClientFor(pb), 'subscribe')
        const { result } = renderHook(() =>
            useLiveQuery(q =>
                q
                    .from({ b: books.fetchRelations('author') })
                    .where(({ b }) => eq(b.author, authorId))
                    .orderBy(({ b }) => b.page_count, 'desc')
                    .limit(5)
                    .select(({ b }) => ({
                        ...b,
                        author: materialize(
                            q
                                .from({ a: authors })
                                .where(({ a }) => eq(a.id, b.author))
                                .findOne()
                        ),
                    }))
            )
        )
        await waitForLoadFinish(result)
        await books.waitForSubscription()
        expect(pageCounts(result.current.data)).toEqual([25, 24, 23, 22, 21])
        expect(result.current.data[0].author?.id).toBe(authorId)

        // The subscription carries the where only: no sort, limit, or cursor.
        const filters = subscribe.mock.calls
            .filter(call => call[0].startsWith('books/'))
            .map(call => topicFilter(call[0]))
        expect(filters).toEqual([`author = "${authorId}"`])

        const created = await pb.collection('books').create({
            title: 'Paging 100',
            isbn: getTestSlug('isbn'),
            genre: 'Fantasy',
            author: authorId,
            page_count: 100,
            published_date: '',
        })
        try {
            await waitFor(() =>
                expect(pageCounts(result.current.data)).toEqual([100, 25, 24, 23, 22])
            )
            expect(result.current.data[0].author?.name).toContain('Paging')
        } finally {
            await pb.collection('books').delete(created.id)
        }
    }, 30000)

    it('a cursor in the where subscribes to its slice only', async () => {
        const { books } = make()
        const subscribe = vi.spyOn(realtimeClientFor(pb), 'subscribe')
        const { result } = renderHook(() =>
            useLiveQuery(q =>
                q
                    .from({ b: books })
                    .where(({ b }) => and(eq(b.author, authorId), lt(b.page_count, 10)))
                    .orderBy(({ b }) => b.page_count, 'desc')
                    .limit(5)
            )
        )
        await waitForLoadFinish(result)
        await books.waitForSubscription()
        expect(pageCounts(result.current.data)).toEqual([9, 8, 7, 6, 5])
        const filters = subscribe.mock.calls
            .filter(call => call[0].startsWith('books/'))
            .map(call => topicFilter(call[0]))
        expect(filters).toEqual([`(author = "${authorId}" && page_count < 10)`])

        const created: string[] = []
        try {
            const outside = await pb.collection('books').create({
                title: 'Paging 50',
                isbn: getTestSlug('isbn'),
                genre: 'Fantasy',
                author: authorId,
                page_count: 50,
                published_date: '',
            })
            created.push(outside.id)
            const inside = await pb.collection('books').create({
                title: 'Paging 9.5',
                isbn: getTestSlug('isbn'),
                genre: 'Fantasy',
                author: authorId,
                page_count: 9.5,
                published_date: '',
            })
            created.push(inside.id)

            await waitFor(() => expect(pageCounts(result.current.data)).toEqual([9.5, 9, 8, 7, 6]))
            expect(books.has(outside.id)).toBe(false)
        } finally {
            for (const id of created) await pb.collection('books').delete(id)
        }
    }, 30000)

    it('a filtered join source subscribes to its id batch', async () => {
        const { authors, books } = make()
        const subscribe = vi.spyOn(realtimeClientFor(pb), 'subscribe')
        // TanStack makes `authors` (the `.from()` side) the lazy source here and
        // loads it by an `in(id, …)` batch of the Fantasy books' authors. The
        // seed data (pb_migrations/1763864662_seed_test_data.js) holds Fantasy
        // books by other authors, so the batch carries more than one id and
        // compiles to an `||` filter; without that seed row there is no `||`.
        const { result } = renderHook(() =>
            useLiveQuery(q =>
                q
                    .from({ a: authors })
                    .where(({ a }) => eq(a.id, authorId))
                    .innerJoin(
                        { b: q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fantasy')) },
                        ({ a, b }) => eq(b.author, a.id)
                    )
                    .select(({ a, b }) => ({ ...b, authorName: a.name }))
            )
        )
        await waitForLoadFinish(result)
        await authors.waitForSubscription()
        expect(result.current.data.length).toBeGreaterThan(0)
        expect(result.current.data[0].authorName).toBe(authorName)

        // The subscription's own where (`id = authorId`) must not be
        // displaced by the join's id batch; dropping it would leave rows the
        // base query itself asked for uncovered by realtime.
        const filters = subscribe.mock.calls
            .filter(call => call[0].startsWith('authors/'))
            .map(call => topicFilter(call[0]))
        const idFilters = filters.filter(f => f?.includes('||'))
        expect(idFilters.length).toBeGreaterThan(0)
        for (const filter of idFilters) {
            expect(filter).toContain(`id = "${authorId}"`)
        }
    }, 30000)

    it('a lazy source joined by its foreign key subscribes to that key', async () => {
        const { authors, books } = make()
        const bookSubscribe = vi.spyOn(realtimeClientFor(pb), 'subscribe')
        const { result } = renderHook(() =>
            useLiveQuery(q =>
                q
                    .from({ a: authors })
                    .where(({ a }) => eq(a.id, authorId))
                    .join({ b: books }, ({ a, b }) => eq(b.author, a.id))
                    .select(({ a, b }) => ({ authorName: a.name, title: b?.title }))
            )
        )
        await waitForLoadFinish(result)
        await books.waitForSubscription()
        expect(result.current.data).toHaveLength(COUNT)
        expect(result.current.data[0].authorName).toBe(authorName)

        // `books` is the lazy side: TanStack loads it by `in(author, [authorId])`,
        // a batch keyed on the foreign key. That key must reach the subscribe
        // filter; folding it into `books`' empty base where would widen
        // realtime to the whole collection.
        const filters = bookSubscribe.mock.calls
            .filter(call => call[0].startsWith('books/'))
            .map(call => topicFilter(call[0]))
        expect(filters).toContain(`author = "${authorId}"`)
        expect(filters).not.toContain(undefined)
    }, 30000)

    it('an unfiltered sorted, limited query opens no extra entry for the tie-check', async () => {
        const { books } = make()
        const subscribe = vi.spyOn(realtimeClientFor(pb), 'subscribe')
        const { result } = renderHook(() =>
            useLiveQuery(q =>
                q
                    .from({ b: books })
                    .orderBy(({ b }) => b.page_count, 'desc')
                    .limit(5)
            )
        )
        await waitForLoadFinish(result)
        await books.waitForSubscription()

        const filters = subscribe.mock.calls
            .filter(call => call[0].startsWith('books/'))
            .map(call => topicFilter(call[0]))
        expect(filters).toEqual([undefined])
    }, 30000)
})
