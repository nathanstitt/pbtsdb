import type { WhereSubset } from './keyed-where'

/**
 * Field → values whose subset is known complete in the store, so a query on
 * that subset is served without a request (see docs/internals.md,
 * "Loaded-subset marks").
 */
export interface LoadedSubsets {
    mark: (field: string, value: string) => void
    count: () => number
    isLoaded: (subset: WhereSubset) => boolean
    /** Forget the marks a removed row belonged to. */
    forgetRow: (row: unknown) => void
    clear: () => void
}

export function createLoadedSubsets(): LoadedSubsets {
    const marks = new Map<string, Set<string>>()

    function forgetValue(marked: Set<string>, value: unknown): void {
        if (typeof value === 'string') marked.delete(value)
        else if (Array.isArray(value)) {
            for (const item of value) if (typeof item === 'string') marked.delete(item)
        }
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
        forgetRow(row) {
            if (!row || typeof row !== 'object') return
            for (const [field, marked] of marks) {
                forgetValue(marked, (row as Record<string, unknown>)[field])
            }
        },
        clear() {
            marks.clear()
        },
    }
}
