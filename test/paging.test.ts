import { eq, type LiveQueryWindowCollection, useLiveQuery } from '@tanstack/react-db'
import type { QueryClient } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCollection } from '../src'
import {
    authenticateTestUser,
    clearAuth,
    createTestQueryClient,
    getTestSlug,
    pb,
    waitForLoadFinish,
} from './helpers'
import type { Schema } from './schema'

// Twenty-five books under one fresh author, page_count 1..25, so a sort by
// page_count is total and every window has a known answer.
const COUNT = 25

describe('paging', () => {
    let queryClient: QueryClient
    let authorId = ''
    const bookIds: string[] = []

    beforeAll(async () => {
        await authenticateTestUser()
        const author = await pb.collection('authors').create({
            name: `Paging ${getTestSlug('author')}`,
            email: `${getTestSlug('paging')}@example.com`,
        })
        authorId = author.id
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
})
