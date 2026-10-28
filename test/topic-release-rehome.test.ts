import { eq, useLiveQuery } from '@tanstack/react-db'
import { renderHook, waitFor } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCollection } from '../src'
import {
    authenticateTestUser,
    clearAuth,
    getTestAuthorId,
    getTestSlug,
    pb,
    waitForLoadFinish,
} from './helpers'
import type { Books, Schema } from './schema'

/**
 * A filter entry stays closed while '*' is open, so a row created while an
 * unfiltered query is mounted arrives on '*' alone. When that query expires
 * and '*' closes, the row must stay for a filtered query that matches it.
 */
describe("closing '*' keeps rows a live filtered query matches", () => {
    beforeAll(async () => {
        await authenticateTestUser()
    })

    afterAll(() => {
        clearAuth()
    })

    const createBook = async (isbn: string) =>
        pb.collection('books').create<Books>({
            title: `Rehome ${Date.now().toString().slice(-8)}`,
            isbn,
            genre: 'Fiction',
            author: await getTestAuthorId(),
            published_date: '',
            page_count: 1,
        })

    it('keeps a matching row and releases a row no query matches', async () => {
        const books = createCollection<Schema>(pb)('books', {
            syncMode: 'on-demand',
            realtime: 'query',
            subsetGcTime: 300,
        })
        const isbn = getTestSlug('isbn')
        const filtered = renderHook(() =>
            useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.isbn, isbn)))
        )
        await waitForLoadFinish(filtered.result, 10000)
        await books.waitForSubscription()
        const unfiltered = renderHook(() => useLiveQuery(q => q.from({ b: books })))
        await waitForLoadFinish(unfiltered.result, 10000)

        const matching = await createBook(isbn)
        const other = await createBook(getTestSlug('isbo'))
        try {
            await waitFor(
                () => {
                    expect(filtered.result.current.data.map(row => row.id)).toContain(matching.id)
                    expect(books.has(other.id)).toBe(true)
                },
                { timeout: 5000 }
            )

            unfiltered.unmount()
            await waitFor(() => expect(books.has(other.id)).toBe(false), { timeout: 5000 })
            expect(filtered.result.current.data.map(row => row.id)).toContain(matching.id)
        } finally {
            filtered.unmount()
            await pb
                .collection('books')
                .delete(matching.id)
                .catch(() => {})
            await pb
                .collection('books')
                .delete(other.id)
                .catch(() => {})
        }
    }, 30000)
})
