import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { renderHook, waitFor } from '@testing-library/react'
import type { RecordSubscription } from 'pocketbase'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCollection } from '../src'
import { realtimeClientFor } from '../src/transport'

import {
    authenticateTestUser,
    clearAuth,
    createTestLogger,
    getTestAuthorId,
    getTestSlug,
    pb,
    resetLogger,
    setLogger,
    type TestLogger,
    waitForLoadFinish,
} from './helpers'
import type { Books, Schema } from './schema'

/**
 * Regression coverage for the optimistic-move "snap back" race with
 * refetchOnMutation at its default (false). `genre` stands in for a file's
 * folder: a `genre = SOURCE` live query is the current folder and
 * update(id, d => d.genre = DEST) is the move.
 *
 * A redelivered or reordered SSE echo can carry the pre-move row. The default
 * handlers write the server's response back, and ledger rule 4 decides each
 * echo: a strictly older `updated` is dropped, an equal or newer one lands.
 * Echoes go through the real subscription handler so the race is deterministic.
 */
describe('optimistic move snap-back via stale realtime echo (refetchOnMutation default)', () => {
    let testLogger: TestLogger

    const SOURCE_GENRE = 'Fiction' as const
    const DEST_GENRE = 'Mystery' as const

    beforeAll(async () => {
        await authenticateTestUser()
    })

    afterAll(() => {
        clearAuth()
    })

    beforeEach(() => {
        testLogger = createTestLogger()
        setLogger(testLogger)
    })

    afterEach(() => {
        resetLogger()
        vi.restoreAllMocks()
    })

    /**
     * Capture the realtime handler the collection registers so the test can feed
     * it a fabricated echo, exactly as a redelivered/out-of-order SSE event would
     * arrive. The real subscription is still established underneath.
     */
    const captureRealtimeHandler = () => {
        const ref: { current: ((event: RecordSubscription<Books>) => void) | null } = {
            current: null,
        }
        const client = realtimeClientFor(pb)
        const real = client.subscribe.bind(client)
        vi.spyOn(client, 'subscribe').mockImplementation((topic, listener) => {
            if (topic.startsWith('books/')) {
                ref.current = listener as unknown as (event: RecordSubscription<Books>) => void
            }
            return real(topic, listener)
        })
        return ref
    }

    const seedBook = async (genre: Books['genre']): Promise<Books> => {
        const authorId = await getTestAuthorId()
        const record = await pb.collection('books').create({
            title: `Snap-back ${Date.now().toString().slice(-8)}`,
            isbn: getTestSlug('snap'),
            genre,
            author: authorId,
            published_date: '',
            page_count: 1,
        })
        return record as unknown as Books
    }

    const syncedGet = (
        collection: { base: { get: (k: string) => Books | undefined } },
        id: string
    ) => collection.base.get(id)

    /** An ISO 8601 `updated` value one second older than the given record. */
    const olderThan = (record: Books): string => {
        const ms = Date.parse(record.updated.replace(' ', 'T'))
        return `${new Date(ms - 1000).toISOString().replace('T', ' ').replace('Z', '')}Z`
    }

    /**
     * Seed a row in the source folder and mount a live query filtered to that
     * folder, then move it to the destination folder and await persistence.
     */
    const moveOutOfSourceFolder = async () => {
        const handlerRef = captureRealtimeHandler()
        const seed = await seedBook(SOURCE_GENRE)

        const collection = createCollection<Schema>(pb)('books', {
            syncMode: 'on-demand',
        })

        const { result } = renderHook(() =>
            useLiveQuery(q =>
                q.from({ books: collection }).where(({ books }) => eq(books.genre, SOURCE_GENRE))
            )
        )
        await waitForLoadFinish(result, 10000)
        await collection.waitForSubscription()

        await waitFor(() => expect(result.current.data.find(b => b.id === seed.id)).toBeDefined(), {
            timeout: 10000,
        })
        expect(syncedGet(collection, seed.id)?.genre).toBe(SOURCE_GENRE)

        const tx = collection.update(seed.id, draft => {
            ;(draft as Books).genre = DEST_GENRE
        })

        // Optimistic overlay applied: the row leaves the source folder.
        await waitFor(
            () => expect(result.current.data.find(b => b.id === seed.id)).toBeUndefined(),
            { timeout: 2000 }
        )

        await tx.when('settled')
        expect(tx.state).toBe('completed')

        return { handlerRef, seed, collection, result }
    }

    it('writes the server response back so the synced layer holds the moved value', async () => {
        const { seed, collection, result } = await moveOutOfSourceFolder()

        // The default onUpdate wrote the PATCH response into the synced layer, so it
        // already reflects the destination folder — no stale value to fall back to.
        expect(syncedGet(collection, seed.id)?.genre).toBe(DEST_GENRE)

        // The row stays out of the source folder.
        await new Promise(r => setTimeout(r, 500))
        expect(result.current.data.find(b => b.id === seed.id)).toBeUndefined()

        await pb
            .collection('books')
            .delete(seed.id)
            .catch(() => {})
    }, 30000)

    it('ignores a stale realtime echo so the moved row does not snap back', async () => {
        const { handlerRef, seed, collection, result } = await moveOutOfSourceFolder()

        // An out-of-order / redelivered SSE echo carrying the pre-move folder with an
        // older timestamp lands during the window.
        expect(handlerRef.current).not.toBeNull()
        handlerRef.current?.({
            action: 'update',
            record: { ...seed, genre: SOURCE_GENRE, updated: olderThan(seed) },
        } as RecordSubscription<Books>)

        // The stale echo is dropped: the synced layer keeps the destination value and
        // the row does not reappear in the source folder.
        await new Promise(r => setTimeout(r, 750))
        expect(result.current.data.find(b => b.id === seed.id)).toBeUndefined()
        expect(syncedGet(collection, seed.id)?.genre).toBe(DEST_GENRE)
        // Ledger rule 4 drops a strictly older echo without a log; the synced genre proves it.

        await pb
            .collection('books')
            .delete(seed.id)
            .catch(() => {})
    }, 30000)

    it('still applies a genuinely newer realtime echo', async () => {
        const { handlerRef, seed, collection, result } = await moveOutOfSourceFolder()

        // A later, correctly-ordered echo from another client (newer timestamp)
        // changes a field and lands by ledger rule 4.
        const newerUpdated = `${new Date(Date.parse(seed.updated.replace(' ', 'T')) + 1000)
            .toISOString()
            .replace('T', ' ')
            .replace('Z', '')}Z`
        const newTitle = `Renamed ${Date.now().toString().slice(-8)}`
        handlerRef.current?.({
            action: 'update',
            record: { ...seed, genre: DEST_GENRE, title: newTitle, updated: newerUpdated },
        } as RecordSubscription<Books>)

        await waitFor(() => expect(syncedGet(collection, seed.id)?.title).toBe(newTitle), {
            timeout: 5000,
        })
        expect(syncedGet(collection, seed.id)?.genre).toBe(DEST_GENRE)
        expect(result.current.data.find(b => b.id === seed.id)).toBeUndefined()

        await pb
            .collection('books')
            .delete(seed.id)
            .catch(() => {})
    }, 30000)

    it('respects optimistic:false — the move only shows after the server confirms', async () => {
        const seed = await seedBook(SOURCE_GENRE)
        const collection = createCollection<Schema>(pb)('books', {
            syncMode: 'on-demand',
        })

        const { result } = renderHook(() =>
            useLiveQuery(q =>
                q.from({ books: collection }).where(({ books }) => eq(books.genre, SOURCE_GENRE))
            )
        )
        await waitForLoadFinish(result, 10000)
        await collection.waitForSubscription()
        await waitFor(() => expect(result.current.data.find(b => b.id === seed.id)).toBeDefined(), {
            timeout: 10000,
        })

        // Opt out of optimistic application: the row must NOT leave the source folder
        // until the server confirms. The write-back must not sneak the change in early.
        const tx = collection.update(seed.id, { optimistic: false }, draft => {
            ;(draft as Books).genre = DEST_GENRE
        })

        // Before persistence: still in the source folder, no optimistic overlay.
        expect(result.current.data.find(b => b.id === seed.id)).toBeDefined()
        const state = collection._state as unknown as {
            optimisticUpserts: { has: (k: string) => boolean }
            optimisticDeletes: { has: (k: string) => boolean }
        }
        expect(state.optimisticUpserts.has(seed.id)).toBe(false)
        expect(state.optimisticDeletes.has(seed.id)).toBe(false)

        await tx.when('settled')

        // Only now — after server confirmation — does the row reflect the move,
        // via the write-back applying the confirmed server value.
        await waitFor(
            () => expect(result.current.data.find(b => b.id === seed.id)).toBeUndefined(),
            { timeout: 5000 }
        )
        expect(syncedGet(collection, seed.id)?.genre).toBe(DEST_GENRE)

        await pb
            .collection('books')
            .delete(seed.id)
            .catch(() => {})
    }, 30000)
})
