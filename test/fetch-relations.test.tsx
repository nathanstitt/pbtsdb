import { and, eq, inArray, materialize, useLiveQuery } from '@tanstack/react-db'
import type { QueryClient } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import PocketBase from 'pocketbase'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createCollection } from '../src'
import {
    authenticateTestUser,
    clearAuth,
    createTestLogger,
    createTestQueryClient,
    getTestAuthorId,
    getTestSlug,
    pb,
    resetLogger,
    setLogger,
    waitForLoadFinish,
} from './helpers'
import type { Schema } from './schema'

describe('Fetch relations', () => {
    let queryClient: QueryClient
    const testLogger = createTestLogger()

    beforeAll(async () => {
        await authenticateTestUser()
        setLogger(testLogger)
    })

    afterAll(() => {
        clearAuth()
        resetLogger()
    })

    beforeEach(() => {
        queryClient = createTestQueryClient()
        testLogger.clear()
    })

    afterEach(() => {
        queryClient.clear()
        vi.restoreAllMocks()
    })

    describe('rows never carry expand', () => {
        it('files the expanded record and strips it from the stored and live rows', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', {
                syncMode: 'on-demand',
                relations: { author: authors },
                alwaysFetchRelations: ['author'],
            })
            const { result } = renderHook(() =>
                useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.title, 'Animal Farm')))
            )
            await waitForLoadFinish(result, 10000)
            const row = result.current.data[0]
            expect((row as { expand?: unknown }).expand).toBeUndefined()
            await waitFor(() => expect(authors.has(row.author)).toBe(true))
            const stored = (
                books as unknown as { _state: { syncedData: Map<string, { expand?: unknown }> } }
            )._state.syncedData.get(row.id)
            expect(stored?.expand).toBeUndefined()
            const cached = queryClient
                .getQueryCache()
                .findAll({ queryKey: ['books'] })
                .flatMap(
                    query => (query.state.data as Array<{ expand?: unknown }> | undefined) ?? []
                )
            expect(cached.every(item => item.expand === undefined)).toBe(true)
        }, 15000)

        it('strips nested paths and files every level', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            const metadata = c('book_metadata', {
                syncMode: 'on-demand',
                relations: { book: books },
                alwaysFetchRelations: ['book.author'],
            })
            const { result } = renderHook(() => useLiveQuery(q => q.from({ m: metadata })))
            await waitForLoadFinish(result, 10000)
            const row = result.current.data[0]
            expect((row as { expand?: unknown }).expand).toBeUndefined()
            await waitFor(() => {
                expect(books.has(row.book)).toBe(true)
                const book = books.get(row.book) as { author: string; expand?: unknown } | undefined
                expect(book?.expand).toBeUndefined()
                expect(authors.has(book?.author ?? '')).toBe(true)
            })
        }, 15000)

        it('strips a realtime echo after filing its expanded records', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', {
                syncMode: 'on-demand',
                relations: { author: authors },
                alwaysFetchRelations: ['author'],
            })
            const authorId = await getTestAuthorId()
            const seed = await pb.collection('books').create({
                title: `Strip ${getTestSlug('st')}`,
                isbn: getTestSlug('isbn'),
                genre: 'Fiction',
                author: authorId,
                published_date: '',
                page_count: 1,
            })
            try {
                const { result } = renderHook(() =>
                    useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.id, seed.id)))
                )
                await waitForLoadFinish(result, 10000)
                await books.waitForSubscription(10000)
                await pb.collection('books').update(seed.id, { title: 'Echoed' })
                await waitFor(() => expect(result.current.data[0]?.title).toBe('Echoed'))
                expect((result.current.data[0] as { expand?: unknown }).expand).toBeUndefined()
                await waitFor(() => expect(authors.has(authorId)).toBe(true))
            } finally {
                await pb.collection('books').delete(seed.id)
            }
        }, 20000)

        it('leaves expand keys pbtsdb did not request on an echo', async () => {
            const client = new PocketBase(process.env.TESTING_PB_ADDR)
            client.autoCancellation(false)
            await client
                .collection('users')
                .authWithPassword(process.env.TEST_USER_EMAIL ?? '', process.env.TEST_USER_PW ?? '')
            const c = createCollection<Schema>(client, queryClient, {
                subscribeOptions: () => ({ expand: 'author' }),
            })
            const books = c('books', { syncMode: 'on-demand' })
            const authorId = await getTestAuthorId()
            const seed = await pb.collection('books').create({
                title: `Keep ${getTestSlug('kp')}`,
                isbn: getTestSlug('isbn'),
                genre: 'Fiction',
                author: authorId,
                published_date: '',
                page_count: 1,
            })
            try {
                const { result } = renderHook(() =>
                    useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.id, seed.id)))
                )
                await waitForLoadFinish(result, 10000)
                await books.waitForSubscription(10000)
                await pb.collection('books').update(seed.id, { title: 'Echoed' })
                await waitFor(() => expect(result.current.data[0]?.title).toBe('Echoed'))
                const row = result.current.data[0] as { expand?: { author?: { id: string } } }
                expect(row.expand?.author?.id).toBe(authorId)
            } finally {
                await pb.collection('books').delete(seed.id)
            }
        }, 20000)
    })

    describe('alwaysFetchRelations', () => {
        it('rejects an undeclared path at creation', () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', {})
            expect(() =>
                // @ts-expect-error runtime check of an undeclared path
                c('books', { relations: { author: authors }, alwaysFetchRelations: ['nope'] })
            ).toThrow('Cannot expand "nope" on collection "books"')
            // @ts-expect-error runtime check without relations
            expect(() => c('books', { alwaysFetchRelations: ['author'] })).toThrow(
                'no relations declared'
            )
        })

        it('expands nested paths and upserts each level into its target', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            const metadata = c('book_metadata', {
                syncMode: 'on-demand',
                relations: { book: books },
                alwaysFetchRelations: ['book.author'],
            })

            const { result } = renderHook(() => useLiveQuery(q => q.from({ m: metadata })))
            await waitForLoadFinish(result, 10000)

            const row = result.current.data[0]
            expect((row as { expand?: unknown }).expand).toBeUndefined()

            await waitFor(() => {
                expect(books.has(row.book)).toBe(true)
                const book = books.get(row.book) as { author: string; expand?: unknown } | undefined
                expect(book?.expand).toBeUndefined()
                expect(authors.has(book?.author ?? '')).toBe(true)
            })
        }, 15000)

        it('exposes relation targets for nested validation', () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', {})
            const books = c('books', { relations: { author: authors } })
            expect(books.relationTargets?.author).toBe(authors)
            expect(authors.relationTargets).toBeUndefined()
        })
    })

    describe('query keys', () => {
        it('keys on-demand subsets by the PocketBase request', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', {})
            const books = c('books', {
                syncMode: 'on-demand',
                relations: { author: authors },
                alwaysFetchRelations: ['author'],
            })

            const { result } = renderHook(() =>
                useLiveQuery(q =>
                    q
                        .from({ books })
                        .where(({ books }) => eq(books.genre, 'Fiction'))
                        .orderBy(({ books }) => books.title)
                        .limit(2)
                )
            )
            await waitForLoadFinish(result, 10000)

            const keys = queryClient
                .getQueryCache()
                .findAll({ queryKey: ['books'] })
                .map(query => query.queryKey)
            expect(keys).toContainEqual([
                'books',
                { subset: { field: 'genre', values: ['Fiction'] }, sort: 'title', limit: 2 },
            ])
        }, 15000)
    })

    describe('views (on-demand)', () => {
        function make() {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const tags = c('tags', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            const bookTags = c('book_tags', {
                syncMode: 'on-demand',
                relations: { book: books, tag: tags },
            })
            return { authors, tags, books, bookTags }
        }

        it('expands per query and upserts into the target', async () => {
            const { authors, books } = make()
            const view = books.fetchRelations('author')

            const { result } = renderHook(() =>
                useLiveQuery(q =>
                    q.from({ books: view }).where(({ books }) => eq(books.title, 'Animal Farm'))
                )
            )
            await waitForLoadFinish(result, 10000)

            const book = result.current.data[0]
            expect((book as { expand?: unknown }).expand).toBeUndefined()
            await waitFor(() => expect(authors.has(book.author)).toBe(true))
        }, 15000)

        it('returns the same instance for the same normalized paths', () => {
            const { bookTags } = make()
            const a = bookTags.fetchRelations('tag', 'book')
            const b = bookTags.fetchRelations('book', 'tag', 'book')
            expect(a).toBe(b)
            expect(a).not.toBe(bookTags)
            expect(a.id).toBe('book_tags?expand=book,tag')
            expect(bookTags.fetchRelations('book')).not.toBe(a)
        })

        it('returns the base when nothing is added beyond alwaysFetchRelations', () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', {})
            const books = c('books', {
                relations: { author: authors },
                alwaysFetchRelations: ['author'],
            })
            expect(books.fetchRelations()).toBe(books)
            expect(books.fetchRelations('author')).toBe(books)
        })

        it('shares one store: the base sees rows fetched through a view', async () => {
            const { books } = make()
            const view = books.fetchRelations('author')

            const viewQuery = renderHook(() =>
                useLiveQuery(q =>
                    q.from({ books: view }).where(({ books }) => eq(books.title, 'Animal Farm'))
                )
            )
            await waitForLoadFinish(viewQuery.result, 10000)
            const id = viewQuery.result.current.data[0].id

            expect(books.has(id)).toBe(true)
            const stored = books.get(id) as { expand?: unknown }
            expect(stored.expand).toBeUndefined()
        }, 15000)

        it('lets a base and a view of the same collection share one query', async () => {
            const { authors, books } = make()
            const view = books.fetchRelations('author')

            const { result } = renderHook(() =>
                useLiveQuery(q =>
                    q
                        .from({ plain: books })
                        .join({ expanded: view }, ({ plain, expanded }) =>
                            eq(plain.id, expanded.id)
                        )
                        .where(({ plain }) => eq(plain.title, 'Animal Farm'))
                        .select(({ plain, expanded }) => ({
                            id: plain.id,
                            author: expanded?.author,
                        }))
                )
            )
            await waitForLoadFinish(result, 10000)
            await waitFor(() => expect(authors.has(result.current.data[0].author ?? '')).toBe(true))
        }, 15000)

        it('expands a nested path through the target collection', async () => {
            const { authors, books } = make()
            const metadata = createCollection<Schema>(pb, queryClient)('book_metadata', {
                syncMode: 'on-demand',
                relations: { book: books },
            })
            const view = metadata.fetchRelations('book.author')

            const { result } = renderHook(() => useLiveQuery(q => q.from({ m: view })))
            await waitForLoadFinish(result, 10000)

            const row = result.current.data[0]
            expect((row as { expand?: unknown }).expand).toBeUndefined()
            await waitFor(() => {
                expect(books.has(row.book)).toBe(true)
                const book = books.get(row.book) as { author: string; expand?: unknown } | undefined
                expect(book?.expand).toBeUndefined()
                expect(authors.has(book?.author ?? '')).toBe(true)
            })
        }, 15000)

        it('throws for an undeclared path and for expanding a view', () => {
            const { books } = make()
            // @ts-expect-error runtime check of an undeclared path
            expect(() => books.fetchRelations('nope')).toThrow(
                'Cannot expand "nope" on collection "books": segment "nope" is not a declared relation'
            )
            const view = books.fetchRelations('author')
            // @ts-expect-error views are leaves
            expect(() => view.fetchRelations('author')).toThrow(
                'view of "books" cannot fetch further relations'
            )
        })

        it('keys a view fetch by its expand string', async () => {
            const { books } = make()
            const view = books.fetchRelations('author')
            const { result } = renderHook(() =>
                useLiveQuery(q =>
                    q.from({ books: view }).where(({ books }) => eq(books.title, 'Animal Farm'))
                )
            )
            await waitForLoadFinish(result, 10000)
            const keys = queryClient
                .getQueryCache()
                .findAll({ queryKey: ['books'] })
                .map(query => query.queryKey)
            expect(keys).toContainEqual([
                'books',
                { subset: { field: 'title', values: ['Animal Farm'] }, expand: 'author' },
            ])
        }, 15000)

        it('a mutation through a view is visible through the base immediately', async () => {
            async function createBook(authorId: string) {
                const book = await pb.collection('books').create({
                    title: `Expand ${Date.now().toString().slice(-8)}`,
                    genre: 'Fiction',
                    isbn: `exp-${Date.now().toString().slice(-8)}`,
                    author: authorId,
                })
                return book.id as string
            }
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            const authorId = (await pb.collection('authors').getFirstListItem('')).id
            const bookId = await createBook(authorId)
            try {
                const view = books.fetchRelations('author')
                const viaView = renderHook(() =>
                    useLiveQuery(q => q.from({ b: view }).where(({ b }) => eq(b.id, bookId)))
                )
                const viaBase = renderHook(() =>
                    useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.id, bookId)))
                )
                await waitForLoadFinish(viaView.result, 10000)
                await waitForLoadFinish(viaBase.result, 10000)

                const viaViewTx = view.update(bookId, draft => {
                    draft.title = 'Optimistic via view'
                })
                await waitFor(() =>
                    expect(viaBase.result.current.data[0].title).toBe('Optimistic via view')
                )
                await viaViewTx.isPersisted.promise

                const viaBaseTx = books.update(bookId, draft => {
                    draft.title = 'Optimistic via base'
                })
                await waitFor(() =>
                    expect(viaView.result.current.data[0].title).toBe('Optimistic via base')
                )
                await viaBaseTx.isPersisted.promise
            } finally {
                await pb.collection('books').delete(bookId)
            }
        }, 20000)

        it('serializes overlapping restarts so two views created back-to-back leave one live subscription with the unioned expand', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const tags = c('tags', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            const bookTags = c('book_tags', {
                syncMode: 'on-demand',
                relations: { book: books, tag: tags },
            })

            // Wrap each unsubscribe function the real subscribe() resolves
            // with in its own spy, so production calling it can be counted
            // without this test invoking a PocketBase unsubscribe itself.
            const unsubscribeSpies: ReturnType<typeof vi.fn>[] = []
            const realSubscribe = pb
                .collection('book_tags')
                .subscribe.bind(pb.collection('book_tags'))
            const subscribeSpy = vi
                .spyOn(pb.collection('book_tags'), 'subscribe')
                .mockImplementation(async (...args) => {
                    const unsubscribe = await realSubscribe(...args)
                    const spy = vi.fn(unsubscribe)
                    unsubscribeSpies.push(spy)
                    return spy
                })

            try {
                const bookView = bookTags.fetchRelations('book')
                const tagView = bookTags.fetchRelations('tag')

                // Mount both views back-to-back, with no await between them, so
                // their subscriptions race rather than serialize naturally.
                const bookQuery = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ bt: bookView })
                            .orderBy(({ bt }) => bt.id)
                            .limit(1)
                    )
                )
                const tagQuery = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ bt: tagView })
                            .orderBy(({ bt }) => bt.id)
                            .limit(1)
                    )
                )

                await waitForLoadFinish(bookQuery.result, 10000)
                await waitForLoadFinish(tagQuery.result, 10000)
                await bookTags.waitForSubscription(10000)

                // Any restart still working its way through the serialized
                // subscription queue settles once the queue drains; the queue
                // only ever schedules more work while the union keeps
                // growing, so waiting for the last subscribe call to carry
                // the full union is sufficient (no arbitrary sleep needed).
                await waitFor(
                    () => {
                        const last = subscribeSpy.mock.calls.at(-1)
                        const options = last?.[2] as { expand?: string } | undefined
                        expect(options?.expand).toBe('book,tag')
                    },
                    { timeout: 10000 }
                )

                // No orphaned subscription: every subscribe call except the
                // last one must have had its unsubscribe invoked.
                await waitFor(() => {
                    const settledUnsubscribes = unsubscribeSpies
                        .slice(0, -1)
                        .filter(spy => spy.mock.calls.length > 0)
                    expect(settledUnsubscribes.length).toBe(unsubscribeSpies.length - 1)
                })
            } finally {
                subscribeSpy.mockRestore()
            }
        }, 20000)
    })

    describe('indexes', () => {
        it('orders with a limit on a view without the missing-index warning', async () => {
            const warn = vi.spyOn(console, 'warn')
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })

            const { result } = renderHook(() =>
                useLiveQuery(q =>
                    q
                        .from({ b: books.fetchRelations('author') })
                        .orderBy(({ b }) => b.title)
                        .limit(2)
                )
            )
            await waitForLoadFinish(result, 10000)
            expect(result.current.data.length).toBeGreaterThan(0)

            const indexWarnings = warn.mock.calls.filter(call =>
                String(call[0]).includes('requires an index')
            )
            expect(indexWarnings).toEqual([])
            expect(books.indexes.size).toBeGreaterThan(0)
        }, 15000)

        it('lets collectionOptions turn auto-indexing off', () => {
            const c = createCollection<Schema>(pb, queryClient)
            const books = c('books', { collectionOptions: { autoIndex: 'off' } })
            expect(books.config.autoIndex).toBe('off')
        })
    })

    describe('relation targets stay live', () => {
        type Internals = {
            heldRelationTargetCount: () => number
            subscriberCount: number
            status: string
        }
        const internals = (c: unknown) => c as Internals

        it('holds the target subscription while a view is live and releases it after', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })

            const query = renderHook(() =>
                useLiveQuery(q =>
                    q
                        .from({ b: books.fetchRelations('author') })
                        .orderBy(({ b }) => b.id)
                        .limit(1)
                )
            )
            await waitForLoadFinish(query.result, 10000)
            await books.waitForSubscription(10000)
            await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 10000 })
            expect(internals(authors).subscriberCount).toBe(1)
            expect(internals(books).heldRelationTargetCount()).toBe(1)

            query.unmount()
            await waitFor(() => expect(books.isSubscribed()).toBe(false), { timeout: 10000 })
            await waitFor(() => expect(authors.isSubscribed()).toBe(false), { timeout: 10000 })
            expect(internals(authors).subscriberCount).toBe(0)
            expect(internals(books).heldRelationTargetCount()).toBe(0)
        }, 20000)

        it('holds every collection along a nested path', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            const metadata = c('book_metadata', {
                syncMode: 'on-demand',
                relations: { book: books },
            })

            const query = renderHook(() =>
                useLiveQuery(q =>
                    q
                        .from({ m: metadata.fetchRelations('book.author') })
                        .orderBy(({ m }) => m.id)
                        .limit(1)
                )
            )
            await waitForLoadFinish(query.result, 10000)
            await metadata.waitForSubscription(10000)
            await waitFor(() => expect(books.isSubscribed()).toBe(true), { timeout: 10000 })
            await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 10000 })
            expect(internals(metadata).heldRelationTargetCount()).toBe(2)

            query.unmount()
            await waitFor(() => expect(metadata.isSubscribed()).toBe(false), { timeout: 10000 })
            await waitFor(() => expect(books.isSubscribed()).toBe(false), { timeout: 10000 })
            await waitFor(() => expect(authors.isSubscribed()).toBe(false), { timeout: 10000 })
        }, 20000)

        it('union growth through the restart path adds targets without bouncing existing ones', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const tags = c('tags', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            const bookTags = c('book_tags', {
                syncMode: 'on-demand',
                relations: { book: books, tag: tags },
            })

            const unsubscribeSpies: ReturnType<typeof vi.fn>[] = []
            const realSubscribe = pb.collection('books').subscribe.bind(pb.collection('books'))
            const subscribeSpy = vi
                .spyOn(pb.collection('books'), 'subscribe')
                .mockImplementation(async (...args) => {
                    const unsubscribe = await realSubscribe(...args)
                    const spy = vi.fn(unsubscribe)
                    unsubscribeSpies.push(spy)
                    return spy
                })

            try {
                const first = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ bt: bookTags.fetchRelations('book') })
                            .orderBy(({ bt }) => bt.id)
                            .limit(1)
                    )
                )
                await waitForLoadFinish(first.result, 10000)
                await bookTags.waitForSubscription(10000)
                await waitFor(() => expect(books.isSubscribed()).toBe(true), { timeout: 10000 })
                expect(internals(bookTags).heldRelationTargetCount()).toBe(1)

                const second = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ bt: bookTags.fetchRelations('tag') })
                            .orderBy(({ bt }) => bt.id)
                            .limit(1)
                    )
                )
                await waitForLoadFinish(second.result, 10000)
                await waitFor(() => expect(tags.isSubscribed()).toBe(true), { timeout: 10000 })

                const third = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ bt: bookTags.fetchRelations('book.author') })
                            .orderBy(({ bt }) => bt.id)
                            .limit(1)
                    )
                )
                await waitForLoadFinish(third.result, 10000)
                await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 10000 })

                await waitFor(() => expect(internals(bookTags).heldRelationTargetCount()).toBe(3))
                expect(internals(books).subscriberCount).toBe(1)
                expect(internals(tags).subscriberCount).toBe(1)
                expect(internals(authors).subscriberCount).toBe(1)
                // books was held from the first view and never released across
                // the two restarts: exactly one PocketBase subscribe, no unsubscribe.
                expect(subscribeSpy).toHaveBeenCalledTimes(1)
                expect(unsubscribeSpies[0]).not.toHaveBeenCalled()

                first.unmount()
                second.unmount()
                third.unmount()
                await waitFor(() => expect(bookTags.isSubscribed()).toBe(false), { timeout: 10000 })
                await waitFor(() => expect(internals(bookTags).heldRelationTargetCount()).toBe(0))
                await waitFor(() => expect(unsubscribeSpies[0]).toHaveBeenCalledTimes(1))
            } finally {
                subscribeSpy.mockRestore()
            }
        }, 30000)

        it('releases held targets when a restart subscribe fails', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const tags = c('tags', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            const bookTags = c('book_tags', {
                syncMode: 'on-demand',
                relations: { book: books, tag: tags },
            })

            const realSubscribe = pb
                .collection('book_tags')
                .subscribe.bind(pb.collection('book_tags'))
            let failNext = false
            const subscribeSpy = vi
                .spyOn(pb.collection('book_tags'), 'subscribe')
                .mockImplementation(async (...args) => {
                    if (failNext) {
                        failNext = false
                        throw new Error('subscribe rejected')
                    }
                    return realSubscribe(...args)
                })

            try {
                const first = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ bt: bookTags.fetchRelations('book') })
                            .orderBy(({ bt }) => bt.id)
                            .limit(1)
                    )
                )
                await waitForLoadFinish(first.result, 10000)
                await bookTags.waitForSubscription(10000)
                await waitFor(() => expect(books.isSubscribed()).toBe(true), { timeout: 10000 })
                expect(internals(bookTags).heldRelationTargetCount()).toBe(1)

                // The union grows, forcing a restart whose subscribe() rejects.
                failNext = true
                const second = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ bt: bookTags.fetchRelations('tag') })
                            .orderBy(({ bt }) => bt.id)
                            .limit(1)
                    )
                )
                await waitFor(() => expect(bookTags.isSubscribed()).toBe(false), { timeout: 10000 })

                first.unmount()
                second.unmount()

                // The real stop must still release every held target, even though
                // the failed restart already cleared isSubscribed/unsubscribeFn.
                await waitFor(() => expect(internals(bookTags).heldRelationTargetCount()).toBe(0), {
                    timeout: 10000,
                })
                await waitFor(() => expect(internals(books).subscriberCount).toBe(0), {
                    timeout: 10000,
                })
                expect(internals(tags).subscriberCount).toBe(0)
                expect(internals(authors).subscriberCount).toBe(0)
            } finally {
                subscribeSpy.mockRestore()
            }
        }, 30000)

        it('re-holds targets after a throwing unsubscribe', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })

            const realSubscribe = pb.collection('books').subscribe.bind(pb.collection('books'))
            let throwNextUnsubscribe = true
            const subscribeSpy = vi
                .spyOn(pb.collection('books'), 'subscribe')
                .mockImplementation(async (...args) => {
                    const unsubscribe = await realSubscribe(...args)
                    return async () => {
                        await unsubscribe()
                        if (throwNextUnsubscribe) {
                            throwNextUnsubscribe = false
                            throw new Error('unsubscribe failed')
                        }
                    }
                })

            const mount = () =>
                renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ b: books.fetchRelations('author') })
                            .orderBy(({ b }) => b.id)
                            .limit(1)
                    )
                )

            try {
                const first = mount()
                await waitForLoadFinish(first.result, 10000)
                await books.waitForSubscription(10000)
                await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 10000 })
                expect(internals(books).heldRelationTargetCount()).toBe(1)

                first.unmount()
                await waitFor(() => expect(books.isSubscribed()).toBe(false), { timeout: 10000 })
                await waitFor(() => expect(internals(books).heldRelationTargetCount()).toBe(0), {
                    timeout: 10000,
                })

                // A failed unsubscribe must not wedge the state machine: the next
                // first subscriber starts a fresh subscription and re-holds authors.
                const second = mount()
                await waitForLoadFinish(second.result, 10000)
                await books.waitForSubscription(10000)
                await waitFor(() => expect(internals(books).heldRelationTargetCount()).toBe(1), {
                    timeout: 10000,
                })
                await waitFor(() => expect(internals(authors).subscriberCount).toBe(1), {
                    timeout: 10000,
                })
                second.unmount()
                await waitFor(() => expect(internals(books).heldRelationTargetCount()).toBe(0), {
                    timeout: 10000,
                })
            } finally {
                subscribeSpy.mockRestore()
            }
        }, 30000)

        it('twenty mount/unmount cycles leave nothing held and balanced PocketBase calls', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })

            const unsubscribeSpies: ReturnType<typeof vi.fn>[] = []
            const realSubscribe = pb.collection('authors').subscribe.bind(pb.collection('authors'))
            const subscribeSpy = vi
                .spyOn(pb.collection('authors'), 'subscribe')
                .mockImplementation(async (...args) => {
                    const unsubscribe = await realSubscribe(...args)
                    const spy = vi.fn(unsubscribe)
                    unsubscribeSpies.push(spy)
                    return spy
                })

            try {
                for (let cycle = 0; cycle < 20; cycle++) {
                    const query = renderHook(() =>
                        useLiveQuery(q =>
                            q
                                .from({ b: books.fetchRelations('author') })
                                .orderBy(({ b }) => b.id)
                                .limit(1)
                        )
                    )
                    await waitForLoadFinish(query.result, 10000)
                    await books.waitForSubscription(10000)
                    await waitFor(() => expect(authors.isSubscribed()).toBe(true), {
                        timeout: 10000,
                    })
                    query.unmount()
                    await waitFor(() => expect(books.isSubscribed()).toBe(false), {
                        timeout: 10000,
                    })
                    await waitFor(() => expect(authors.isSubscribed()).toBe(false), {
                        timeout: 10000,
                    })
                    expect(internals(authors).subscriberCount).toBe(0)
                    expect(internals(books).heldRelationTargetCount()).toBe(0)
                }
                expect(subscribeSpy).toHaveBeenCalledTimes(unsubscribeSpies.length)
                for (const spy of unsubscribeSpies) expect(spy).toHaveBeenCalledTimes(1)
            } finally {
                subscribeSpy.mockRestore()
            }
        }, 120000)

        it('lets a released target garbage collect', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', {
                syncMode: 'on-demand',
                collectionOptions: { gcTime: 50 },
            })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })

            const query = renderHook(() =>
                useLiveQuery(q =>
                    q
                        .from({ b: books.fetchRelations('author') })
                        .orderBy(({ b }) => b.id)
                        .limit(1)
                )
            )
            await waitForLoadFinish(query.result, 10000)
            await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 10000 })

            query.unmount()
            await waitFor(() => expect(internals(authors).status).toBe('cleaned-up'), {
                timeout: 10000,
            })
        }, 20000)

        it('creating views holds nothing until one subscribes', () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const tags = c('tags', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            const bookTags = c('book_tags', {
                syncMode: 'on-demand',
                relations: { book: books, tag: tags },
            })
            for (let i = 0; i < 50; i++) {
                bookTags.fetchRelations(i % 2 === 0 ? 'book' : 'tag')
                bookTags.fetchRelations('book', 'tag')
            }
            expect(internals(bookTags).heldRelationTargetCount()).toBe(0)
            expect(internals(books).subscriberCount).toBe(0)
            expect(internals(tags).subscriberCount).toBe(0)
        })
    })

    describe('keyed loads served from the store', () => {
        function countRequestsTo(path: string) {
            const filters: string[] = []
            const prev = pb.beforeSend
            pb.beforeSend = (url, options) => {
                if (url.includes(path)) {
                    const query = (options as { query?: { filter?: string } }).query
                    filters.push(query?.filter ?? '')
                }
                return { url, options }
            }
            return {
                filters,
                restore: () => {
                    pb.beforeSend = prev
                },
            }
        }

        function countAuthorRequests() {
            return countRequestsTo('/collections/authors/records')
        }

        function countBooksRequests() {
            return countRequestsTo('/collections/books/records')
        }

        function make(always: boolean) {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', {
                syncMode: 'on-demand',
                relations: { author: authors },
                ...(always ? { alwaysFetchRelations: ['author'] as const } : {}),
            })
            return { authors, books }
        }

        it('a materialize include on filed rows makes no authors request', async () => {
            const { authors, books } = make(true)
            const counter = countAuthorRequests()
            try {
                const { result } = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ b: books })
                            .where(({ b }) => eq(b.genre, 'Fiction'))
                            .select(({ b }) => ({
                                id: b.id,
                                author: materialize(
                                    q
                                        .from({ a: authors })
                                        .where(({ a }) => eq(a.id, b.author))
                                        .findOne()
                                ),
                            }))
                    )
                )
                await waitForLoadFinish(result, 10000)
                await waitFor(() => {
                    expect(result.current.data.length).toBeGreaterThan(0)
                    expect(result.current.data.every(r => r.author?.name)).toBe(true)
                })
                expect(counter.filters).toEqual([])
            } finally {
                counter.restore()
            }
        }, 15000)

        it('a join on filed rows makes no authors request', async () => {
            const { authors, books } = make(true)
            const counter = countAuthorRequests()
            try {
                const { result } = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ b: books })
                            .where(({ b }) => eq(b.genre, 'Fiction'))
                            .join({ a: authors }, ({ b, a }) => eq(b.author, a.id))
                            .select(({ b, a }) => ({ id: b.id, name: a?.name }))
                    )
                )
                await waitForLoadFinish(result, 10000)
                await waitFor(() => expect(result.current.data.every(r => r.name)).toBe(true))
                expect(counter.filters).toEqual([])
            } finally {
                counter.restore()
            }
        }, 15000)

        it('get() and a findOne live query read a filed row without a request', async () => {
            const { authors, books } = make(true)
            const first = renderHook(() =>
                useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fiction')))
            )
            await waitForLoadFinish(first.result, 10000)
            const authorId = first.result.current.data[0].author
            await waitFor(() => expect(authors.has(authorId)).toBe(true))
            const counter = countAuthorRequests()
            try {
                expect(authors.get(authorId)?.id).toBe(authorId)
                const { result } = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ a: authors })
                            .where(({ a }) => eq(a.id, authorId))
                            .findOne()
                    )
                )
                await waitFor(() => expect(result.current.data?.id).toBe(authorId), {
                    timeout: 10000,
                })
                expect(counter.filters).toEqual([])
            } finally {
                counter.restore()
            }
        }, 15000)

        it('without the always-fetch, a join issues exactly one batched request', async () => {
            const { authors, books } = make(false)
            const counter = countAuthorRequests()
            try {
                const { result } = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ b: books })
                            .join({ a: authors }, ({ b, a }) => eq(b.author, a.id))
                            .select(({ b, a }) => ({ id: b.id, name: a?.name }))
                    )
                )
                await waitForLoadFinish(result, 10000)
                await waitFor(() => expect(result.current.data.every(r => r.name)).toBe(true))
                expect(counter.filters).toHaveLength(1)
                expect(counter.filters[0]).toContain('id = "')
            } finally {
                counter.restore()
            }
        }, 15000)

        it('a mixed predicate still fetches', async () => {
            const { authors, books } = make(true)
            const first = renderHook(() =>
                useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fiction')))
            )
            await waitForLoadFinish(first.result, 10000)
            const authorId = first.result.current.data[0].author
            await waitFor(() => expect(authors.has(authorId)).toBe(true))
            const name = authors.get(authorId)?.name ?? ''
            const counter = countAuthorRequests()
            try {
                const { result } = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ a: authors })
                            .where(({ a }) => and(eq(a.id, authorId), eq(a.name, name)))
                    )
                )
                await waitForLoadFinish(result, 10000)
                expect(counter.filters).toHaveLength(1)
            } finally {
                counter.restore()
            }
        }, 15000)

        it('an always-fetch collection serves its own id-only load from the store', async () => {
            const { books } = make(true)
            const first = renderHook(() =>
                useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fiction')))
            )
            await waitForLoadFinish(first.result, 10000)
            const bookId = first.result.current.data[0].id
            const counter = countBooksRequests()
            try {
                const { result } = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ b: books })
                            .where(({ b }) => eq(b.id, bookId))
                            .findOne()
                    )
                )
                await waitFor(() => expect(result.current.data?.id).toBe(bookId), {
                    timeout: 10000,
                })
                expect(counter.filters).toEqual([])
            } finally {
                counter.restore()
            }
        }, 15000)

        it('a fetchRelations() view still fetches an id-only load, since its extra paths may be unfiled', async () => {
            const { books } = make(false)
            const first = renderHook(() =>
                useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fiction')))
            )
            await waitForLoadFinish(first.result, 10000)
            const bookId = first.result.current.data[0].id
            const counter = countBooksRequests()
            try {
                const view = books.fetchRelations('author')
                const { result } = renderHook(() =>
                    useLiveQuery(q => q.from({ b: view }).where(({ b }) => eq(b.id, bookId)))
                )
                await waitForLoadFinish(result, 10000)
                expect(counter.filters).toHaveLength(1)
            } finally {
                counter.restore()
            }
        }, 15000)

        it('an empty inArray(id, []) yields no data and no request', async () => {
            const { authors, books } = make(true)
            const first = renderHook(() =>
                useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fiction')))
            )
            await waitForLoadFinish(first.result, 10000)
            const counter = countAuthorRequests()
            try {
                const { result } = renderHook(() =>
                    useLiveQuery(q => q.from({ a: authors }).where(({ a }) => inArray(a.id, [])))
                )
                await waitForLoadFinish(result, 10000)
                expect(result.current.data).toEqual([])
                expect(counter.filters).toEqual([])
            } finally {
                counter.restore()
            }
        }, 15000)

        describe('loaded subsets', () => {
            function makeBooks() {
                const c = createCollection<Schema>(pb, queryClient)
                const bookTags = c('book_tags', { syncMode: 'on-demand' })
                const metadata = c('book_metadata', { syncMode: 'on-demand' })
                const books = c('books', {
                    syncMode: 'on-demand',
                    relations: { book_tags_via_book: bookTags, book_metadata_via_book: metadata },
                })
                return { books, bookTags, metadata }
            }

            // A seeded book with at least one junction row, plus the ids PocketBase
            // reports for it, fetched before any request counter is installed.
            async function seededBookWithTags() {
                const list = await pb
                    .collection('books')
                    .getFullList({ expand: 'book_tags_via_book' })
                const book = list.find(item => {
                    const tags = (item as { expand?: { book_tags_via_book?: unknown[] } }).expand
                        ?.book_tags_via_book
                    return Array.isArray(tags) && tags.length > 0
                })
                if (!book) throw new Error('seed data has no book with tags')
                const tagIds = (
                    book as unknown as { expand: { book_tags_via_book: Array<{ id: string }> } }
                ).expand.book_tags_via_book.map(row => row.id)
                return { bookId: book.id, tagIds }
            }

            function tagsFor(bookTags: ReturnType<typeof makeBooks>['bookTags'], bookId: string) {
                return renderHook(() =>
                    useLiveQuery(q =>
                        q.from({ bt: bookTags }).where(({ bt }) => eq(bt.book, bookId))
                    )
                )
            }

            it('serves a back-relation subset from the store after the parent filed it', async () => {
                const { bookId, tagIds } = await seededBookWithTags()
                const { books, bookTags } = makeBooks()
                const counter = countRequestsTo('/collections/book_tags/records')
                try {
                    const { result } = renderHook(() =>
                        useLiveQuery(q =>
                            q
                                .from({ b: books.fetchRelations('book_tags_via_book') })
                                .where(({ b }) => eq(b.id, bookId))
                                .select(({ b }) => ({
                                    id: b.id,
                                    tags: materialize(
                                        q
                                            .from({ bt: bookTags })
                                            .where(({ bt }) => eq(bt.book, b.id))
                                    ),
                                }))
                        )
                    )
                    await waitForLoadFinish(result, 10000)
                    await waitFor(() =>
                        expect(new Set(result.current.data[0]?.tags?.map(t => t.id))).toEqual(
                            new Set(tagIds)
                        )
                    )
                    expect(counter.filters).toEqual([])
                    expect(bookTags.loadedSubsetCount()).toBeGreaterThanOrEqual(1)
                } finally {
                    counter.restore()
                }
            }, 15000)

            it('fetches the subset once when nothing filed it', async () => {
                const { bookId, tagIds } = await seededBookWithTags()
                const { books, bookTags } = makeBooks()
                const counter = countRequestsTo('/collections/book_tags/records')
                try {
                    const { result } = renderHook(() =>
                        useLiveQuery(q =>
                            q
                                .from({ b: books })
                                .where(({ b }) => eq(b.id, bookId))
                                .select(({ b }) => ({
                                    id: b.id,
                                    tags: materialize(
                                        q
                                            .from({ bt: bookTags })
                                            .where(({ bt }) => eq(bt.book, b.id))
                                    ),
                                }))
                        )
                    )
                    await waitForLoadFinish(result, 10000)
                    await waitFor(() =>
                        expect(new Set(result.current.data[0]?.tags?.map(t => t.id))).toEqual(
                            new Set(tagIds)
                        )
                    )
                    expect(counter.filters).toHaveLength(1)
                    expect(counter.filters[0]).toContain('book = "')
                } finally {
                    counter.restore()
                }
            }, 15000)

            it('a plain base query does not mark the subset', async () => {
                const { bookId } = await seededBookWithTags()
                const { books, bookTags } = makeBooks()
                const base = renderHook(() =>
                    useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.id, bookId)))
                )
                await waitForLoadFinish(base.result, 10000)
                expect(bookTags.loadedSubsetCount()).toBe(0)
                const counter = countRequestsTo('/collections/book_tags/records')
                try {
                    const include = tagsFor(bookTags, bookId)
                    await waitForLoadFinish(include.result, 10000)
                    expect(counter.filters).toHaveLength(1)
                } finally {
                    counter.restore()
                }
            }, 15000)

            it('serves a second back-relation child (book_metadata) the same way', async () => {
                const { bookId } = await seededBookWithTags()
                const { books, metadata } = makeBooks()
                const counter = countRequestsTo('/collections/book_metadata/records')
                try {
                    const { result } = renderHook(() =>
                        useLiveQuery(q =>
                            q
                                .from({ b: books.fetchRelations('book_metadata_via_book') })
                                .where(({ b }) => eq(b.id, bookId))
                                .select(({ b }) => ({
                                    id: b.id,
                                    meta: materialize(
                                        q.from({ m: metadata }).where(({ m }) => eq(m.book, b.id))
                                    ),
                                }))
                        )
                    )
                    await waitForLoadFinish(result, 10000)
                    await waitFor(() =>
                        expect(result.current.data[0]?.meta?.length).toBeGreaterThan(0)
                    )
                    expect(counter.filters).toEqual([])
                } finally {
                    counter.restore()
                }
            }, 15000)

            it('a pruned row invalidates the mark', async () => {
                const { bookId, tagIds } = await seededBookWithTags()
                const { books, bookTags } = makeBooks()
                const parent = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ b: books.fetchRelations('book_tags_via_book') })
                            .where(({ b }) => eq(b.id, bookId))
                    )
                )
                await waitForLoadFinish(parent.result, 10000)
                await waitFor(() => expect(bookTags.has(tagIds[0])).toBe(true))
                const counter = countRequestsTo('/collections/book_tags/records')
                try {
                    const first = tagsFor(bookTags, bookId)
                    await waitForLoadFinish(first.result, 10000)
                    expect(first.result.current.data.length).toBe(tagIds.length)
                    expect(counter.filters).toEqual([])
                    first.unmount()

                    bookTags.utils.writeDelete(tagIds[0])
                    const second = tagsFor(bookTags, bookId)
                    await waitForLoadFinish(second.result, 10000)
                    await waitFor(() => expect(counter.filters).toHaveLength(1))
                    await waitFor(() =>
                        expect(second.result.current.data.length).toBe(tagIds.length)
                    )
                } finally {
                    counter.restore()
                }
            }, 20000)

            it('the target realtime stop invalidates every mark', async () => {
                const { bookId } = await seededBookWithTags()
                const { books, bookTags } = makeBooks()
                const parent = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ b: books.fetchRelations('book_tags_via_book') })
                            .where(({ b }) => eq(b.id, bookId))
                    )
                )
                await waitForLoadFinish(parent.result, 10000)
                await waitFor(() => expect(bookTags.isSubscribed()).toBe(true), { timeout: 10000 })
                parent.unmount()
                await waitFor(() => expect(bookTags.isSubscribed()).toBe(false), { timeout: 10000 })
                expect(bookTags.loadedSubsetCount()).toBe(0)
                const counter = countRequestsTo('/collections/book_tags/records')
                try {
                    const include = tagsFor(bookTags, bookId)
                    await waitForLoadFinish(include.result, 10000)
                    expect(counter.filters).toHaveLength(1)
                } finally {
                    counter.restore()
                }
            }, 20000)

            it('cleanup clears every mark', async () => {
                const { bookTags } = makeBooks()
                bookTags.markSubsetLoaded('book', 'x')
                expect(bookTags.loadedSubsetCount()).toBe(1)
                await bookTags.cleanup()
                await waitFor(() => expect(bookTags.loadedSubsetCount()).toBe(0))
            }, 15000)

            it('serves a back-relation filed by a different parent (tags)', async () => {
                const junction = (await pb.collection('book_tags').getList(1, 1))
                    .items[0] as unknown as {
                    tag: string
                }
                const c = createCollection<Schema>(pb, queryClient)
                const bookTags = c('book_tags', { syncMode: 'on-demand' })
                const tags = c('tags', {
                    syncMode: 'on-demand',
                    relations: { book_tags_via_tag: bookTags },
                })
                const counter = countRequestsTo('/collections/book_tags/records')
                try {
                    const { result } = renderHook(() =>
                        useLiveQuery(q =>
                            q
                                .from({ t: tags.fetchRelations('book_tags_via_tag') })
                                .where(({ t }) => eq(t.id, junction.tag))
                                .select(({ t }) => ({
                                    id: t.id,
                                    links: materialize(
                                        q.from({ bt: bookTags }).where(({ bt }) => eq(bt.tag, t.id))
                                    ),
                                }))
                        )
                    )
                    await waitForLoadFinish(result, 10000)
                    await waitFor(() =>
                        expect(result.current.data[0]?.links?.length).toBeGreaterThan(0)
                    )
                    expect(counter.filters).toEqual([])
                } finally {
                    counter.restore()
                }
            }, 15000)
        })
    })
})
