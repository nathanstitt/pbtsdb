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
})
