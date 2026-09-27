import type { QueryClient } from '@tanstack/react-query'
import type { WhereSubset } from './keyed-where'
import { logger } from './logger'
import { requestFromQueryKey } from './request'

/**
 * Field → values whose subset is known complete in the store, so a query on
 * that subset is served without a request (see docs/internals.md,
 * "Loaded-subset marks").
 */
export interface LoadedSubsets {
    mark: (field: string, value: string) => void
    count: () => number
    isLoaded: (subset: WhereSubset) => boolean
    /** Forget the marks a pruned row belonged to and invalidate their cached queries. */
    forgetRow: (row: unknown) => void
    /** Invalidate every marked subset's cached query; call before `clear` on a real stop. */
    invalidateAll: () => void
    clear: () => void
}

export function createLoadedSubsets(
    collectionName: string,
    queryClient: QueryClient
): LoadedSubsets {
    const marks = new Map<string, Set<string>>()

    function forgetValue(marked: Set<string>, value: unknown): string[] {
        if (typeof value === 'string') return marked.delete(value) ? [value] : []
        if (!Array.isArray(value)) return []
        return value.filter(item => typeof item === 'string' && marked.delete(item))
    }

    function matchesMarked(
        query: { queryKey: readonly unknown[] },
        isMarked: (field: string, value: string) => boolean
    ): boolean {
        if (query.queryKey[0] !== collectionName) return false
        const subset = requestFromQueryKey(query.queryKey)?.subset
        if (!subset) return false
        return subset.values.some(value => isMarked(subset.field, value))
    }

    // A subset query that resolved once is served from query-db-collection's
    // observer cache on the next mount regardless of marks, so forgetting a
    // mark must also invalidate that cached query.
    function invalidate(isMarked: (field: string, value: string) => boolean): void {
        void queryClient
            .invalidateQueries({ predicate: query => matchesMarked(query, isMarked) })
            .catch(error =>
                logger.error('Failed to invalidate marked subset queries', {
                    collectionName,
                    error,
                })
            )
    }

    return {
        mark(field, value) {
            let values = marks.get(field)
            if (!values) {
                values = new Set()
                marks.set(field, values)
            }
            values.add(value)
        },
        count() {
            let count = 0
            for (const values of marks.values()) count += values.size
            return count
        },
        isLoaded({ field, values }) {
            const marked = marks.get(field)
            return marked !== undefined && values.every(value => marked.has(value))
        },
        // Deferred: this runs inside TanStack's write batch, and
        // invalidateQueries may start a queryFn synchronously.
        forgetRow(row) {
            if (!row || typeof row !== 'object') return
            for (const [field, marked] of marks) {
                const forgotten = forgetValue(marked, (row as Record<string, unknown>)[field])
                if (forgotten.length === 0) continue
                queueMicrotask(() =>
                    invalidate(
                        (queryField, value) => queryField === field && forgotten.includes(value)
                    )
                )
            }
        },
        invalidateAll() {
            invalidate((field, value) => marks.get(field)?.has(value) ?? false)
        },
        clear() {
            marks.clear()
        },
    }
}
