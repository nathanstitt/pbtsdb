import { and, eq, inArray, useLiveQuery } from '@tanstack/react-db'
import { QueryClient } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    type MockInstance,
    vi,
} from 'vitest'

import { createCollection, realtimeClientFor } from '../src'
import {
    REALTIME_MAX_FILTER_LENGTH,
    REALTIME_TOPIC_MAX_LENGTH,
    realtimeTopicLength,
    subsetFilters,
} from '../src/pocketbase-limits'
import type { RealtimeClient } from '../src/realtime-client'
import {
    authenticateTestUser,
    clearAuth,
    createTestLogger,
    createTestQueryClient,
    getTestAuthorId,
    getTestSlug,
    newRecordId,
    pb,
    resetLogger,
    setLogger,
    topicFilter,
    topicQuery,
    waitForLoadFinish,
} from './helpers'
import type { Schema } from './schema'

describe('realtime mode', () => {
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
    })

    describe('option', () => {
        it("rejects realtime 'query' on an eager collection", () => {
            const c = createCollection<Schema>(pb, queryClient)
            expect(() => c('books', { realtime: 'query' })).toThrow(
                "Collection 'books': realtime 'query' requires syncMode 'on-demand'"
            )
            expect(() => c('books', { syncMode: 'eager', realtime: 'query' })).toThrow(
                "Collection 'books': realtime 'query' requires syncMode 'on-demand'"
            )
        })

        it("accepts realtime 'query' on an on-demand collection", async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const books = c('books', { syncMode: 'on-demand', realtime: 'query' })
            const { result } = renderHook(() => useLiveQuery(q => q.from({ b: books })))
            await waitForLoadFinish(result)
            expect(result.current.data.length).toBeGreaterThan(0)
        }, 15000)
    })

    describe('withRealtime views', () => {
        function make(realtime: 'collection' | 'query' = 'collection') {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', {
                syncMode: 'on-demand',
                realtime,
                relations: { author: authors },
            })
            return { authors, books }
        }

        it('returns the collection itself for the default mode', () => {
            const { books } = make()
            expect(books.withRealtime('collection')).toBe(books)
            const queryBooks = make('query').books
            expect(queryBooks.withRealtime('query')).toBe(queryBooks)
        })

        it('caches a view per mode', () => {
            const { books } = make()
            const view = books.withRealtime('query')
            expect(view).not.toBe(books)
            expect(books.withRealtime('query')).toBe(view)
            expect(view.id).toBe('books?realtime=query')
        })

        it('composes with fetchRelations in either order', () => {
            const { books } = make()
            const a = books.fetchRelations('author').withRealtime('query')
            const b = books.withRealtime('query').fetchRelations('author')
            expect(a).toBe(b)
            expect(a.id).toBe('books?expand=author&realtime=query')
            expect(books.fetchRelations('author').withRealtime('collection')).toBe(
                books.fetchRelations('author')
            )
        })

        it('rejects a second, different mode on a view', () => {
            const { books } = make()
            expect(() => books.withRealtime('query').withRealtime('collection')).toThrow(
                `A view of "books" already uses realtime 'query'`
            )
        })

        it('rejects an unknown mode and query mode on an eager collection', () => {
            const { books } = make()
            expect(() => books.withRealtime('everything' as 'query')).toThrow(
                "Collection 'books': unknown realtime mode 'everything'"
            )
            const eager = createCollection<Schema>(pb, queryClient)('books', {})
            expect(() => eager.withRealtime('query')).toThrow(
                "Collection 'books': realtime 'query' requires syncMode 'on-demand'"
            )
        })
    })

    describe('query mode subscriptions', () => {
        const createdIds: string[] = []
        let subscribeSpy: MockInstance<RealtimeClient['subscribe']>

        beforeEach(() => {
            subscribeSpy = vi.spyOn(realtimeClientFor(pb), 'subscribe')
        })

        afterEach(() => {
            vi.restoreAllMocks()
        })

        afterAll(async () => {
            for (const id of createdIds) {
                try {
                    await pb.collection('books').delete(id)
                } catch (_error) {
                    // Ignore cleanup errors
                }
            }
        })

        const FANTASY = 'genre = "Fantasy"'

        const booksCalls = () =>
            subscribeSpy.mock.calls.filter(call => call[0].startsWith('books/'))

        const filtersSubscribed = () => booksCalls().map(call => topicFilter(call[0]))

        async function seedBook(genre: 'Fantasy' | 'Mystery') {
            const authorId = await getTestAuthorId()
            const book = await pb.collection('books').create({
                title: `Realtime ${getTestSlug('rt')}`,
                isbn: getTestSlug('isbn'),
                genre,
                author: authorId,
                published_date: '',
                page_count: 1,
            })
            createdIds.push(book.id)
            return book
        }

        function make() {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', {
                syncMode: 'on-demand',
                realtime: 'query',
                relations: { author: authors },
            })
            return { authors, books }
        }

        const syncedHas = (collection: object, id: string) =>
            (
                collection as { _state: { syncedData: { has: (k: string) => boolean } } }
            )._state.syncedData.has(id)

        it('subscribes with the query filter and delivers a matching create', async () => {
            const { books } = make()
            const { result } = renderHook(() =>
                useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fantasy')))
            )
            await waitForLoadFinish(result)
            await books.waitForSubscription()

            expect(books.isSubscribed()).toBe(true)
            expect(filtersSubscribed()).toEqual([FANTASY])

            const book = await seedBook('Fantasy')
            await waitFor(
                () => expect(result.current.data.some(r => r.id === book.id)).toBe(true),
                {
                    timeout: 8000,
                }
            )
        }, 20000)

        it('does not deliver a create outside the filter', async () => {
            const { books } = make()
            const { result } = renderHook(() =>
                useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fantasy')))
            )
            await waitForLoadFinish(result)
            await books.waitForSubscription()

            const book = await seedBook('Mystery')
            await new Promise(resolve => setTimeout(resolve, 3000))
            expect(syncedHas(books, book.id)).toBe(false)
        }, 20000)

        it('delivers a delete of a matching row', async () => {
            const book = await seedBook('Fantasy')
            const { books } = make()
            const { result } = renderHook(() =>
                useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fantasy')))
            )
            await waitForLoadFinish(result)
            await books.waitForSubscription()
            expect(result.current.data.some(r => r.id === book.id)).toBe(true)

            await pb.collection('books').delete(book.id)
            createdIds.splice(createdIds.indexOf(book.id), 1)
            await waitFor(
                () => expect(result.current.data.some(r => r.id === book.id)).toBe(false),
                { timeout: 8000 }
            )
        }, 20000)

        // Pins the documented limit: PocketBase checks an update against the
        // row's state after the change, so a row that leaves the filter sends
        // no event. If this test starts failing, PocketBase began sending one
        // and the README note can go.
        it('keeps a row that leaves the filter until the query refetches', async () => {
            const book = await seedBook('Fantasy')
            const { books } = make()
            const { result } = renderHook(() =>
                useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fantasy')))
            )
            await waitForLoadFinish(result)
            await books.waitForSubscription()
            expect(result.current.data.some(r => r.id === book.id)).toBe(true)

            await pb.collection('books').update(book.id, { genre: 'Mystery' })
            await new Promise(resolve => setTimeout(resolve, 3000))
            expect(result.current.data.some(r => r.id === book.id)).toBe(true)
        }, 20000)

        it('shares one filtered subscription between queries with the same filter', async () => {
            const { books } = make()
            const first = renderHook(() =>
                useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fantasy')))
            )
            const second = renderHook(() =>
                useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fantasy')))
            )
            await waitForLoadFinish(first.result)
            await waitForLoadFinish(second.result)
            await books.waitForSubscription()
            expect(filtersSubscribed()).toEqual([FANTASY])

            first.unmount()
            await new Promise(resolve => setTimeout(resolve, 500))
            expect(books.isSubscribed()).toBe(true)

            second.unmount()
            await waitFor(() => expect(books.isSubscribed()).toBe(false), { timeout: 8000 })
            expect(filtersSubscribed()).toEqual([FANTASY])
        }, 20000)

        it('keeps filter entries closed while a collection-mode subscriber is active', async () => {
            const { books } = make()
            const all = renderHook(() =>
                useLiveQuery(q => q.from({ b: books.withRealtime('collection') }))
            )
            await waitForLoadFinish(all.result, 10000)
            await books.waitForSubscription()

            const fantasy = renderHook(() =>
                useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fantasy')))
            )
            await waitForLoadFinish(fantasy.result)
            await new Promise(resolve => setTimeout(resolve, 500))
            expect(filtersSubscribed()).toEqual([undefined])

            all.unmount()
            await waitFor(() => expect(filtersSubscribed()).toEqual([undefined, FANTASY]), {
                timeout: 8000,
            })
            expect(books.isSubscribed()).toBe(true)
        }, 30000)

        it('releases the filtered entry and held targets after a sync cleanup', async () => {
            const { books } = make()
            const { result, unmount } = renderHook(() =>
                useLiveQuery(q =>
                    q
                        .from({ b: books.fetchRelations('author') })
                        .where(({ b }) => eq(b.genre, 'Fantasy'))
                )
            )
            await waitForLoadFinish(result, 10000)
            await books.waitForSubscription()
            await waitFor(() => expect(books.heldRelationTargetCount()).toBe(1))

            await books.cleanup()
            unmount()

            await waitFor(() => expect(books.isSubscribed()).toBe(false), { timeout: 8000 })
            await waitFor(() => expect(books.heldRelationTargetCount()).toBe(0))
        }, 20000)

        it('treats a query with no filter as the whole collection', async () => {
            const { books } = make()
            const { result } = renderHook(() => useLiveQuery(q => q.from({ b: books })))
            await waitForLoadFinish(result, 10000)
            await books.waitForSubscription()
            expect(filtersSubscribed()).toEqual([undefined])
        }, 20000)

        it('restarts filter entries with a wider expand when a fetchRelations view mounts', async () => {
            const { books } = make()
            const plain = renderHook(() =>
                useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fantasy')))
            )
            await waitForLoadFinish(plain.result)
            await books.waitForSubscription()
            expect(booksCalls().map(call => topicQuery(call[0]))).toEqual([{ filter: FANTASY }])

            const expanded = renderHook(() =>
                useLiveQuery(q =>
                    q
                        .from({ b: books.fetchRelations('author') })
                        .where(({ b }) => eq(b.genre, 'Fantasy'))
                )
            )
            await waitForLoadFinish(expanded.result)
            await waitFor(
                () =>
                    expect(topicQuery(booksCalls().at(-1)?.[0] ?? '')).toEqual({
                        filter: FANTASY,
                        expand: 'author',
                    }),
                { timeout: 8000 }
            )
            expect(books.isSubscribed()).toBe(true)
        }, 30000)

        it('opens one entry per chunk of an oversized id subset', async () => {
            const { books } = make()
            const ids = Array.from({ length: 130 }, () => newRecordId())
            const { result } = renderHook(() =>
                useLiveQuery(q => q.from({ b: books }).where(({ b }) => inArray(b.id, ids)))
            )
            await waitForLoadFinish(result, 10000)
            await books.waitForSubscription()

            const filters = filtersSubscribed().filter((f): f is string => f !== undefined)
            expect(filters).toEqual(
                subsetFilters({ field: 'id', values: [...ids].sort() }, REALTIME_MAX_FILTER_LENGTH)
            )
            expect(filters.length).toBeGreaterThan(1)
            for (const filter of filters) {
                const topic = `books/*?options=${encodeURIComponent(JSON.stringify({ query: { filter } }))}`
                expect(topic.length).toBeLessThanOrEqual(2500)
            }
            expect(filters.join(' || ').split(' || ')).toHaveLength(130)
        }, 20000)

        describe('topic cap', () => {
            const logger = createTestLogger()

            beforeEach(() => {
                logger.clear()
                setLogger(logger)
            })

            afterEach(() => {
                resetLogger()
            })

            const tooLong = () =>
                logger.messages.warn.filter(m => m.msg.startsWith('Realtime filter too long'))

            async function expectClientStillSubscribes() {
                const other = createCollection<Schema>(pb, queryClient)('books', {
                    syncMode: 'on-demand',
                    realtime: 'query',
                })
                const probe = renderHook(() =>
                    useLiveQuery(q => q.from({ b: other }).where(({ b }) => eq(b.genre, 'Mystery')))
                )
                await waitForLoadFinish(probe.result)
                await other.waitForSubscription()
                expect(other.isSubscribed()).toBe(true)
                expect(logger.messages.error).toEqual([])
                probe.unmount()
            }

            it('widens to the whole collection when a general filter is over the cap', async () => {
                const { books } = make()
                const ids = Array.from({ length: 60 }, () => newRecordId())
                const { result } = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ b: books })
                            .where(({ b }) => and(inArray(b.id, ids), eq(b.genre, 'Fantasy')))
                    )
                )
                await waitForLoadFinish(result, 10000)
                await books.waitForSubscription()

                expect(filtersSubscribed()).toEqual([undefined])
                expect(books.isSubscribed()).toBe(true)
                expect(tooLong()).toHaveLength(1)
                expect(tooLong()[0].context).toMatchObject({ collectionName: 'books' })
                const { topicLength } = tooLong()[0].context as { topicLength: number }
                expect(topicLength).toBeGreaterThan(REALTIME_TOPIC_MAX_LENGTH)

                await expectClientStillSubscribes()
            }, 30000)

            it('conjoins a factory filter with the query filter when it fits', async () => {
                const base = 'page_count >= 0'
                const c = createCollection<Schema>(pb, queryClient, {
                    subscribeOptions: () => ({ filter: base }),
                })
                const books = c('books', { syncMode: 'on-demand', realtime: 'query' })
                const { result } = renderHook(() =>
                    useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fantasy')))
                )
                await waitForLoadFinish(result)
                await books.waitForSubscription()

                expect(filtersSubscribed()).toEqual([`(${base}) && (${FANTASY})`])
                expect(tooLong()).toEqual([])
            }, 20000)

            it('widens to the whole collection when the conjoined filter is over the cap', async () => {
                const base = `title != "${'x'.repeat(800)}"`
                const c = createCollection<Schema>(pb, queryClient, {
                    subscribeOptions: () => ({ filter: base }),
                })
                const books = c('books', { syncMode: 'on-demand', realtime: 'query' })
                const ids = Array.from({ length: 60 }, () => newRecordId())
                const chunks = subsetFilters(
                    { field: 'id', values: [...ids].sort() },
                    REALTIME_MAX_FILTER_LENGTH
                )
                expect(
                    realtimeTopicLength('books', { filter: `(${base}) && (${chunks[0]})` })
                ).toBeGreaterThan(REALTIME_TOPIC_MAX_LENGTH)
                expect(realtimeTopicLength('books', { filter: base })).toBeLessThanOrEqual(
                    REALTIME_TOPIC_MAX_LENGTH
                )

                const { result } = renderHook(() =>
                    useLiveQuery(q => q.from({ b: books }).where(({ b }) => inArray(b.id, ids)))
                )
                await waitForLoadFinish(result, 10000)
                await books.waitForSubscription()

                expect(filtersSubscribed()).toEqual([base])
                expect(books.isSubscribed()).toBe(true)
                expect(tooLong().length).toBeGreaterThan(0)

                await expectClientStillSubscribes()
            }, 30000)
        })
    })

    describe('held targets in query mode', () => {
        const createdIds: string[] = []

        afterAll(async () => {
            for (const id of createdIds) {
                try {
                    await pb.collection('books').delete(id)
                } catch (_error) {
                    // Ignore cleanup errors
                }
            }
        })

        const callsFor = (spy: MockInstance<RealtimeClient['subscribe']>, collectionName: string) =>
            spy.mock.calls.filter(call => call[0].startsWith(`${collectionName}/`))

        const filtersOf = (
            spy: MockInstance<RealtimeClient['subscribe']>,
            collectionName: string
        ) => callsFor(spy, collectionName).map(call => topicFilter(call[0]))

        const idsIn = (filter: string | undefined) =>
            [...(filter ?? '').matchAll(/id = "([^"]+)"/g)].map(match => match[1]).sort()

        it('subscribes a forward relation target to the filed ids only', async () => {
            const authorsSpy = vi.spyOn(realtimeClientFor(pb), 'subscribe')
            try {
                const c = createCollection<Schema>(pb, queryClient)
                const authors = c('authors', { syncMode: 'on-demand', realtime: 'query' })
                const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })

                const { result } = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ b: books.fetchRelations('author') })
                            .where(({ b }) => eq(b.genre, 'Fantasy'))
                    )
                )
                await waitForLoadFinish(result, 10000)
                await books.waitForSubscription()
                await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 8000 })

                const authorIds = [...new Set(result.current.data.map(b => b.author))].sort()
                expect(authorIds.length).toBeGreaterThan(0)
                await waitFor(
                    () => expect(idsIn(filtersOf(authorsSpy, 'authors').at(-1))).toEqual(authorIds),
                    {
                        timeout: 8000,
                    }
                )
                expect(filtersOf(authorsSpy, 'authors')).not.toContain(undefined)
                expect(filtersOf(authorsSpy, 'authors').at(-1)?.startsWith('id = "')).toBe(true)

                const authorId = authorIds[0]
                const before = await pb.collection('authors').getOne(authorId)
                const renamed = `${before.name} ${getTestSlug('rt')}`
                try {
                    await pb.collection('authors').update(authorId, { name: renamed })
                    await waitFor(() => expect(authors.get(authorId)?.name).toBe(renamed), {
                        timeout: 8000,
                    })
                } finally {
                    await pb.collection('authors').update(authorId, { name: before.name })
                }
            } finally {
                vi.restoreAllMocks()
            }
        }, 30000)

        it('keeps the held filter entry open across the target sync cleanup', async () => {
            const authorsSpy = vi.spyOn(realtimeClientFor(pb), 'subscribe')
            try {
                const c = createCollection<Schema>(pb, queryClient)
                const authors = c('authors', { syncMode: 'on-demand', realtime: 'query' })
                const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })

                const { result, unmount } = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ b: books.fetchRelations('author') })
                            .where(({ b }) => eq(b.genre, 'Fantasy'))
                    )
                )
                await waitForLoadFinish(result, 10000)
                await books.waitForSubscription()
                const authorIds = [...new Set(result.current.data.map(b => b.author))].sort()
                await waitFor(
                    () => expect(idsIn(filtersOf(authorsSpy, 'authors').at(-1))).toEqual(authorIds),
                    {
                        timeout: 8000,
                    }
                )
                await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 8000 })

                await authors.cleanup()
                await new Promise(resolve => setTimeout(resolve, 500))
                expect(books.heldRelationTargetCount()).toBe(1)
                expect(authors.isSubscribed()).toBe(true)

                unmount()
                await waitFor(() => expect(authors.isSubscribed()).toBe(false), { timeout: 8000 })
            } finally {
                vi.restoreAllMocks()
            }
        }, 30000)

        it('re-holds a query-mode target with its filed rows after a cached remount', async () => {
            const authorsSpy = vi.spyOn(realtimeClientFor(pb), 'subscribe')
            const getListSpy = vi.spyOn(pb.collection('books'), 'getList')
            const getFullListSpy = vi.spyOn(pb.collection('books'), 'getFullList')
            const fetches = () => getListSpy.mock.calls.length + getFullListSpy.mock.calls.length
            try {
                const cachingClient = new QueryClient({
                    defaultOptions: { queries: { retry: false, gcTime: 30000, staleTime: 60000 } },
                })
                const c = createCollection<Schema>(pb, cachingClient)
                const authors = c('authors', { syncMode: 'on-demand', realtime: 'query' })
                const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
                const mount = () =>
                    renderHook(() =>
                        useLiveQuery(q =>
                            q
                                .from({ b: books.fetchRelations('author') })
                                .where(({ b }) => eq(b.genre, 'Fantasy'))
                        )
                    )

                const first = mount()
                await waitForLoadFinish(first.result, 10000)
                await books.waitForSubscription()
                const authorIds = [...new Set(first.result.current.data.map(b => b.author))].sort()
                await waitFor(
                    () => expect(idsIn(filtersOf(authorsSpy, 'authors').at(-1))).toEqual(authorIds),
                    {
                        timeout: 8000,
                    }
                )
                const filed = filtersOf(authorsSpy, 'authors').at(-1)

                first.unmount()
                await waitFor(() => expect(authors.isSubscribed()).toBe(false), { timeout: 8000 })
                const callsBefore = callsFor(authorsSpy, 'authors').length
                const fetchesBefore = fetches()

                const second = mount()
                await waitForLoadFinish(second.result, 10000)
                await waitFor(
                    () =>
                        expect(callsFor(authorsSpy, 'authors').length).toBeGreaterThan(callsBefore),
                    { timeout: 8000 }
                )
                expect(filtersOf(authorsSpy, 'authors').slice(callsBefore)).toEqual([filed])
                expect(authors.isSubscribed()).toBe(true)
                expect(fetches()).toBe(fetchesBefore)
                second.unmount()
            } finally {
                vi.restoreAllMocks()
                getListSpy.mockRestore()
                getFullListSpy.mockRestore()
            }
        }, 30000)

        it('opens the grown filter before closing the old one', async () => {
            const events: string[] = []
            const client = realtimeClientFor(pb)
            const realSubscribe = client.subscribe.bind(client)
            const authorsSpy = vi
                .spyOn(client, 'subscribe')
                .mockImplementation(async (topic, listener) => {
                    const unsubscribe = await realSubscribe(topic, listener)
                    if (!topic.startsWith('authors/')) return unsubscribe
                    const filter = topicFilter(topic)
                    events.push(`open ${filter}`)
                    return async () => {
                        events.push(`close ${filter}`)
                        await unsubscribe()
                    }
                })
            const author = await pb.collection('authors').create({
                name: `Growth ${getTestSlug('grow')}`,
                bio: '',
                email: `${getTestSlug('grow')}@example.com`,
            })
            const book = await pb.collection('books').create({
                title: `Growth ${getTestSlug('grow')}`,
                isbn: getTestSlug('isbn'),
                genre: 'Fiction',
                author: author.id,
                published_date: '',
                page_count: 1,
            })
            createdIds.push(book.id)
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand', realtime: 'query' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            let dropped = false
            const poll = setInterval(() => {
                if (!authors.isSubscribed()) dropped = true
            }, 2)
            try {
                const fantasy = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ b: books.fetchRelations('author') })
                            .where(({ b }) => eq(b.genre, 'Fantasy'))
                    )
                )
                await waitForLoadFinish(fantasy.result, 10000)
                await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 8000 })
                const before = filtersOf(authorsSpy, 'authors').at(-1)
                expect(idsIn(before)).not.toContain(author.id)
                dropped = false

                const grown = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ b: books.fetchRelations('author') })
                            .where(({ b }) => eq(b.id, book.id))
                    )
                )
                await waitForLoadFinish(grown.result, 10000)
                await waitFor(() => expect(events).toContain(`close ${before}`), {
                    timeout: 8000,
                })
                const after = filtersOf(authorsSpy, 'authors').at(-1)
                expect(idsIn(after)).toContain(author.id)
                expect(events.indexOf(`open ${after}`)).toBeLessThan(
                    events.indexOf(`close ${before}`)
                )
                expect(dropped).toBe(false)
                expect(authors.isSubscribed()).toBe(true)

                fantasy.unmount()
                grown.unmount()
            } finally {
                clearInterval(poll)
                vi.restoreAllMocks()
                await pb
                    .collection('books')
                    .delete(book.id)
                    .catch(() => {})
                createdIds.splice(createdIds.indexOf(book.id), 1)
                await pb
                    .collection('authors')
                    .delete(author.id)
                    .catch(() => {})
            }
        }, 30000)

        it('subscribes a back-relation target by parent id so new children arrive', async () => {
            const booksSpy = vi.spyOn(realtimeClientFor(pb), 'subscribe')
            try {
                const c = createCollection<Schema>(pb, queryClient)
                const books = c('books', { syncMode: 'on-demand', realtime: 'query' })
                const authors = c('authors', {
                    syncMode: 'on-demand',
                    relations: { books_via_author: books },
                })
                const authorId = await getTestAuthorId()

                const { result } = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ a: authors.fetchRelations('books_via_author') })
                            .where(({ a }) => eq(a.id, authorId))
                    )
                )
                await waitForLoadFinish(result, 10000)
                await authors.waitForSubscription()
                await waitFor(() => expect(callsFor(booksSpy, 'books').length).toBeGreaterThan(0), {
                    timeout: 8000,
                })
                expect(filtersOf(booksSpy, 'books')).toEqual([`author = "${authorId}"`])

                const book = await pb.collection('books').create({
                    title: `Held ${getTestSlug('held')}`,
                    isbn: getTestSlug('isbn'),
                    genre: 'Fiction',
                    author: authorId,
                    published_date: '',
                    page_count: 1,
                })
                createdIds.push(book.id)
                await waitFor(() => expect(books.has(book.id)).toBe(true), { timeout: 8000 })
            } finally {
                vi.restoreAllMocks()
            }
        }, 30000)
    })
})
