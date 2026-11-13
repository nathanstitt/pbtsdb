import { eq, useLiveQuery } from '@tanstack/react-db'
import { renderHook, waitFor } from '@testing-library/react'
import type { RecordSubscription } from 'pocketbase'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createCollection } from '../src'
import { realtimeClientFor } from '../src/transport'
import {
    authenticateTestUser,
    clearAuth,
    getTestSlug,
    pb,
    topicFilter,
    waitForLoadFinish,
} from './helpers'
import type { Authors, Books, Schema } from './schema'

/**
 * Realtime events of one SSE chunk are dispatched in one task. An echo that
 * files its relations first lands asynchronously, and a later event must
 * not apply before it.
 */
describe('realtime echo order', () => {
    const created: { collection: string; id: string }[] = []

    beforeAll(async () => {
        await authenticateTestUser()
    })

    afterAll(() => {
        clearAuth()
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        for (const { collection, id } of created.reverse()) {
            await pb
                .collection(collection)
                .delete(id)
                .catch(() => undefined)
        }
        created.length = 0
    })

    const settle = () => new Promise(resolve => setTimeout(resolve, 50))

    async function setup(tag: string) {
        const handlers = new Map<string, (event: RecordSubscription<Books>) => void>()
        const client = realtimeClientFor(pb)
        const real = client.subscribe.bind(client)
        vi.spyOn(client, 'subscribe').mockImplementation((topic, listener) => {
            const filter = topic.startsWith('books/') ? topicFilter(topic) : undefined
            if (filter) {
                handlers.set(filter, listener as unknown as (e: RecordSubscription<Books>) => void)
            }
            return real(topic, listener)
        })

        const author = await pb.collection('authors').create<Authors>({
            name: `Order ${getTestSlug(tag)}`,
            bio: '',
            email: `${getTestSlug(tag)}@example.com`,
        })
        created.push({ collection: 'authors', id: author.id })
        const title = `Order ${getTestSlug(tag)}`
        const seed = await pb.collection('books').create<Books>({
            title,
            isbn: getTestSlug(tag),
            genre: 'Fiction',
            author: author.id,
            published_date: '',
            page_count: 1,
        })
        created.push({ collection: 'books', id: seed.id })

        const c = createCollection<Schema>(pb)
        const authors = c('authors', {
            syncMode: 'on-demand',
            realtime: 'query',
            collectionOptions: { gcTime: 60_000 },
        })
        const books = c('books', {
            syncMode: 'on-demand',
            realtime: 'query',
            relations: { author: authors },
            alwaysFetchRelations: ['author'],
            collectionOptions: { gcTime: 60_000 },
        })
        const query = renderHook(() =>
            useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.title, title)))
        )
        await waitForLoadFinish(query.result)
        await books.waitForSubscription()
        // The seed row filed its author, so the relation target is ready and
        // an echo with an expand files first.
        expect(authors.get(author.id)).toBeDefined()
        let dispatch: ((event: RecordSubscription<Books>) => void) | undefined
        await waitFor(() => {
            dispatch = [...handlers].find(([filter]) => filter.includes(title))?.[1]
            expect(dispatch).toBeDefined()
        })
        if (!dispatch) throw new Error('no topic handler for the title query')

        const id = `${seed.id.slice(0, 10)}order`
        const echo = (
            action: string,
            page_count: number,
            withExpand: boolean
        ): RecordSubscription<Books> => ({
            action,
            record: {
                ...seed,
                id,
                page_count,
                ...(withExpand ? { expand: { author } } : {}),
            } as unknown as Books,
        })
        const cleanup = async () => {
            query.unmount()
            await books.cleanup()
            await authors.cleanup()
        }
        return { books, dispatch, id, echo, cleanup }
    }

    it('a delete after a create and an update in one task removes the row', async () => {
        const { books, dispatch, id, echo, cleanup } = await setup('cud')
        try {
            dispatch(echo('create', 1, true))
            dispatch(echo('update', 2, true))
            dispatch({ action: 'delete', record: { id } as unknown as Books })
            await settle()
            expect(books.base.has(id)).toBe(false)
        } finally {
            await cleanup()
        }
    }, 30000)

    it('an update without an expand does not land before an earlier create', async () => {
        const { books, dispatch, id, echo, cleanup } = await setup('cu')
        try {
            dispatch(echo('create', 1, true))
            dispatch(echo('update', 2, false))
            await settle()
            expect(books.base.get(id)?.page_count).toBe(2)
        } finally {
            await cleanup()
        }
    }, 30000)

    it('an event applies at once when no echo is pending', async () => {
        const { books, dispatch, id, echo, cleanup } = await setup('sync')
        try {
            dispatch(echo('create', 1, false))
            expect(books.base.get(id)?.page_count).toBe(1)
            dispatch({ action: 'delete', record: { id } as unknown as Books })
            expect(books.base.has(id)).toBe(false)
        } finally {
            await cleanup()
        }
    }, 30000)
})
