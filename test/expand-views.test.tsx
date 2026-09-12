import { eq, useLiveQuery } from '@tanstack/react-db'
import type { QueryClient } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
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
import type { Books, Schema } from './schema'

describe('Per-query expand', () => {
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

    describe('alwaysExpand', () => {
        it('rejects an undeclared path at creation', () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', {})
            expect(() =>
                // @ts-expect-error runtime check of an undeclared path
                c('books', { relations: { author: authors }, alwaysExpand: ['nope'] })
            ).toThrow('Cannot expand "nope" on collection "books"')
            // @ts-expect-error runtime check without relations
            expect(() => c('books', { alwaysExpand: ['author'] })).toThrow('no relations declared')
        })

        it('expands nested paths and upserts each level into its target', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            const metadata = c('book_metadata', {
                syncMode: 'on-demand',
                relations: { book: books },
                alwaysExpand: ['book.author'],
            })

            const { result } = renderHook(() => useLiveQuery(q => q.from({ m: metadata })))
            await waitForLoadFinish(result, 10000)

            const row = result.current.data[0]
            expect(row.expand?.book?.id).toBe(row.book)
            expect(row.expand?.book?.expand?.author?.id).toBe(row.expand?.book?.author)

            await waitFor(() => {
                expect(books.has(row.book)).toBe(true)
                expect(authors.has(row.expand?.book?.author ?? '')).toBe(true)
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
                alwaysExpand: ['author'],
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
                { filter: 'genre = "Fiction"', sort: 'title', limit: 2 },
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
            const view = books.expand('author')

            const { result } = renderHook(() =>
                useLiveQuery(q =>
                    q.from({ books: view }).where(({ books }) => eq(books.title, 'Animal Farm'))
                )
            )
            await waitForLoadFinish(result, 10000)

            const book = result.current.data[0]
            expect(book.expand?.author?.name).toBeTypeOf('string')
            await waitFor(() => expect(authors.has(book.author)).toBe(true))
        }, 15000)

        it('returns the same instance for the same normalized paths', () => {
            const { bookTags } = make()
            const a = bookTags.expand('tag', 'book')
            const b = bookTags.expand('book', 'tag', 'book')
            expect(a).toBe(b)
            expect(a).not.toBe(bookTags)
            expect(a.id).toBe('book_tags?expand=book,tag')
            expect(bookTags.expand('book')).not.toBe(a)
        })

        it('returns the base when nothing is added beyond alwaysExpand', () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', {})
            const books = c('books', { relations: { author: authors }, alwaysExpand: ['author'] })
            expect(books.expand()).toBe(books)
            expect(books.expand('author')).toBe(books)
        })

        it('shares one store: the base sees rows fetched through a view', async () => {
            const { books } = make()
            const view = books.expand('author')

            const viewQuery = renderHook(() =>
                useLiveQuery(q =>
                    q.from({ books: view }).where(({ books }) => eq(books.title, 'Animal Farm'))
                )
            )
            await waitForLoadFinish(viewQuery.result, 10000)
            const id = viewQuery.result.current.data[0].id

            expect(books.has(id)).toBe(true)
            const stored = books.get(id) as { expand?: { author?: { name: string } } }
            expect(stored.expand?.author?.name).toBeTypeOf('string')
        }, 15000)

        it('lets a base and a view of the same collection share one query', async () => {
            const { books } = make()
            const view = books.expand('author')

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
                            author: expanded?.expand?.author?.name,
                        }))
                )
            )
            await waitForLoadFinish(result, 10000)
            expect(result.current.data[0].author).toBeTypeOf('string')
        }, 15000)

        it('expands a nested path through the target collection', async () => {
            const { authors, books } = make()
            const metadata = createCollection<Schema>(pb, queryClient)('book_metadata', {
                syncMode: 'on-demand',
                relations: { book: books },
            })
            const view = metadata.expand('book.author')

            const { result } = renderHook(() => useLiveQuery(q => q.from({ m: view })))
            await waitForLoadFinish(result, 10000)

            const row = result.current.data[0]
            expect(row.expand?.book?.id).toBe(row.book)
            expect(row.expand?.book?.expand?.author?.id).toBe(row.expand?.book?.author)
            await waitFor(() => {
                expect(books.has(row.book)).toBe(true)
                expect(authors.has(row.expand?.book?.author ?? '')).toBe(true)
            })
        }, 15000)

        it('throws for an undeclared path and for expanding a view', () => {
            const { books } = make()
            // @ts-expect-error runtime check of an undeclared path
            expect(() => books.expand('nope')).toThrow(
                'Cannot expand "nope" on collection "books": segment "nope" is not a declared relation'
            )
            const view = books.expand('author')
            // @ts-expect-error views are leaves
            expect(() => view.expand('author')).toThrow(
                'view of "books" cannot be expanded further'
            )
        })

        it('keys a view fetch by its expand string', async () => {
            const { books } = make()
            const view = books.expand('author')
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
                { filter: 'title = "Animal Farm"', expand: 'author' },
            ])
        }, 15000)

        it('holds an optimistic update against a view fetch racing it', async () => {
            const authorId = await getTestAuthorId()
            const seed = (await pb.collection('books').create({
                title: `View race ${getTestSlug('vr')}`,
                isbn: getTestSlug('isbn'),
                genre: 'Fiction',
                author: authorId,
                published_date: '',
                page_count: 1,
            })) as unknown as Books

            let releaseUpdate: () => void = () => {}
            const updateGate = new Promise<void>(resolve => {
                releaseUpdate = resolve
            })

            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', {
                syncMode: 'on-demand',
                relations: { author: authors },
                onUpdate: async ({ transaction }) => {
                    await updateGate
                    await Promise.all(
                        transaction.mutations.map(mutation => {
                            const original = mutation.original as { id: string }
                            return pb.collection('books').update(original.id, mutation.changes)
                        })
                    )
                    return { refetch: false }
                },
            })

            const syncedTitle = () =>
                (
                    books as unknown as {
                        _state: { syncedData: { get: (k: string) => Books | undefined } }
                    }
                )._state.syncedData.get(seed.id)?.title

            // The view's fetch is gated too, so its resolution (a stale,
            // pre-mutation read) is guaranteed to land while the update above is
            // still pending, exactly as a racing read would.
            const realGetFullList = pb.collection('books').getFullList.bind(pb.collection('books'))
            let releaseView: () => void = () => {}
            const viewGate = new Promise<void>(resolve => {
                releaseView = resolve
            })
            vi.spyOn(pb.collection('books'), 'getFullList').mockImplementation(
                async (...args: Parameters<typeof realGetFullList>) => {
                    const options = args[0] as { filter?: string; expand?: string } | undefined
                    if ((options?.filter ?? '').includes(seed.id) && options?.expand) {
                        await viewGate
                        return [{ ...seed, title: 'Stale' }] as unknown as ReturnType<
                            typeof realGetFullList
                        >
                    }
                    return realGetFullList(...args)
                }
            )

            try {
                const baseQuery = renderHook(() =>
                    useLiveQuery(q => q.from({ books }).where(({ books }) => eq(books.id, seed.id)))
                )
                await waitForLoadFinish(baseQuery.result, 10000)
                expect(syncedTitle()).toBe(seed.title)

                const tx = books.update(seed.id, draft => {
                    draft.title = 'Optimistic'
                })
                await waitFor(
                    () => expect(baseQuery.result.current.data[0]?.title).toBe('Optimistic'),
                    { timeout: 2000 }
                )
                expect(tx.state).toBe('persisting')

                // Mount the view while the mutation above is still pending; its
                // gated fetch resolves below with the stale row.
                const view = books.expand('author')
                const viewQuery = renderHook(() =>
                    useLiveQuery(q =>
                        q.from({ books: view }).where(({ books }) => eq(books.id, seed.id))
                    )
                )

                releaseView()
                await waitFor(
                    () => {
                        const request = queryClient
                            .getQueryCache()
                            .findAll({ queryKey: ['books'] })
                            .find(query => {
                                const key = query.queryKey[1] as { expand?: string } | undefined
                                return key?.expand === 'author'
                            })
                        expect(request?.state.status).toBe('success')
                    },
                    { timeout: 10000 }
                )
                // The guard must have dropped the racing stale write while the
                // real mutation was still pending: the synced store never shows
                // the view's pre-mutation 'Stale' read, and a user looking
                // through either the base or the view still sees the optimistic
                // value held.
                expect(tx.state).toBe('persisting')
                expect(syncedTitle()).not.toBe('Stale')
                expect(baseQuery.result.current.data[0]?.title).toBe('Optimistic')
                expect(viewQuery.result.current.data[0]?.title).toBe('Optimistic')

                releaseUpdate()
                await tx.isPersisted.promise
                await waitFor(() => expect(books.get(seed.id)?.title).toBe('Optimistic'), {
                    timeout: 10000,
                })
                expect(baseQuery.result.current.data[0]?.title).toBe('Optimistic')
                expect(viewQuery.result.current.data[0]?.title).toBe('Optimistic')
                viewQuery.unmount()
            } finally {
                releaseView()
                releaseUpdate()
                await pb
                    .collection('books')
                    .delete(seed.id)
                    .catch(() => {})
            }
        }, 15000)
    })

    describe('shared store coherence', () => {
        async function createBook(authorId: string) {
            const book = await pb.collection('books').create({
                title: `Expand ${Date.now().toString().slice(-8)}`,
                genre: 'Fiction',
                isbn: `exp-${Date.now().toString().slice(-8)}`,
                author: authorId,
            })
            return book.id as string
        }

        it('keeps expand on a row when a plain fetch overwrites it, and drops it when the relation changes', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            const allAuthors = await pb.collection('authors').getFullList()
            const bookId = await createBook(allAuthors[0].id)
            try {
                const expanded = renderHook(() =>
                    useLiveQuery(q =>
                        q.from({ b: books.expand('author') }).where(({ b }) => eq(b.id, bookId))
                    )
                )
                await waitForLoadFinish(expanded.result, 10000)
                expect(expanded.result.current.data[0].expand?.author?.id).toBe(allAuthors[0].id)

                const plain = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ b: books })
                            .where(({ b }) => eq(b.id, bookId))
                            .orderBy(({ b }) => b.title)
                    )
                )
                await waitForLoadFinish(plain.result, 10000)
                expect(expanded.result.current.data[0].expand?.author?.id).toBe(allAuthors[0].id)

                await books.waitForSubscription()
                await pb.collection('books').update(bookId, { author: allAuthors[1].id })
                await waitFor(() =>
                    expect(expanded.result.current.data[0].author).toBe(allAuthors[1].id)
                )
                await waitFor(() =>
                    expect(expanded.result.current.data[0].expand?.author?.id).toBe(
                        allAuthors[1].id
                    )
                )
            } finally {
                await pb.collection('books').delete(bookId)
            }
        }, 20000)

        it('eager: a view created after load refetches and rows gain expand', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'eager', relations: { author: authors } })

            const plain = renderHook(() => useLiveQuery(q => q.from({ books })))
            await waitForLoadFinish(plain.result, 10000)
            expect((plain.result.current.data[0] as { expand?: unknown }).expand).toBeUndefined()

            const expanded = renderHook(() =>
                useLiveQuery(q => q.from({ books: books.expand('author') }))
            )
            await waitForLoadFinish(expanded.result, 10000)
            await waitFor(() =>
                expect(expanded.result.current.data[0].expand?.author?.name).toBeTypeOf('string')
            )
            await waitFor(() => expect(authors.size).toBeGreaterThan(0))
        }, 15000)

        it('subscribes realtime with the expand union so an echo keeps expand populated', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            const authorId = (await pb.collection('authors').getFirstListItem('')).id
            const bookId = await createBook(authorId)
            try {
                const { result } = renderHook(() =>
                    useLiveQuery(q =>
                        q.from({ b: books.expand('author') }).where(({ b }) => eq(b.id, bookId))
                    )
                )
                await waitForLoadFinish(result, 10000)
                await books.waitForSubscription()

                await pb.collection('books').update(bookId, { title: 'Echoed' })
                await waitFor(() => expect(result.current.data[0].title).toBe('Echoed'))
                expect(result.current.data[0].expand?.author?.id).toBe(authorId)
            } finally {
                await pb.collection('books').delete(bookId)
            }
        }, 20000)

        it('a mutation through a view is visible through the base immediately', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            const authorId = (await pb.collection('authors').getFirstListItem('')).id
            const bookId = await createBook(authorId)
            try {
                const view = books.expand('author')
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
                const bookView = bookTags.expand('book')
                const tagView = bookTags.expand('tag')

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
                        .from({ b: books.expand('author') })
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
                        .from({ m: metadata.expand('book.author') })
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
                            .from({ bt: bookTags.expand('book') })
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
                            .from({ bt: bookTags.expand('tag') })
                            .orderBy(({ bt }) => bt.id)
                            .limit(1)
                    )
                )
                await waitForLoadFinish(second.result, 10000)
                await waitFor(() => expect(tags.isSubscribed()).toBe(true), { timeout: 10000 })

                const third = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ bt: bookTags.expand('book.author') })
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
                            .from({ bt: bookTags.expand('book') })
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
                            .from({ bt: bookTags.expand('tag') })
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
                            .from({ b: books.expand('author') })
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
                                .from({ b: books.expand('author') })
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
                        .from({ b: books.expand('author') })
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
                bookTags.expand(i % 2 === 0 ? 'book' : 'tag')
                bookTags.expand('book', 'tag')
            }
            expect(internals(bookTags).heldRelationTargetCount()).toBe(0)
            expect(internals(books).subscriberCount).toBe(0)
            expect(internals(tags).subscriberCount).toBe(0)
        })

        function patchBatchesFor(spy: { mock: { calls: unknown[][] } }, id: string): unknown[][] {
            return spy.mock.calls.filter(call =>
                (call[0] as Array<{ id: string }>).some(row => row.id === id)
            )
        }

        async function createAuthor() {
            const record = await pb.collection('authors').create({
                name: `Live ${getTestSlug('au')}`,
                email: `${getTestSlug('live')}@example.com`,
            })
            return record.id as string
        }

        async function createBook(authorId: string) {
            const record = await pb.collection('books').create({
                title: `Live ${getTestSlug('bk')}`,
                isbn: getTestSlug('isbn'),
                genre: 'Fiction',
                author: authorId,
                published_date: '',
                page_count: 1,
            })
            return record.id as string
        }

        it('patches the embedded author when the author changes, with no book write', async () => {
            const authorId = await createAuthor()
            const bookId = await createBook(authorId)
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            try {
                const { result } = renderHook(() =>
                    useLiveQuery(q =>
                        q.from({ b: books.expand('author') }).where(({ b }) => eq(b.id, bookId))
                    )
                )
                await waitForLoadFinish(result, 10000)
                await books.waitForSubscription(10000)
                await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 10000 })
                await authors.waitForSubscription(10000)

                const before = result.current.data[0]
                await pb.collection('authors').update(authorId, { name: 'Renamed Author' })
                await waitFor(
                    () =>
                        expect(result.current.data[0]?.expand?.author?.name).toBe('Renamed Author'),
                    { timeout: 10000 }
                )
                expect(result.current.data[0]?.updated).toBe(before.updated)
            } finally {
                await pb.collection('books').delete(bookId)
                await pb.collection('authors').delete(authorId)
            }
        }, 20000)

        it('patches a nested copy two hops away', async () => {
            const authorId = await createAuthor()
            const bookId = await createBook(authorId)
            const metadataId = (
                await pb.collection('book_metadata').create({
                    book: bookId,
                    genre: 'Fiction',
                    language: 'en',
                    summary: '',
                    rating: 3,
                })
            ).id as string
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            const metadata = c('book_metadata', {
                syncMode: 'on-demand',
                relations: { book: books },
            })
            try {
                const { result } = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ m: metadata.expand('book.author') })
                            .where(({ m }) => eq(m.id, metadataId))
                    )
                )
                await waitForLoadFinish(result, 10000)
                await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 10000 })
                await authors.waitForSubscription(10000)

                await pb.collection('authors').update(authorId, { name: 'Nested Rename' })
                await waitFor(
                    () =>
                        expect(result.current.data[0]?.expand?.book?.expand?.author?.name).toBe(
                            'Nested Rename'
                        ),
                    { timeout: 10000 }
                )
            } finally {
                await pb.collection('book_metadata').delete(metadataId)
                await pb.collection('books').delete(bookId)
                await pb.collection('authors').delete(authorId)
            }
        }, 20000)

        it('leaves a row that never embedded the relation untouched, and writes exactly once per echo', async () => {
            const authorId = await createAuthor()
            const embeddedBookId = await createBook(authorId)
            const plainBookId = await createBook(authorId)
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            try {
                const expanded = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ b: books.expand('author') })
                            .where(({ b }) => eq(b.id, embeddedBookId))
                    )
                )
                const plain = renderHook(() =>
                    useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.id, plainBookId)))
                )
                await waitForLoadFinish(expanded.result, 10000)
                await waitForLoadFinish(plain.result, 10000)
                await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 10000 })
                await authors.waitForSubscription(10000)

                const booksWrites = vi.spyOn(books.utils, 'writeUpsert')
                const authorsWrites = vi.spyOn(authors.utils, 'writeUpsert')
                let notifications = 0
                const subscription = books.subscribeChanges(() => {
                    notifications++
                })
                try {
                    await pb.collection('authors').update(authorId, { name: 'Once' })
                    await waitFor(
                        () =>
                            expect(expanded.result.current.data[0]?.expand?.author?.name).toBe(
                                'Once'
                            ),
                        { timeout: 10000 }
                    )
                    const store = (
                        books as unknown as {
                            _state: { syncedData: Map<string, { expand?: unknown }> }
                        }
                    )._state.syncedData
                    expect(store.get(plainBookId)?.expand).toBeUndefined()

                    // exactly one patch batch containing only the embedded row
                    const patchBatches = patchBatchesFor(booksWrites, embeddedBookId)
                    expect(patchBatches).toHaveLength(1)
                    expect((patchBatches[0][0] as Array<{ id: string }>).map(r => r.id)).toEqual([
                        embeddedBookId,
                    ])
                    expect(authorsWrites).toHaveBeenCalledTimes(1)
                    expect(notifications).toBe(1)

                    // Quiet after settle, proven by ordering rather than a
                    // sleep: a second echo must be the very next write. Any
                    // loop spinning after the first patch would have pushed
                    // these counts past 2 before the second name lands.
                    await pb.collection('authors').update(authorId, { name: 'Once again' })
                    await waitFor(
                        () =>
                            expect(expanded.result.current.data[0]?.expand?.author?.name).toBe(
                                'Once again'
                            ),
                        { timeout: 10000 }
                    )
                    expect(patchBatchesFor(booksWrites, embeddedBookId)).toHaveLength(2)
                    expect(authorsWrites).toHaveBeenCalledTimes(2)
                    expect(notifications).toBe(2)
                } finally {
                    subscription.unsubscribe()
                }
            } finally {
                await pb.collection('books').delete(embeddedBookId)
                await pb.collection('books').delete(plainBookId)
                await pb.collection('authors').delete(authorId)
            }
        }, 30000)

        it('a redelivered echo produces no second write', async () => {
            const authorId = await createAuthor()
            const bookId = await createBook(authorId)
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            try {
                const { result } = renderHook(() =>
                    useLiveQuery(q =>
                        q.from({ b: books.expand('author') }).where(({ b }) => eq(b.id, bookId))
                    )
                )
                await waitForLoadFinish(result, 10000)
                await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 10000 })

                const record = await pb.collection('authors').getOne(authorId)
                const booksWrites = vi.spyOn(books.utils, 'writeUpsert')
                const apply = (
                    books as unknown as {
                        applyRelatedChange: (
                            field: string,
                            action: 'update',
                            record: Record<string, unknown> & { id: string },
                            visited: Set<string>
                        ) => void
                    }
                ).applyRelatedChange
                apply('author', 'update', { ...record, name: 'Twice' }, new Set())
                apply('author', 'update', { ...record, name: 'Twice' }, new Set())
                expect(booksWrites).toHaveBeenCalledTimes(1)
                await waitFor(() =>
                    expect(result.current.data[0]?.expand?.author?.name).toBe('Twice')
                )
            } finally {
                await pb.collection('books').delete(bookId)
                await pb.collection('authors').delete(authorId)
            }
        }, 20000)

        it('deleting an unreferenced author produces no parent writes', async () => {
            const authorId = await createAuthor()
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            const { result } = renderHook(() =>
                useLiveQuery(q =>
                    q
                        .from({ b: books.expand('author') })
                        .orderBy(({ b }) => b.id)
                        .limit(2)
                )
            )
            await waitForLoadFinish(result, 10000)
            await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 10000 })
            await authors.waitForSubscription(10000)

            const booksWrites = vi.spyOn(books.utils, 'writeUpsert')
            const authorsDeletes = vi.spyOn(authors.utils, 'writeDelete')
            await pb.collection('authors').delete(authorId)
            await waitFor(() => expect(authorsDeletes).toHaveBeenCalled(), { timeout: 10000 })
            expect(booksWrites).not.toHaveBeenCalled()
        }, 20000)

        it('keeps a pending optimistic update while the author is patched', async () => {
            const authorId = await createAuthor()
            const bookId = await createBook(authorId)
            let releaseUpdate: () => void = () => {}
            const updateGate = new Promise<void>(resolve => {
                releaseUpdate = resolve
            })
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', {
                syncMode: 'on-demand',
                relations: { author: authors },
                onUpdate: async ({ transaction }) => {
                    await updateGate
                    await Promise.all(
                        transaction.mutations.map(mutation => {
                            const original = mutation.original as { id: string }
                            return pb.collection('books').update(original.id, mutation.changes)
                        })
                    )
                    return { refetch: false }
                },
            })
            try {
                const { result } = renderHook(() =>
                    useLiveQuery(q =>
                        q.from({ b: books.expand('author') }).where(({ b }) => eq(b.id, bookId))
                    )
                )
                await waitForLoadFinish(result, 10000)
                await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 10000 })
                await authors.waitForSubscription(10000)

                const tx = books.update(bookId, draft => {
                    draft.title = 'Optimistic'
                })
                await waitFor(() => expect(result.current.data[0]?.title).toBe('Optimistic'))

                // The pending mutation's optimistic overlay is the visible row until
                // the transaction settles, so the patched `expand` is invisible until
                // then — but the underlying synced write must have landed (and must
                // not have reverted the pending `title`), which the post-settle
                // assertions below confirm.
                await pb.collection('authors').update(authorId, { name: 'While Pending' })
                const synced = (
                    books as unknown as {
                        _state: {
                            syncedData: Map<string, { expand?: { author?: { name?: string } } }>
                        }
                    }
                )._state.syncedData
                await waitFor(
                    () => expect(synced.get(bookId)?.expand?.author?.name).toBe('While Pending'),
                    { timeout: 10000 }
                )
                expect(result.current.data[0]?.title).toBe('Optimistic')

                releaseUpdate()
                await tx.isPersisted.promise
                await waitFor(() => expect(result.current.data[0]?.title).toBe('Optimistic'))
                expect(result.current.data[0]?.expand?.author?.name).toBe('While Pending')
            } finally {
                releaseUpdate()
                await pb.collection('books').delete(bookId)
                await pb.collection('authors').delete(authorId)
            }
        }, 30000)

        it('runs the target handler once per event while dependents are patched', async () => {
            const authorId = await createAuthor()
            const bookId = await createBook(authorId)
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            try {
                const { result } = renderHook(() =>
                    useLiveQuery(q =>
                        q.from({ b: books.expand('author') }).where(({ b }) => eq(b.id, bookId))
                    )
                )
                await waitForLoadFinish(result, 10000)
                await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 10000 })
                await authors.waitForSubscription(10000)

                const authorsWrites = vi.spyOn(authors.utils, 'writeUpsert')
                await pb.collection('authors').update(authorId, { name: 'Handler Once' })
                await waitFor(
                    () => expect(result.current.data[0]?.expand?.author?.name).toBe('Handler Once'),
                    { timeout: 10000 }
                )
                expect(authorsWrites).toHaveBeenCalledTimes(1)
            } finally {
                await pb.collection('books').delete(bookId)
                await pb.collection('authors').delete(authorId)
            }
        }, 20000)
    })
})
