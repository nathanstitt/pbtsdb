import { eq, useLiveQuery } from '@tanstack/react-db'
import type { QueryClient } from '@tanstack/react-query'
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

import { createCollection } from '../src'
import {
    authenticateTestUser,
    clearAuth,
    createTestQueryClient,
    getTestAuthorId,
    getTestSlug,
    pb,
    waitForLoadFinish,
    waitForSubscription,
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
        let subscribeSpy: MockInstance<ReturnType<typeof pb.collection>['subscribe']>

        beforeEach(() => {
            subscribeSpy = vi.spyOn(pb.collection('books'), 'subscribe')
        })

        afterEach(() => {
            subscribeSpy.mockRestore()
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

        const filtersSubscribed = () => subscribeSpy.mock.calls.map(call => call[2]?.filter)

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
            await waitForSubscription(books)

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
            await waitForSubscription(books)

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
            await waitForSubscription(books)
            expect(result.current.data.some(r => r.id === book.id)).toBe(true)

            await pb.collection('books').delete(book.id)
            createdIds.splice(createdIds.indexOf(book.id), 1)
            await waitFor(
                () => expect(result.current.data.some(r => r.id === book.id)).toBe(false),
                { timeout: 8000 }
            )
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
            await waitForSubscription(books)
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
            await waitForSubscription(books)

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

        it('treats a query with no filter as the whole collection', async () => {
            const { books } = make()
            const { result } = renderHook(() => useLiveQuery(q => q.from({ b: books })))
            await waitForLoadFinish(result, 10000)
            await waitForSubscription(books)
            expect(filtersSubscribed()).toEqual([undefined])
        }, 20000)
    })
})
