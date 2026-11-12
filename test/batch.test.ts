import { useLiveQuery } from '@tanstack/react-db'
import { renderHook, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { BatchMutationError, batch, createCollection } from '../src'
import {
    authenticateTestUser,
    clearAuth,
    getTestAuthorId,
    getTestSlug,
    newRecordId,
    pb,
    waitForLoadFinish,
} from './helpers'
import type { Schema } from './schema'

const stamped = { omitOnInsert: ['created', 'updated'] as const }

function collections() {
    const c = createCollection<Schema>(pb)
    return { books: c('books', stamped), tags: c('tags', stamped) }
}

function bookRow(authorId: string, overrides: Record<string, unknown> = {}) {
    return {
        id: newRecordId(),
        title: `Batch ${getTestSlug('b')}`,
        genre: 'Fiction' as const,
        isbn: getTestSlug('isbn'),
        author: authorId,
        published_date: '',
        page_count: 0,
        ...overrides,
    }
}

function tagRow(overrides: Record<string, unknown> = {}) {
    return { id: newRecordId(), name: `tag-${getTestSlug('t')}`, color: '', ...overrides }
}

async function exists(collection: string, id: string): Promise<boolean> {
    try {
        await pb.collection(collection).getOne(id)
        return true
    } catch {
        return false
    }
}

describe('batch', () => {
    let authorId = ''

    beforeAll(async () => {
        await authenticateTestUser()
        authorId = await getTestAuthorId()
    })

    afterAll(() => {
        clearAuth()
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('sends inserts, an update and a delete of two collections in one request', async () => {
        const { books, tags } = collections()
        const booksLive = renderHook(() => useLiveQuery(q => q.from({ book: books })))
        const tagsLive = renderHook(() => useLiveQuery(q => q.from({ tag: tags })))
        await waitForLoadFinish(booksLive.result)
        await waitForLoadFinish(tagsLive.result)

        const kept = tagRow()
        const removed = tagRow()
        await tags.insert(kept).when('settled')
        await tags.insert(removed).when('settled')

        const send = vi.spyOn(pb, 'send')
        const book = bookRow(authorId)
        await batch(() => {
            books.insert(book)
            tags.update(kept.id, draft => {
                draft.color = '#ff0000'
            })
            tags.delete(removed.id)
        })

        const requests = send.mock.calls.filter(([path]) => path === '/api/batch')
        expect(requests).toHaveLength(1)
        expect(send.mock.calls.some(([path]) => String(path).startsWith('/api/collections/'))).toBe(
            false
        )
        expect(await exists('books', book.id)).toBe(true)
        expect((await pb.collection('tags').getOne(kept.id)).color).toBe('#ff0000')
        expect(await exists('tags', removed.id)).toBe(false)

        // The landed rows are the server's rows and stay after the echo.
        await waitFor(() => {
            expect(books.get(book.id)?.created).toBeTruthy()
            expect(tags.get(kept.id)?.color).toBe('#ff0000')
            expect(tags.get(removed.id)).toBeUndefined()
        })
        await new Promise(resolve => setTimeout(resolve, 500))
        expect(booksLive.result.current.data.filter(row => row.id === book.id)).toHaveLength(1)
        expect(tags.get(kept.id)?.color).toBe('#ff0000')
    })

    it('rolls back every operation when one fails, and names the failed operation', async () => {
        const { books, tags } = collections()
        const booksLive = renderHook(() => useLiveQuery(q => q.from({ book: books })))
        const tagsLive = renderHook(() => useLiveQuery(q => q.from({ tag: tags })))
        await waitForLoadFinish(booksLive.result)
        await waitForLoadFinish(tagsLive.result)

        const tag = tagRow()
        const bad = bookRow(authorId, { title: '' })
        const failure = await batch(() => {
            tags.insert(tag)
            books.insert(bad)
        }).then(
            () => null,
            (error: unknown) => error
        )

        expect(failure).toBeInstanceOf(BatchMutationError)
        const error = failure as BatchMutationError
        expect(error.index).toBe(1)
        expect(error.collection).toBe('books')
        expect(error.recordId).toBe(bad.id)
        expect(error.status).toBe(400)
        expect(error.response.data).toHaveProperty('title')
        expect(error.cause).toBeTruthy()

        expect(await exists('tags', tag.id)).toBe(false)
        expect(await exists('books', bad.id)).toBe(false)
        expect(tags.get(tag.id)).toBeUndefined()
        expect(books.get(bad.id)).toBeUndefined()
    })

    it('sends an insert and a later update of the same row as one create', async () => {
        const { tags } = collections()
        const live = renderHook(() => useLiveQuery(q => q.from({ tag: tags })))
        await waitForLoadFinish(live.result)

        const send = vi.spyOn(pb, 'send')
        const tag = tagRow()
        await batch(() => {
            tags.insert(tag)
            tags.update(tag.id, draft => {
                draft.color = '#0000ff'
            })
        })

        const [, options] = send.mock.calls.find(([path]) => path === '/api/batch') ?? []
        const body = (options as { body: { requests: unknown[] } }).body
        expect(body.requests).toHaveLength(1)
        expect((await pb.collection('tags').getOne(tag.id)).color).toBe('#0000ff')
    })

    it('resolves with no request for an empty batch', async () => {
        const { tags } = collections()
        const live = renderHook(() => useLiveQuery(q => q.from({ tag: tags })))
        await waitForLoadFinish(live.result)

        const send = vi.spyOn(pb, 'send')
        await batch(() => {})
        const tag = tagRow()
        await batch(() => {
            tags.insert(tag)
            tags.delete(tag.id)
        })
        expect(send.mock.calls.filter(([path]) => path === '/api/batch')).toHaveLength(0)
        expect(tags.get(tag.id)).toBeUndefined()
    })

    it('refuses a collection with a custom or a disabled handler, with no request', async () => {
        const c = createCollection<Schema>(pb)
        const custom = c('tags', { ...stamped, onInsert: async () => {} })
        const disabled = c('tags', { ...stamped, onDelete: false })
        const customLive = renderHook(() => useLiveQuery(q => q.from({ tag: custom })))
        const disabledLive = renderHook(() => useLiveQuery(q => q.from({ tag: disabled })))
        await waitForLoadFinish(customLive.result)
        await waitForLoadFinish(disabledLive.result)

        const send = vi.spyOn(pb, 'send')
        const tag = tagRow()
        await expect(
            batch(() => {
                custom.insert(tag)
            })
        ).rejects.toThrow(/custom or disabled insert handler/)
        expect(custom.get(tag.id)).toBeUndefined()
        expect(send.mock.calls.filter(([path]) => path === '/api/batch')).toHaveLength(0)

        const stored = tagRow()
        await pb.collection('tags').create(stored)
        await disabled.utils.reload()
        await expect(
            batch(() => {
                disabled.delete(stored.id)
            })
        ).rejects.toThrow()
        expect(await exists('tags', stored.id)).toBe(true)
    })

    it('rolls back and sends nothing when the callback throws', async () => {
        const { tags } = collections()
        const live = renderHook(() => useLiveQuery(q => q.from({ tag: tags })))
        await waitForLoadFinish(live.result)

        const send = vi.spyOn(pb, 'send')
        const tag = tagRow()
        await expect(
            batch(() => {
                tags.insert(tag)
                throw new Error('stop')
            })
        ).rejects.toThrow('stop')
        expect(tags.get(tag.id)).toBeUndefined()
        expect(send.mock.calls.filter(([path]) => path === '/api/batch')).toHaveLength(0)
    })

    it('refuses an async callback', async () => {
        const { tags } = collections()
        const live = renderHook(() => useLiveQuery(q => q.from({ tag: tags })))
        await waitForLoadFinish(live.result)

        const tag = tagRow()
        const asyncFn = (async () => {
            tags.insert(tag)
        }) as unknown as () => void
        await expect(batch(asyncFn)).rejects.toThrow(/must be synchronous/)
        expect(tags.get(tag.id)).toBeUndefined()
    })

    it('passes through a failure that is not tied to one operation', async () => {
        const { tags } = collections()
        const live = renderHook(() => useLiveQuery(q => q.from({ tag: tags })))
        await waitForLoadFinish(live.result)

        // The test server allows 20 operations in one batch.
        const rows = Array.from({ length: 21 }, () => tagRow())
        const failure = await batch(() => {
            for (const row of rows) tags.insert(row)
        }).then(
            () => null,
            (error: unknown) => error
        )
        expect(failure).toBeTruthy()
        expect(failure).not.toBeInstanceOf(BatchMutationError)
        expect(tags.get(rows[0].id)).toBeUndefined()
        expect(await exists('tags', rows[0].id)).toBe(false)
    })
})
