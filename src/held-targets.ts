import { parseViaKey } from './expand-paths'
import { logger } from './logger'
import { REALTIME_MAX_FILTER_LENGTH, subsetFilters } from './pocketbase-limits'
import type { HeldTarget, RelationTarget } from './types'

/**
 * Relation targets a collection holds live while its own subscription is
 * open, and what each parent row filed into them. A filed row stays in its
 * target while at least one parent row in this collection's store files
 * it; the hold's realtime filters cover exactly the current filings.
 */
export interface HeldTargets {
    /**
     * Root row `rootId` of this collection now files exactly `rowIds` into
     * `target` under expand path `key` (`author`, `author.publisher`), with
     * realtime filters on `filterValues`: the row ids for a forward
     * relation (the default), the immediate parent ids for a back-relation.
     * Returns the release of the rows it filed before and no longer does,
     * when no other root files them; the caller runs it once the root row
     * has landed, so a parent is never visible without its relation.
     */
    setFiled: (
        rootId: string,
        target: RelationTarget,
        key: string,
        rowIds: Iterable<string>,
        filterValues?: Iterable<string>
    ) => () => void
    /** Root row `rootId` left the store: release everything it filed, at every depth. */
    forgetParentRow: (rootId: string) => void
    /** Hold exactly `desired`; release every other held target. */
    sync: (desired: Set<RelationTarget>) => void
    releaseAll: () => void
    /** Forget every filing without releasing; the store that held them is gone. */
    clearFiled: () => void
    count: () => number
}

type Filing = { rows: Set<string>; filters: Set<string> }
type Filed = Map<RelationTarget, Map<string, Filing>>

export function createHeldTargets(collectionName: string, holder: object): HeldTargets {
    const held = new Map<RelationTarget, HeldTarget>()
    const filings = new Map<string, Filed>()
    /** Per target: how many (root, key) filings reference each filed row. */
    const rowRefs = new Map<RelationTarget, Map<string, number>>()
    /** Per target: field → value → how many filings need that realtime filter. */
    const filterRefs = new Map<RelationTarget, Map<string, Map<string, number>>>()

    function filtersFor(target: RelationTarget): string[] {
        const byField = filterRefs.get(target)
        if (!byField) return []
        const filters: string[] = []
        for (const [field, values] of byField) {
            if (values.size === 0) continue
            filters.push(
                ...subsetFilters({ field, values: [...values.keys()] }, REALTIME_MAX_FILTER_LENGTH)
            )
        }
        return filters
    }

    function bump<K>(counts: Map<K, number>, key: K, delta: 1 | -1): boolean {
        const next = (counts.get(key) ?? 0) + delta
        if (next <= 0) {
            counts.delete(key)
            return delta < 0
        }
        counts.set(key, next)
        return delta > 0 && next === 1
    }

    function filterRef(
        target: RelationTarget,
        field: string,
        value: string,
        delta: 1 | -1
    ): boolean {
        let byField = filterRefs.get(target)
        if (!byField) {
            byField = new Map()
            filterRefs.set(target, byField)
        }
        let values = byField.get(field)
        if (!values) {
            values = new Map()
            byField.set(field, values)
        }
        return bump(values, value, delta)
    }

    function rowRef(target: RelationTarget, id: string, delta: 1 | -1): boolean {
        let counts = rowRefs.get(target)
        if (!counts) {
            counts = new Map()
            rowRefs.set(target, counts)
        }
        return bump(counts, id, delta)
    }

    function filedUnder(rootId: string, target: RelationTarget): Map<string, Filing> {
        let byTarget = filings.get(rootId)
        if (!byTarget) {
            byTarget = new Map()
            filings.set(rootId, byTarget)
        }
        let byKey = byTarget.get(target)
        if (!byKey) {
            byKey = new Map()
            byTarget.set(target, byKey)
        }
        return byKey
    }

    /** The realtime field a path's last segment filters on: the parent field of a back-relation, else `id`. */
    function fieldFor(key: string): string {
        const last = key.split('.').at(-1) ?? key
        return parseViaKey(last)?.field ?? 'id'
    }

    function diff<V>(previous: Set<V>, next: Set<V>): { added: V[]; removed: V[] } {
        return {
            added: [...next].filter(value => !previous.has(value)),
            removed: [...previous].filter(value => !next.has(value)),
        }
    }

    /** Move the filter refs from `previous` to `next`; true when the target's filter list changed. */
    function swapFilterRefs(
        target: RelationTarget,
        field: string,
        previous: Set<string>,
        next: Set<string>
    ): boolean {
        const { added, removed } = diff(previous, next)
        let changed = false
        for (const value of added) if (filterRef(target, field, value, 1)) changed = true
        for (const value of removed) if (filterRef(target, field, value, -1)) changed = true
        return changed
    }

    /** Move the row refs from `previous` to `next`; returns the rows that reached zero. */
    function swapRowRefs(
        target: RelationTarget,
        previous: Set<string>,
        next: Set<string>
    ): string[] {
        const { added, removed } = diff(previous, next)
        for (const id of added) rowRef(target, id, 1)
        return removed.filter(id => rowRef(target, id, -1))
    }

    function setFiled(
        rootId: string,
        target: RelationTarget,
        key: string,
        rowIds: Iterable<string>,
        filterValues?: Iterable<string>
    ): () => void {
        const rows = new Set(rowIds)
        const next: Filing = { rows, filters: new Set(filterValues ?? rows) }
        const byKey = filedUnder(rootId, target)
        const previous = byKey.get(key) ?? { rows: new Set<string>(), filters: new Set<string>() }
        byKey.set(key, next)
        const released = swapRowRefs(target, previous.rows, next.rows)
        if (swapFilterRefs(target, fieldFor(key), previous.filters, next.filters)) {
            held.get(target)?.setFilters(filtersFor(target))
        }
        if (released.length === 0) return () => undefined
        // Another root may file one of these rows again before the step
        // runs, so the step releases only the rows still at zero then.
        return () => {
            const counts = rowRefs.get(target)
            const unreferenced = released.filter(id => !counts?.has(id))
            if (unreferenced.length > 0) target.releaseFiled(unreferenced, holder)
        }
    }

    function forgetParentRow(rootId: string): void {
        const byTarget = filings.get(rootId)
        if (!byTarget) return
        for (const [target, byKey] of byTarget) {
            for (const key of [...byKey.keys()]) setFiled(rootId, target, key, [], [])()
        }
        filings.delete(rootId)
    }

    function release(target: RelationTarget): void {
        const hold = held.get(target)
        if (!hold) return
        held.delete(target)
        try {
            hold.release()
        } catch (error) {
            logger.error('Failed to release relation target subscription', {
                collectionName,
                error,
            })
        }
    }

    function hold(target: RelationTarget): void {
        if (held.has(target)) return
        try {
            const hold = target.holdLive(holder)
            held.set(target, hold)
            hold.setFilters(filtersFor(target))
        } catch (error) {
            logger.error('Failed to hold relation target subscription', { collectionName, error })
        }
    }

    function sync(desired: Set<RelationTarget>): void {
        for (const target of [...held.keys()]) if (!desired.has(target)) release(target)
        for (const target of desired) hold(target)
    }

    return {
        setFiled,
        forgetParentRow,
        sync,
        releaseAll: () => sync(new Set()),
        clearFiled: () => {
            filings.clear()
            rowRefs.clear()
            filterRefs.clear()
        },
        count: () => held.size,
    }
}
