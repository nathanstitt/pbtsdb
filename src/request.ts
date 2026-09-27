import type { LoadSubsetOptions } from '@tanstack/db'
import { joinPaths } from './expand-paths'
import { subsetFromWhere, type WhereSubset } from './keyed-where'
import { REALTIME_MAX_FILTER_LENGTH, subsetFilters } from './pocketbase-limits'
import { convertToPocketBaseFilter, convertToPocketBaseSort } from './pocketbase-query-converter'

/** Load options plus the expand paths a view adds. */
export type LoadOptions = LoadSubsetOptions & { expand?: readonly string[] }

/**
 * What a query's load options ask PocketBase for. Also the second element of
 * the query key, so equal requests share one cached query.
 */
export interface PbRequest {
    filter?: string
    sort?: string
    limit?: number
    expand?: string
    subset?: WhereSubset
}

export function toRequest(opts: LoadSubsetOptions | undefined): PbRequest {
    const request: PbRequest = {}
    const subset = subsetFromWhere(opts?.where)
    const filter = subset ? undefined : convertToPocketBaseFilter(opts?.where)
    const sort = convertToPocketBaseSort(opts?.orderBy)
    const expand = joinPaths((opts as LoadOptions | undefined)?.expand ?? [])
    if (subset) request.subset = subset
    if (filter) request.filter = filter
    if (sort) request.sort = sort
    if (opts?.limit) request.limit = opts.limit
    if (expand) request.expand = expand
    return request
}

export function queryKeyFor<C extends string>(
    collectionName: C,
    opts?: LoadSubsetOptions
): [C] | [C, PbRequest] {
    const request = toRequest(opts)
    return Object.keys(request).length === 0 ? [collectionName] : [collectionName, request]
}

export function requestFromQueryKey(queryKey: readonly unknown[]): PbRequest | undefined {
    return queryKey[1] as PbRequest | undefined
}

/**
 * The filters a query's realtime entries send: every chunk of a keyed subset,
 * or the single converted filter. `undefined` means the whole collection.
 */
export function realtimeFiltersFor(request: PbRequest): string[] | undefined {
    if (request.subset) return subsetFilters(request.subset, REALTIME_MAX_FILTER_LENGTH)
    return request.filter ? [request.filter] : undefined
}
