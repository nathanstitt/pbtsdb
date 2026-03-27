import { renderHook } from '@testing-library/react'
import { useLiveQuery, eq, toArray } from '@tanstack/react-db'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'

import { createCollection } from '../src/collection'
import type { Schema } from './schema'
import {
    pb,
    createTestQueryClient,
    authenticateTestUser,
    clearAuth,
    createTestLogger,
    setLogger,
    resetLogger,
    waitForLoadFinish,
} from './helpers'

describe('TanStack DB Includes (Subquery) Feature', () => {
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

    it('should include author as nested subquery using findOne()', async () => {
        const c = createCollection<Schema>(pb, queryClient)
        const authorsCollection = c('authors', { syncMode: 'eager' })
        const booksCollection = c('books', { syncMode: 'eager' })

        const { result } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ b: booksCollection }).select(({ b }) => ({
                    id: b.id,
                    title: b.title,
                    authorInfo: q
                        .from({ a: authorsCollection })
                        .where(({ a }) => eq(a.id, b.author))
                        .select(({ a }) => ({ id: a.id, name: a.name }))
                        .findOne(),
                })),
            ),
        )

        await waitForLoadFinish(result, 10000)

        const books = result.current.data
        expect(books.length).toBeGreaterThan(0)

        const firstBook = books[0]
        expect(firstBook.id).toBeDefined()
        expect(firstBook.title).toBeDefined()

        // authorInfo is a Collection wrapper from the subquery include;
        // verify the included collection was created
        expect(firstBook.authorInfo).toBeDefined()
        const authorValues = Array.from(firstBook.authorInfo.values())
        expect(authorValues.length).toBe(1)
        expect(authorValues[0].id).toBeTypeOf('string')
        expect(authorValues[0].name).toBeTypeOf('string')
    }, 15000)

    it('should include tags as array using toArray()', async () => {
        const c = createCollection<Schema>(pb, queryClient)
        const booksCollection = c('books', { syncMode: 'eager' })
        const bookTagsCollection = c('book_tags', { syncMode: 'eager' })
        const tagsCollection = c('tags', { syncMode: 'eager' })

        const { result } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ b: booksCollection }).select(({ b }) => ({
                    id: b.id,
                    title: b.title,
                    tags: toArray(
                        q
                            .from({ bt: bookTagsCollection })
                            .where(({ bt }) => eq(bt.book, b.id))
                            .join(
                                { t: tagsCollection },
                                ({ bt, t }) => eq(bt.tag, t.id),
                            )
                            .select(({ t }) => ({ id: t.id, name: t.name })),
                    ),
                })),
            ),
        )

        await waitForLoadFinish(result, 10000)

        const books = result.current.data
        expect(books.length).toBeGreaterThan(0)

        const firstBook = books[0]
        expect(firstBook.id).toBeDefined()
        expect(firstBook.title).toBeDefined()
        expect(Array.isArray(firstBook.tags)).toBe(true)

        // At least one book should have tags in our test data
        const bookWithTags = books.find((b) => b.tags.length > 0)
        if (bookWithTags) {
            expect(bookWithTags.tags[0].id).toBeTypeOf('string')
            expect(bookWithTags.tags[0].name).toBeTypeOf('string')
        }
    }, 15000)

    it('should work with expand + includes coexistence', async () => {
        const c = createCollection<Schema>(pb, queryClient)
        const authorsCollection = c('authors', { syncMode: 'on-demand' })
        const booksCollection = c('books', {
            syncMode: 'on-demand',
            expand: {
                author: authorsCollection,
            },
        })
        const bookTagsCollection = c('book_tags', { syncMode: 'eager' })
        const tagsCollection = c('tags', { syncMode: 'eager' })

        // Use expand to auto-populate authorsCollection, then use includes to query from it
        const { result } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ b: booksCollection }).select(({ b }) => ({
                    id: b.id,
                    title: b.title,
                    author: q
                        .from({ a: authorsCollection })
                        .where(({ a }) => eq(a.id, b.author))
                        .select(({ a }) => ({ id: a.id, name: a.name }))
                        .findOne(),
                    tags: toArray(
                        q
                            .from({ bt: bookTagsCollection })
                            .where(({ bt }) => eq(bt.book, b.id))
                            .join(
                                { t: tagsCollection },
                                ({ bt, t }) => eq(bt.tag, t.id),
                            )
                            .select(({ t }) => ({ id: t.id, name: t.name })),
                    ),
                })),
            ),
        )

        await waitForLoadFinish(result, 10000)

        const books = result.current.data
        expect(books.length).toBeGreaterThan(0)

        const firstBook = books[0]
        expect(firstBook.id).toBeTypeOf('string')
        expect(firstBook.title).toBeTypeOf('string')
        expect(firstBook.author).toBeDefined()
        expect(Array.isArray(firstBook.tags)).toBe(true)
    }, 15000)
})
