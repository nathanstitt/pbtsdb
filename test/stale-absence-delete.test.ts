import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import type { QueryClient } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
    authenticateTestUser,
    clearAuth,
    createCollectionFactory,
    createTestQueryClient,
    getTestAuthorId,
    getTestSlug,
    newRecordId,
    pb,
} from './helpers'
import type { Books } from './schema'

/**
 * Regression coverage for the stale-ABSENCE delete: the missing arm of the
 * query-result revert family covered by query-result-revert.test.ts.
 *
 * A subset fetch is issued while the server has no matching rows. Before it
 * resolves, the client inserts a row and the mutation settles — the write-back
 * puts the confirmed row in the synced store, and query-db-collection's manual
 * write path (updateCacheData) pushes the synced store into every cached query
 * for the collection, so the in-flight query's key now OWNS the row. When the
 * slow fetch finally resolves with its pre-insert (empty) result,
 * applySuccessfulResult diffs it against that baseline and reconcile-DELETES
 * the newer row. shouldDropSyncedWrite never sees it: deletes are exempt.
 *
 * The row is confirmed to exist on the server, yet it vanishes from the local
 * store with no delete ever issued — observed in production as checklist items
 * disappearing when added right after opening a card.
 */
describe('stale-absence reconcile delete (on-demand)', () => {
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
        vi.restoreAllMocks()
    })

    const syncedGet = (collection: unknown, id: string) =>
        (
            collection as {
                _state: { syncedData: { get: (k: string) => Books | undefined } }
            }
        )._state.syncedData.get(id)

    it('keeps a row confirmed while the subset fetch was in flight', async () => {
        const slug = getTestSlug('absent')
        const collection = createCollectionFactory(queryClient).create('books', {
            syncMode: 'on-demand',
            omitOnInsert: ['created', 'updated'] as const,
        })

        // Hold the subset fetch for this slug in flight, then resolve it with
        // the server state from when it was ISSUED: no rows.
        const realGetFullList = pb.collection('books').getFullList.bind(pb.collection('books'))
        const control = { served: 0 }
        let releaseFetch: () => void = () => {}
        const fetchGate = new Promise<void>(resolve => {
            releaseFetch = resolve
        })
        vi.spyOn(pb.collection('books'), 'getFullList').mockImplementation(
            async (...args: Parameters<typeof realGetFullList>) => {
                const filter = (args[0] as { filter?: string } | undefined)?.filter ?? ''
                if (filter.includes(slug)) {
                    control.served++
                    await fetchGate
                    return [] as unknown as ReturnType<typeof realGetFullList>
                }
                return realGetFullList(...args)
            }
        )

        const { result } = renderHook(() =>
            useLiveQuery(q =>
                q.from({ books: collection }).where(({ books }) => eq(books.isbn, slug))
            )
        )
        await waitFor(() => expect(control.served).toBeGreaterThan(0), { timeout: 10000 })

        // Insert a matching row while that fetch is still in flight, and let
        // the mutation fully settle: the row is now confirmed on the server.
        const authorId = await getTestAuthorId()
        const newBook = {
            id: newRecordId(),
            title: `Stale Absence ${Date.now().toString().slice(-8)}`,
            genre: 'Fiction' as const,
            isbn: slug,
            author: authorId,
            published_date: '',
            page_count: 1,
        }
        const tx = collection.insert(newBook)
        await tx.isPersisted.promise
        expect(tx.state).toBe('completed')
        await waitFor(() => expect(syncedGet(collection, newBook.id)).toBeDefined(), {
            timeout: 5000,
        })

        // The stale (empty) result lands now. It must not delete the row it
        // predates.
        releaseFetch()
        await new Promise(r => setTimeout(r, 400))

        expect(syncedGet(collection, newBook.id)).toBeDefined()
        expect(result.current.data.find(b => b.id === newBook.id)).toBeDefined()

        await pb
            .collection('books')
            .delete(newBook.id)
            .catch(() => {})
    }, 30000)

    it('still prunes a row that a fetch issued after its write no longer returns', async () => {
        // The other side of the guard: once a fetch is issued AFTER the row's
        // last confirmed write, its result speaks authoritatively — an absence
        // must still prune, or moved/deleted rows would be retained forever.
        const slug = getTestSlug('prune')
        const collection = createCollectionFactory(queryClient).create('books', {
            syncMode: 'on-demand',
            omitOnInsert: ['created', 'updated'] as const,
        })

        const realGetFullList = pb.collection('books').getFullList.bind(pb.collection('books'))
        const control = { serveEmpty: false, served: 0 }
        vi.spyOn(pb.collection('books'), 'getFullList').mockImplementation(
            async (...args: Parameters<typeof realGetFullList>) => {
                const filter = (args[0] as { filter?: string } | undefined)?.filter ?? ''
                if (control.serveEmpty && filter.includes(slug)) {
                    control.served++
                    return [] as unknown as ReturnType<typeof realGetFullList>
                }
                return realGetFullList(...args)
            }
        )

        const { result } = renderHook(() =>
            useLiveQuery(q =>
                q.from({ books: collection }).where(({ books }) => eq(books.isbn, slug))
            )
        )

        const authorId = await getTestAuthorId()
        const newBook = {
            id: newRecordId(),
            title: `Prune ${Date.now().toString().slice(-8)}`,
            genre: 'Fiction' as const,
            isbn: slug,
            author: authorId,
            published_date: '',
            page_count: 1,
        }
        const tx = collection.insert(newBook)
        await tx.isPersisted.promise
        await waitFor(() => expect(syncedGet(collection, newBook.id)).toBeDefined(), {
            timeout: 5000,
        })

        // A refetch issued now — after the write — returns empty (as if another
        // client deleted the row). The prune must apply.
        control.serveEmpty = true
        await collection.utils.refetch()
        await waitFor(() => expect(syncedGet(collection, newBook.id)).toBeUndefined(), {
            timeout: 5000,
        })
        expect(result.current.data.find(b => b.id === newBook.id)).toBeUndefined()

        await pb
            .collection('books')
            .delete(newBook.id)
            .catch(() => {})
    }, 30000)
})
