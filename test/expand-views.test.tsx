import { eq, useLiveQuery } from '@tanstack/react-db'
import type { QueryClient } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createCollection } from '../src'
import {
    authenticateTestUser,
    clearAuth,
    createTestLogger,
    createTestQueryClient,
    pb,
    resetLogger,
    setLogger,
    waitForLoadFinish,
} from './helpers'
import type { Schema } from './schema'

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
    })
})
