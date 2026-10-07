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

export interface FetchDeps<T extends object> {
    pb: PocketBase
    collectionName: string
    relationTargets: RelationTargets | undefined
    /** The full expand string a request sends, alwaysFetchRelations included. */
    activeExpand: (request: PbRequest) => string | undefined
    syncedRow: (id: string) => T | undefined
    syncedRows: () => Iterable<T>
    subsets: Pick<LoadedSubsets, 'isLoaded'>
    filer: ExpandFiler
}

export interface FetchResult<T> {
    rows: T[]
    /** True when the store answered and no request was sent. */
    fromStore: boolean
}

export interface FetchOptions {
    signal?: AbortSignal
    /** Revalidate: send the request even when the store could answer it. */
    refetch?: boolean
}

export interface Fetcher<T extends object> {
    /** Rows for `request`: relations filed into their targets, fetched expand stripped. */
    fetchRecords: (request: PbRequest, options?: FetchOptions) => Promise<FetchResult<T>>
    /**
     * The rows the store answers `request` with, or undefined when it cannot.
     * Synchronous: it does not wait for a parent's pending filing.
     */
    serveFromStore: (request: PbRequest) => T[] | undefined
    /**
     * A parent's fetch may file and mark `field` once `settles` resolves; a
     * fetch for a not-yet-loaded subset on that field waits for it first.
     * Returns the unregister function the parent runs once its fetch settles.
     */
    expectFiling: (field: string, settles: Promise<void>) => () => void
}

/** Thrown when `signal` aborted before the rows were installed. */
export class FetchAbortedError extends Error {
    constructor(collectionName: string) {
        super(`${collectionName}: fetch aborted`)
        this.name = 'AbortError'
    }
}

export function createFetcher<T extends object>(deps: FetchDeps<T>): Fetcher<T> {
    const { pb, collectionName, relationTargets, filer, subsets } = deps
    const pendingFilings = new Map<string, Promise<void>[]>()
    let requestSeq = 0

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
    // and must never become a request. A sorted and limited request must be
    // sliced in that order, which the store's id order cannot provide, and a
    // cursor is a boundary in that order too.
    function servedFromStore(request: PbRequest): T[] | undefined {
        const { subset, sort, limit } = request
        if (!subset) return undefined
        if (subset.values.length === 0) return []
        if (request.expand || request.cursor || (sort && limit)) return undefined
        const rows =
            subset.field === 'id' ? rowsFromStore(subset.values) : fieldSubsetFromStore(subset)
        return rows && limit ? rows.slice(0, limit) : rows
    }

    function withCursor(
        filter: string | undefined,
        cursor: string | undefined
    ): string | undefined {
        if (!cursor) return filter
        return filter ? `(${filter}) && (${cursor})` : cursor
    }

    // Each load and each chunk carry their own request key, so the SDK's
    // auto-cancellation never aborts a sibling chunk or a concurrent load. A
    // limited request returns each chunk's first rows unsliced: the live
    // query re-applies sort and limit. An offset without a cursor is a count
    // of rows already acquired; PocketBase pages by page number, so an
    // aligned offset becomes a page and any other offset is sliced from a
    // request that starts at row one.
    async function fetchPage(
        request: PbRequest,
        expand: string | undefined,
        chunkFilter: string | undefined,
        requestKey: string,
        offset: number
    ): Promise<T[]> {
        const { sort, limit } = request
        const filter = withCursor(chunkFilter, request.cursor)
        if (limit) {
            if (offset % limit === 0) {
                const result = await pb
                    .collection(collectionName)
                    .getList(offset / limit + 1, limit, {
                        filter,
                        sort,
                        skipTotal: true,
                        expand,
                        requestKey,
                    })
                return result.items as unknown as T[]
            }
            const result = await pb
                .collection(collectionName)
                .getList(1, offset + limit, { filter, sort, skipTotal: true, expand, requestKey })
            return (result.items as unknown as T[]).slice(offset)
        }
        const items = await pb
            .collection(collectionName)
            .getFullList({ filter, sort, expand, requestKey })
        return (items as unknown as T[]).slice(offset)
    }

    function chunkRequest(
        request: PbRequest,
        chunks: number
    ): { request: PbRequest; offset: number } {
        const offset = request.offset ?? 0
        if (chunks === 1 || offset === 0) return { request, offset }
        const limit = request.limit ? offset + request.limit : undefined
        return { request: { ...request, limit }, offset: 0 }
    }

    async function fetchItems(
        request: PbRequest,
        heads: readonly BackRelationHead[],
        refetch: boolean
    ): Promise<FetchResult<T>> {
        const served = refetch ? undefined : servedFromStore(request)
        if (served) return { rows: served, fromStore: true }
        // Give a same-tick parent fetch the chance to file this subset first.
        // Invariant: a fetch that registers pending filings never waits on
        // them, or two mutually back-related collections deadlock.
        if (!refetch && request.subset && request.subset.field !== 'id' && heads.length === 0) {
            await awaitPendingFiling(request.subset.field)
            const servedAfterFiling = servedFromStore(request)
            if (servedAfterFiling) return { rows: servedAfterFiling, fromStore: true }
        }
        const filters = request.subset ? subsetFilters(request.subset) : [request.filter]
        const expand = deps.activeExpand(request)
        const chunk = chunkRequest(request, filters.length)
        const load = ++requestSeq
        const pages = await Promise.all(
            filters.map((chunkFilter, index) =>
                fetchPage(
                    chunk.request,
                    expand,
                    chunkFilter,
                    `${collectionName}:${load}:${index}`,
                    chunk.offset
                )
            )
        )
        const items = pages.flat()
        filer.markEmptyBackRelations(items, heads)
        return { rows: items, fromStore: false }
    }

    async function fetchRecords(
        request: PbRequest,
        options: FetchOptions = {}
    ): Promise<FetchResult<T>> {
        const { signal } = options
        let settleFiling: () => void = () => undefined
        const filed = new Promise<void>(resolve => {
            settleFiling = resolve
        })
        const heads = backRelationHeads(deps.activeExpand(request), relationTargets)
        const unregister = heads.map(({ target, field }) => target.expectFiling(field, filed))
        try {
            const result = await fetchItems(request, heads, options.refetch === true)
            if (signal?.aborted) throw new FetchAbortedError(collectionName)
            if (!result.fromStore) await filer.upsertExpanded(result.rows, relationTargets)
            if (signal?.aborted) throw new FetchAbortedError(collectionName)
            return {
                rows: stripFetchedRelations(result.rows, deps.activeExpand(request)),
                fromStore: result.fromStore,
            }
        } finally {
            settleFiling()
            for (const fn of unregister) fn()
        }
    }

    return { fetchRecords, serveFromStore: servedFromStore, expectFiling }
}
