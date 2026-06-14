import { useLiveQuery } from '@tanstack/react-db'
import type { QueryClient } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
    authenticateTestUser,
    clearAuth,
    createCollectionFactory,
    createTestLogger,
    createTestQueryClient,
    getTestAuthorId,
    getTestSlug,
    pb,
    resetLogger,
    setLogger,
    type TestLogger,
    waitForLoadFinish,
    waitForSubscription,
} from './helpers'

/**
 * Regression coverage for the realtime delete echo throwing
 * DeleteOperationItemNotFoundError when the record was already removed from the
 * synced store before the echo arrived (see handleRealtimeEvent in collection.ts).
 *
 * The handler swallows that specific error and logs a debug breadcrumb, so the
 * tests assert on (a) no uncaught error and (b) the breadcrumb firing.
 */
describe('realtime delete echo idempotency', () => {
    let queryClient: QueryClient
    let testLogger: TestLogger
    const captured: Error[] = []

    const onUncaught = (err: Error) => captured.push(err)
    const onUnhandledRejection = (reason: unknown) =>
        captured.push(reason instanceof Error ? reason : new Error(String(reason)))

    beforeAll(async () => {
        await authenticateTestUser()
        process.on('uncaughtException', onUncaught)
        process.on('unhandledRejection', onUnhandledRejection)
    })

    afterAll(() => {
        process.off('uncaughtException', onUncaught)
        process.off('unhandledRejection', onUnhandledRejection)
        clearAuth()
    })

    beforeEach(() => {
        captured.length = 0
        testLogger = createTestLogger()
        setLogger(testLogger)
        queryClient = createTestQueryClient()
    })

    afterEach(() => {
        resetLogger()
        queryClient.clear()
    })

    const seedBook = async () => {
        const authorId = await getTestAuthorId()
        return pb.collection('books').create({
            title: `Echo Idempotency ${Date.now().toString().slice(-8)}`,
            isbn: getTestSlug('rde'),
            genre: 'Fiction',
            author: authorId,
            published_date: '',
            page_count: 0,
        })
    }

    const syncedHas = (collection: unknown, id: string) =>
        (
            collection as { _state: { syncedData: { has: (k: string) => boolean } } }
        )._state.syncedData.has(id)

    const ignoredEchoLogs = () =>
        testLogger.messages.debug.filter(m => m.msg.includes('Ignoring delete echo'))

    it('on-demand: delete echo for an already-pruned key is swallowed', async () => {
        const collection = createCollectionFactory(queryClient).create('books', {
            syncMode: 'on-demand',
        })

        const { result } = renderHook(() => useLiveQuery(q => q.from({ books: collection })))
        await waitFor(
            () => {
                expect(result.current.isLoading).toBe(false)
                expect(result.current.data.length).toBeGreaterThan(0)
            },
            { timeout: 10000 }
        )
        await waitForSubscription(collection)

        const seed = await seedBook()
        await waitFor(() => expect(result.current.data.find(b => b.id === seed.id)).toBeDefined())
        expect(syncedHas(collection, seed.id)).toBe(true)

        // Drive the exact failing call: the realtime delete handler calls
        // writeDelete inside a writeBatch. Replay that against the live key so the
        // first call removes it from the synced store, then simulate the echo
        // arriving for the now-absent key (the on-demand prune-then-echo race).
        collection.utils.writeBatch(() => collection.utils.writeDelete(seed.id))
        expect(syncedHas(collection, seed.id)).toBe(false)

        // The realtime echo for the same key. Without the fix this throws
        // DeleteOperationItemNotFoundError out of writeBatch.
        const echo = () => collection.utils.writeBatch(() => collection.utils.writeDelete(seed.id))
        expect(echo).toThrowError(/Delete operation: Item with key/i)

        // Cleanup
        try {
            await pb.collection('books').delete(seed.id)
        } catch (_e) {
            // already gone
        }
    }, 25000)

    it('on-demand: real delete echo for a pruned key does not surface an uncaught error', async () => {
        const collection = createCollectionFactory(queryClient).create('books', {
            syncMode: 'on-demand',
        })

        const { result } = renderHook(() => useLiveQuery(q => q.from({ books: collection })))
        await waitFor(
            () => {
                expect(result.current.isLoading).toBe(false)
                expect(result.current.data.length).toBeGreaterThan(0)
            },
            { timeout: 10000 }
        )
        await waitForSubscription(collection)

        const seed = await seedBook()
        await waitFor(() => expect(result.current.data.find(b => b.id === seed.id)).toBeDefined())

        // Prune from the synced store first, then fire the real server delete so the
        // genuine SSE echo runs through handleRealtimeEvent against an absent key.
        collection.utils.writeBatch(() => collection.utils.writeDelete(seed.id))
        await pb.collection('books').delete(seed.id)
        await new Promise(r => setTimeout(r, 2000))

        expect(
            captured.filter(e => /Delete operation: Item with key/i.test(e.message))
        ).toHaveLength(0)
        expect(ignoredEchoLogs().length).toBeGreaterThan(0)
        expect(result.current.data.find(b => b.id === seed.id)).toBeUndefined()
    }, 25000)

    it('on-demand: normal delete echo still removes the row', async () => {
        const collection = createCollectionFactory(queryClient).create('books', {
            syncMode: 'on-demand',
        })

        const { result } = renderHook(() => useLiveQuery(q => q.from({ books: collection })))
        await waitFor(
            () => {
                expect(result.current.isLoading).toBe(false)
                expect(result.current.data.length).toBeGreaterThan(0)
            },
            { timeout: 10000 }
        )
        await waitForSubscription(collection)

        const seed = await seedBook()
        await waitFor(() => expect(result.current.data.find(b => b.id === seed.id)).toBeDefined())

        await pb.collection('books').delete(seed.id)

        await waitFor(
            () => expect(result.current.data.find(b => b.id === seed.id)).toBeUndefined(),
            {
                timeout: 5000,
            }
        )
        expect(ignoredEchoLogs()).toHaveLength(0)
        expect(syncedHas(collection, seed.id)).toBe(false)
    }, 25000)

    it('eager default: optimistic delete + echo does not throw', async () => {
        const collection = createCollectionFactory(queryClient).create('books')

        const { result } = renderHook(() => useLiveQuery(q => q.from({ books: collection })))
        await waitForLoadFinish(result)
        await waitForSubscription(collection)

        const seed = await seedBook()
        await waitFor(() => expect(result.current.data.find(b => b.id === seed.id)).toBeDefined())

        const tx = collection.delete(seed.id)
        await tx.isPersisted.promise
        await new Promise(r => setTimeout(r, 1500))

        expect(
            captured.filter(e => /Delete operation: Item with key/i.test(e.message))
        ).toHaveLength(0)
        expect(result.current.data.find(b => b.id === seed.id)).toBeUndefined()
    }, 25000)
})
