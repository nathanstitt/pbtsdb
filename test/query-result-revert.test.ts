import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import type { QueryClient } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
import type { Books } from './schema'

/**
 * Regression coverage for the residual optimistic-move "snap back" reported in 0.6.1:
 * a concurrent on-demand QUERY result reverts a freshly-committed optimistic move.
 *
 * PR #6 guarded the realtime-echo and mutation-response write paths. It did not cover
 * the query-result path: @tanstack/query-db-collection's applySuccessfulResult
 * reconciles every query result into the synced store via the sync `write` primitive
 * with no recency/optimistic check. Under contention a single-row/subset read can
 * resolve with a pre-move row and land here after the move already committed, reverting
 * it. pbtsdb now guards that path (drop synced insert/update for an optimistically
 * pending key, or one strictly older than the synced row).
 *
 * `genre` stands in for a file's parent folder, exactly as in
 * refetch-on-mutation-revert.test.ts: a `genre = SOURCE` live query is the "current
 * folder" and update(id, d => d.genre = DEST) is the move. A `where(id = X)` live query
 * is the app's "resolve selected item" resolver — the query that, in the report, served
 * the stale read.
 *
 * The race is made deterministic by stubbing the id= resolver's server fetch to return
 * the pre-move row, then refetching it after the move has committed. The id= query must
 * already OWN the row (be mounted, hydrated) before the stale refetch, because
 * applySuccessfulResult only reconciles rows a query already owns against its baseline.
 */
