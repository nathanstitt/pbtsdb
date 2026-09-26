import { useLiveQuery } from '@tanstack/react-db'
import type { QueryClient } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createCollection } from '../src'
import {
    authenticateTestUser,
    clearAuth,
    createTestQueryClient,
    pb,
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
})
