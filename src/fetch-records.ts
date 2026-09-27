import type { QueryClient } from '@tanstack/react-query'
import type PocketBase from 'pocketbase'
import {
    type BackRelationHead,
    backRelationHeads,
    type ExpandFiler,
    stripFetchedRelations,
} from './expand-filing'
import type { RelationTargets } from './expand-paths'
import { matchesSubset, type WhereSubset } from './keyed-where'
import type { LoadedSubsets } from './loaded-subsets'
import { subsetFilters } from './pocketbase-limits'
import type { PbRequest } from './request'
import type { SyncedWriteGuard } from './synced-write-guard'

export interface FetchDeps<T extends object> {
    pb: PocketBase
    collectionName: string
    queryClient: QueryClient
    relationTargets: RelationTargets | undefined
    ignoreAutoCancellation: boolean
    /** The full expand string a request sends, alwaysFetchRelations included. */
    activeExpand: (request: PbRequest) => string | undefined
    syncedRow: (id: string) => T | undefined
    syncedRows: () => Iterable<T>
    subsets: Pick<LoadedSubsets, 'isLoaded'>
    guard: Pick<SyncedWriteGuard<T>, 'trackFetch' | 'withRowsConfirmedMidFlight'>
    filer: ExpandFiler
}

export interface Fetcher<T extends object> {
    fetchRecords: (request: PbRequest, queryKey: readonly unknown[]) => Promise<T[]>
    /**
     * A parent's fetch may file and mark `field` once `settles` resolves; a
     * fetch for a not-yet-loaded subset on that field waits for it first.
     * Returns the unregister function the parent runs once its fetch settles.
     */
    expectFiling: (field: string, settles: Promise<void>) => () => void
}

export function createFetcher<T extends object>(deps: FetchDeps<T>): Fetcher<T> {
    const { pb, collectionName, queryClient, relationTargets, guard, filer, subsets } = deps
    const pendingFilings = new Map<string, Promise<void>[]>()

    function expectFiling(field: string, settles: Promise<void>): () => void {
        let pending = pendingFilings.get(field)
        if (!pending) {
            pending = []
            pendingFilings.set(field, pending)
        }
        pending.push(settles)
        return () => {
            const index = pending.indexOf(settles)
            if (index !== -1) pending.splice(index, 1)
            if (pending.length === 0) pendingFilings.delete(field)
        }
    }

    async function awaitPendingFiling(field: string): Promise<void> {
        const pending = pendingFilings.get(field)
        if (pending && pending.length > 0) await Promise.all(pending)
    }

    // Rows in the synced store are as fresh as realtime keeps them; an id-only
    // request whose ids are all present needs no round trip.
    function rowsFromStore(ids: readonly string[]): T[] | undefined {
        const rows: T[] = []
        for (const id of ids) {
            const row = deps.syncedRow(id)
            if (!row) return undefined
            rows.push(row)
        }
        return rows
    }

    function fieldSubsetFromStore(subset: WhereSubset): T[] | undefined {
        if (!subsets.isLoaded(subset)) return undefined
        const wanted = new Set(subset.values)
        return [...deps.syncedRows()].filter(row => matchesSubset(row, subset.field, wanted))
    }

    // Stored rows were filed with alwaysFetchRelations already; only a view's
    // extra `request.expand` forces a fetch. An empty subset selects nothing
    // and must never become a request, which would fetch everything. A sorted
    // and limited request must be sliced in that order, which the store's id
    // order cannot provide.
    function servedFromStore(request: PbRequest): T[] | undefined {
        const { subset, sort, limit } = request
        if (!subset) return undefined
        if (subset.values.length === 0) return []
        if (request.expand || (sort && limit)) return undefined
        const rows =
            subset.field === 'id' ? rowsFromStore(subset.values) : fieldSubsetFromStore(subset)
        return rows && limit ? rows.slice(0, limit) : rows
    }

    // Each chunk carries its own request key so the SDK's auto-cancellation
    // does not abort sibling chunks. A limited request returns each chunk's
    // first rows unsliced: the live query re-applies sort and limit.
    async function fetchPage(
        request: PbRequest,
        expand: string | undefined,
        filter: string | undefined,
        index: number
    ): Promise<T[]> {
        const { sort, limit } = request
        const requestKey = `${collectionName}:${index}`
        if (limit) {
            const result = await pb
                .collection(collectionName)
                .getList(1, limit, { filter, sort, skipTotal: true, expand, requestKey })
            return result.items as unknown as T[]
        }
        const items = await pb
            .collection(collectionName)
            .getFullList({ filter, sort, expand, requestKey })
        return items as unknown as T[]
    }

    async function fetchItems(
        request: PbRequest,
        heads: readonly BackRelationHead[]
    ): Promise<T[]> {
        const served = servedFromStore(request)
        if (served) return served
        // Give a same-tick parent fetch the chance to file this subset first.
        // Invariant: a fetch that registers pending filings never waits on
        // them, or two mutually back-related collections deadlock.
        if (request.subset && request.subset.field !== 'id' && heads.length === 0) {
            await awaitPendingFiling(request.subset.field)
            const servedAfterFiling = servedFromStore(request)
            if (servedAfterFiling) return servedAfterFiling
        }
        const filters = request.subset ? subsetFilters(request.subset) : [request.filter]
        const expand = deps.activeExpand(request)
        const pages = await Promise.all(
            filters.map((filter, index) => fetchPage(request, expand, filter, index))
        )
        const items = pages.flat()
        filer.markEmptyBackRelations(items, heads)
        return items
    }

    function isAutoCancelled(error: unknown): boolean {
        return (
            deps.ignoreAutoCancellation &&
            error instanceof Error &&
            error.message.includes('autocancelled')
        )
    }

    async function fetchRecords(request: PbRequest, queryKey: readonly unknown[]): Promise<T[]> {
        const tracked = guard.trackFetch()
        // Registered before the request goes out, and settled on every path,
        // so a waiting target fetch is never left hanging.
        let settleFiling: () => void = () => undefined
        const filed = new Promise<void>(resolve => {
            settleFiling = resolve
        })
        const heads = backRelationHeads(deps.activeExpand(request), relationTargets)
        const unregister = heads.map(({ target, field }) => target.expectFiling(field, filed))
        try {
            let items: T[]
            try {
                items = await fetchItems(request, heads)
            } catch (error) {
                if (!isAutoCancelled(error)) throw error
                // Superseded by a newer request. Resolve to this subset's own
                // cached rows so its reconcile is a no-op; the base key's
                // snapshot would reconcile foreign rows into the subset.
                return guard.withRowsConfirmedMidFlight(
                    queryClient.getQueryData<T[]>(queryKey) ?? [],
                    tracked.confirmed
                )
            }
            await filer.upsertExpanded(items, relationTargets)
            return guard.withRowsConfirmedMidFlight(
                stripFetchedRelations(items, deps.activeExpand(request)),
                tracked.confirmed
            )
        } finally {
            tracked.done()
            settleFiling()
            for (const fn of unregister) fn()
        }
    }

    return { fetchRecords, expectFiling }
}