describe('optimistic move snap-back via stale query result (on-demand)', () => {
    let queryClient: QueryClient
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
        queryClient = createTestQueryClient()
    })

    afterEach(() => {
        resetLogger()
        queryClient.clear()
        vi.restoreAllMocks()
    })

    const seedBook = async (genre: Books['genre']): Promise<Books> => {
        const authorId = await getTestAuthorId()
        const record = await pb.collection('books').create({
            title: `QResult ${Date.now().toString().slice(-8)}`,
            isbn: getTestSlug('qres'),
            genre,
            author: authorId,
            published_date: '',
            page_count: 1,
        })
        return record as unknown as Books
    }

    const syncedGet = (collection: unknown, id: string) =>
        (
            collection as {
                _state: { syncedData: { get: (k: string) => Books | undefined } }
            }
        )._state.syncedData.get(id)

    const hasPendingOverlay = (collection: unknown, id: string): boolean => {
        const state = (
            collection as {
                _state: {
                    optimisticUpserts: { has: (k: string) => boolean }
                    optimisticDeletes: { has: (k: string) => boolean }
                }
            }
        )._state
        return state.optimisticUpserts.has(id) || state.optimisticDeletes.has(id)
    }

    /** An ISO 8601 `updated` value offset from the given record by `deltaMs`. */
    const offsetUpdated = (record: Books, deltaMs: number): string => {
        const ms = Date.parse(record.updated.replace(' ', 'T'))
        return `${new Date(ms + deltaMs).toISOString().replace('T', ' ').replace('Z', '')}Z`
    }

    /**
     * Mount the "current folder" and "resolve selected item" queries, seed a row in
     * SOURCE, move it to DEST and let the move fully commit. Returns hooks plus a setter
     * to arm the stale id= read for the refetch the caller drives next.
     */
    const moveWithIdResolverMounted = async (staleRow: Books) => {
        const seed = staleRow
        const collection = createCollectionFactory(queryClient).create('books', {
            syncMode: 'on-demand',
        })

        const realGetFullList = pb.collection('books').getFullList.bind(pb.collection('books'))
        const control = { serveStale: false, served: 0 }
        vi.spyOn(pb.collection('books'), 'getFullList').mockImplementation(
            async (...args: Parameters<typeof realGetFullList>) => {
                const filter = (args[0] as { filter?: string } | undefined)?.filter ?? ''
                if (control.serveStale && filter.includes(seed.id) && !filter.includes('genre')) {
                    control.served++
                    return [{ ...staleRow }] as unknown as ReturnType<typeof realGetFullList>
                }
                return realGetFullList(...args)
            }
        )

        const { result: folderResult } = renderHook(() =>
            useLiveQuery(q =>
                q.from({ books: collection }).where(({ books }) => eq(books.genre, SOURCE_GENRE))
            )
        )
        const { result: idResult } = renderHook(() =>
            useLiveQuery(q =>
                q.from({ books: collection }).where(({ books }) => eq(books.id, seed.id))
            )
        )
        await waitForLoadFinish(folderResult, 10000)
        await waitForLoadFinish(idResult, 10000)
        await waitForSubscription(collection)
        await waitFor(
            () => expect(folderResult.current.data.find(b => b.id === seed.id)).toBeDefined(),
            { timeout: 10000 }
        )
        expect(syncedGet(collection, seed.id)?.genre).toBe(SOURCE_GENRE)

        const tx = collection.update(seed.id, draft => {
            ;(draft as Books).genre = DEST_GENRE
        })
        await waitFor(
            () => expect(folderResult.current.data.find(b => b.id === seed.id)).toBeUndefined(),
            { timeout: 2000 }
        )
        await tx.isPersisted.promise
        expect(tx.state).toBe('completed')
        expect(syncedGet(collection, seed.id)?.genre).toBe(DEST_GENRE)

        return { collection, folderResult, idResult, control }
    }

    it('does not revert a committed move when a concurrent id= read returns the pre-move row', async () => {
        const seed = await seedBook(SOURCE_GENRE)
        const { collection, folderResult, control } = await moveWithIdResolverMounted(seed)

        // A stale read lands for the already-owning id= query: its refetch returns the
        // pre-move row (genre = SOURCE), strictly older than the just-committed synced
        // value. applySuccessfulResult would write it into syncedData; the guard drops it.
        control.serveStale = true
        await collection.utils.refetch()
        await new Promise(r => setTimeout(r, 400))

        expect(control.served).toBeGreaterThan(0)
        expect(syncedGet(collection, seed.id)?.genre).toBe(DEST_GENRE)
        expect(folderResult.current.data.find(b => b.id === seed.id)).toBeUndefined()
        expect(
            testLogger.messages.debug.some(m => m.msg.includes('Dropping stale synced write'))
        ).toBe(true)

        await pb
            .collection('books')
            .delete(seed.id)
            .catch(() => {})
    }, 30000)

    it('holds the move when a same-timestamp stale read lands while it is still in flight', async () => {
        // The report's primary case: a sub-second move whose stale read carries the
        // SAME `updated` second as the value it would revert (PR #6's strict-`<`
        // timestamp guard misses equality). The optimistic-pending arm is the backstop
        // for the window where the move has committed to synced but its overlay is still
        // present. Whichever arm fires, the move must never snap back.
        const seed = await seedBook(SOURCE_GENRE)
        const staleRow: Books = { ...seed } // genre = SOURCE, identical `updated`

        const collection = createCollectionFactory(queryClient).create('books', {
            syncMode: 'on-demand',
        })

        const realGetFullList = pb.collection('books').getFullList.bind(pb.collection('books'))
        const realUpdate = pb.collection('books').update.bind(pb.collection('books'))
        const control = { serveStale: false, served: 0 }
        let releasePatch: () => void = () => {}
        const patchGate = new Promise<void>(resolve => {
            releasePatch = resolve
        })

        vi.spyOn(pb.collection('books'), 'getFullList').mockImplementation(
            async (...args: Parameters<typeof realGetFullList>) => {
                const filter = (args[0] as { filter?: string } | undefined)?.filter ?? ''
                if (control.serveStale && filter.includes(seed.id) && !filter.includes('genre')) {
                    control.served++
                    return [{ ...staleRow }] as unknown as ReturnType<typeof realGetFullList>
                }
                return realGetFullList(...args)
            }
        )
        vi.spyOn(pb.collection('books'), 'update').mockImplementation(
            async (...args: Parameters<typeof realUpdate>) => {
                await patchGate
                return realUpdate(...args)
            }
        )

        const { result: folderResult } = renderHook(() =>
            useLiveQuery(q =>
                q.from({ books: collection }).where(({ books }) => eq(books.genre, SOURCE_GENRE))
            )
        )
        const { result: idResult } = renderHook(() =>
            useLiveQuery(q =>
                q.from({ books: collection }).where(({ books }) => eq(books.id, seed.id))
            )
        )
        await waitForLoadFinish(folderResult, 10000)
        await waitForLoadFinish(idResult, 10000)
        await waitForSubscription(collection)
        await waitFor(
            () => expect(folderResult.current.data.find(b => b.id === seed.id)).toBeDefined(),
            { timeout: 10000 }
        )

        // Optimistic move with the PATCH gated: the overlay (DEST) is in flight, the row
        // has left the SOURCE folder, but nothing is committed to the synced layer yet.
        const tx = collection.update(seed.id, draft => {
            ;(draft as Books).genre = DEST_GENRE
        })
        await waitFor(
            () => expect(folderResult.current.data.find(b => b.id === seed.id)).toBeUndefined(),
            { timeout: 2000 }
        )

        // The stale id= read lands now, while the move is pending, and again right after
        // the PATCH commits (when synced flips to DEST but the overlay lingers). The
        // visible value must never flip back to the SOURCE folder at any point.
        control.serveStale = true
        await collection.utils.refetch()
        await new Promise(r => setTimeout(r, 100))

        const reverted: string[] = []
        const sampler = setInterval(() => {
            if (folderResult.current.data.find(b => b.id === seed.id)) reverted.push('folder')
            const g = syncedGet(collection, seed.id)?.genre
            if (g === SOURCE_GENRE && !hasPendingOverlay(collection, seed.id))
                reverted.push('synced')
        }, 5)

        // Release the PATCH (synced -> DEST) and keep hammering the stale refetch across
        // the settle, covering the overlay-present-but-synced-fresh window.
        releasePatch()
        for (let i = 0; i < 4; i++) {
            await collection.utils.refetch().catch(() => {})
            await new Promise(r => setTimeout(r, 50))
        }
        await tx.isPersisted.promise
        expect(tx.state).toBe('completed')
        await new Promise(r => setTimeout(r, 300))
        clearInterval(sampler)

        expect(control.served).toBeGreaterThan(0)
        expect(reverted).toEqual([])
        expect(syncedGet(collection, seed.id)?.genre).toBe(DEST_GENRE)
        expect(folderResult.current.data.find(b => b.id === seed.id)).toBeUndefined()

        await pb
            .collection('books')
            .delete(seed.id)
            .catch(() => {})
    }, 30000)

    it('does not revert with an equal-`updated` query result when NO optimistic mutation is pending (post-settle window)', async () => {
        // The report's residual case (0.6.2 -> bug report 2): the stale read lands a beat
        // AFTER the optimistic move has fully settled, so the pending-optimistic arm is
        // already OFF (the key has left optimisticUpserts). The only remaining guard is the
        // timestamp arm, and the stale read carries the SAME `updated` second as the value
        // it would revert -> strict `<` is false -> the write passes and reverts the row.
        //
        // To reproduce that guard input WITHOUT the nondeterministic optimistic-overlay
        // collapse timing, the synced store is brought to the post-settle state directly:
        // the row is updated server-side to DEST and the owning id= query refetched so
        // synced = DEST with NO optimistic overlay (exactly what "post-settle" means). The
        // stale read then returns the pre-move row (SOURCE) carrying the same `updated`
        // second as the synced DEST value. The guard must drop it via the timestamp arm.
        const seed = await seedBook(SOURCE_GENRE)
        const collection = createCollectionFactory(queryClient).create('books', {
            syncMode: 'on-demand',
        })

        const realGetFullList = pb.collection('books').getFullList.bind(pb.collection('books'))
        // The stale row is filled in AFTER synced reaches DEST, so its `updated` can be set
        // to exactly the synced DEST value (the equal-second case the report describes).
        const control = { serveStale: false, served: 0, staleRow: null as Books | null }
        vi.spyOn(pb.collection('books'), 'getFullList').mockImplementation(
            async (...args: Parameters<typeof realGetFullList>) => {
                const filter = (args[0] as { filter?: string } | undefined)?.filter ?? ''
                if (
                    control.serveStale &&
                    control.staleRow &&
                    filter.includes(seed.id) &&
                    !filter.includes('genre')
                ) {
                    control.served++
                    return [{ ...control.staleRow }] as unknown as ReturnType<
                        typeof realGetFullList
                    >
                }
                return realGetFullList(...args)
            }
        )

        const { result: idResult } = renderHook(() =>
            useLiveQuery(q =>
                q.from({ books: collection }).where(({ books }) => eq(books.id, seed.id))
            )
        )
        await waitForLoadFinish(idResult, 10000)
        await waitFor(
            () =>
                expect(idResult.current.data.find(b => b.id === seed.id)?.genre).toBe(SOURCE_GENRE),
            { timeout: 10000 }
        )

        // Bring synced to the post-settle state via a plain server write + refetch: the
        // owning id= query reconciles DEST into synced with NO optimistic overlay.
        await pb.collection('books').update(seed.id, { genre: DEST_GENRE })
        await collection.utils.refetch()
        await waitFor(() => expect(syncedGet(collection, seed.id)?.genre).toBe(DEST_GENRE), {
            timeout: 10000,
        })
        expect(hasPendingOverlay(collection, seed.id)).toBe(false)
        const settled = syncedGet(collection, seed.id)

        // Arm the stale read: pre-move genre (SOURCE) but the SAME `updated` second as the
        // synced DEST value. Without the `<=` arm this reverts the row to SOURCE.
        control.staleRow = {
            ...seed,
            genre: SOURCE_GENRE,
            updated: settled?.updated ?? seed.updated,
        }
        control.serveStale = true
        await collection.utils.refetch()
        await new Promise(r => setTimeout(r, 400))

        expect(control.served).toBeGreaterThan(0)
        expect(syncedGet(collection, seed.id)?.genre).toBe(DEST_GENRE)
        expect(
            testLogger.messages.debug.some(m => m.msg.includes('Dropping stale synced write'))
        ).toBe(true)

        await pb
            .collection('books')
            .delete(seed.id)
            .catch(() => {})
    }, 30000)

    it('still applies a genuinely newer query result for an owned row', async () => {
        const seed = await seedBook(SOURCE_GENRE)
        const collection = createCollectionFactory(queryClient).create('books', {
            syncMode: 'on-demand',
        })

        // The id= resolver returns a NEWER row (renamed, later `updated`) — a real
        // concurrent update from another client. The staleness guard must NOT drop it,
        // and with no pending optimistic mutation the optimistic arm does not apply.
        const newTitle = `Renamed ${Date.now().toString().slice(-8)}`
        const newerRow: Books = { ...seed, title: newTitle, updated: offsetUpdated(seed, 60000) }
        const realGetFullList = pb.collection('books').getFullList.bind(pb.collection('books'))
        const control = { serveNewer: false }
        vi.spyOn(pb.collection('books'), 'getFullList').mockImplementation(
            async (...args: Parameters<typeof realGetFullList>) => {
                const filter = (args[0] as { filter?: string } | undefined)?.filter ?? ''
                if (control.serveNewer && filter.includes(seed.id) && !filter.includes('genre')) {
                    return [{ ...newerRow }] as unknown as ReturnType<typeof realGetFullList>
                }
                return realGetFullList(...args)
            }
        )

        const { result: idResult } = renderHook(() =>
            useLiveQuery(q =>
                q.from({ books: collection }).where(({ books }) => eq(books.id, seed.id))
            )
        )
        await waitForLoadFinish(idResult, 10000)
        await waitForSubscription(collection)
        await waitFor(
            () => expect(idResult.current.data.find(b => b.id === seed.id)).toBeDefined(),
            {
                timeout: 10000,
            }
        )
        expect(syncedGet(collection, seed.id)?.title).toBe(seed.title)

        control.serveNewer = true
        await collection.utils.refetch()

        await waitFor(() => expect(syncedGet(collection, seed.id)?.title).toBe(newTitle), {
            timeout: 5000,
        })
        expect(testLogger.messages.debug.some(m => m.msg.includes('Dropping'))).toBe(false)

        await pb
            .collection('books')
            .delete(seed.id)
            .catch(() => {})
    }, 30000)
})
