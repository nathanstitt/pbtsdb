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
     * `parentId` now files exactly `rowIds` into `target` under expand
     * `key`. Rows it filed before and no longer does are released from the
     * target when no other parent row files them.
     */
    setFiled: (
        parentId: string,
        target: RelationTarget,
        key: string,
        rowIds: Iterable<string>
    ) => void
    /** `parentId` left the store: release everything it filed. */
    forgetParentRow: (parentId: string) => void
    /** Hold exactly `desired`; release every other held target. */
    sync: (desired: Set<RelationTarget>) => void
    releaseAll: () => void
    /** Forget every filing without releasing; the store that held them is gone. */
    clearFiled: () => void
    count: () => number
}

type Filed = Map<RelationTarget, Map<string, Set<string>>>

export function createHeldTargets(collectionName: string, holder: object): HeldTargets {
    const held = new Map<RelationTarget, HeldTarget>()
    const filings = new Map<string, Filed>()
    /** Per target: how many (parent, key) filings reference each filed row. */
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

    function filedUnder(parentId: string, target: RelationTarget): Map<string, Set<string>> {
        let byTarget = filings.get(parentId)
        if (!byTarget) {
            byTarget = new Map()
            filings.set(parentId, byTarget)
        }
        let byKey = byTarget.get(target)
        if (!byKey) {
            byKey = new Map()
            byTarget.set(target, byKey)
        }
        return byKey
    }

    /** Count rows and, for a forward relation, their id filters. Returns the rows that reached zero. */
    function refRows(
        target: RelationTarget,
        ids: readonly string[],
        forward: boolean,
        delta: 1 | -1
    ): { released: string[]; filtersChanged: boolean } {
        const released: string[] = []
        let filtersChanged = false
        for (const id of ids) {
            if (rowRef(target, id, delta) && delta < 0) released.push(id)
            if (forward && filterRef(target, 'id', id, delta)) filtersChanged = true
        }
        return { released, filtersChanged }
    }

    // A forward relation's filter lists the filed ids; a back-relation's
    // filter is the parent id, kept while the filing exists even with no
    // children, so new children arrive.
    function setFiled(
        parentId: string,
        target: RelationTarget,
        key: string,
        rowIds: Iterable<string>
    ): void {
        const next = new Set(rowIds)
        const byKey = filedUnder(parentId, target)
        const first = !byKey.has(key)
        const previous = byKey.get(key) ?? new Set<string>()
        byKey.set(key, next)
        const via = parseViaKey(key)
        const added = refRows(
            target,
            [...next].filter(id => !previous.has(id)),
            !via,
            1
        )
        const removed = refRows(
            target,
            [...previous].filter(id => !next.has(id)),
            !via,
            -1
        )
        let filtersChanged = added.filtersChanged || removed.filtersChanged
        if (via && first && filterRef(target, via.field, parentId, 1)) filtersChanged = true
        if (filtersChanged) held.get(target)?.setFilters(filtersFor(target))
        if (removed.released.length > 0) target.releaseFiled(removed.released, holder)
    }

    function forgetParentRow(parentId: string): void {
        const byTarget = filings.get(parentId)
        if (!byTarget) return
        for (const [target, byKey] of byTarget) {
            for (const key of [...byKey.keys()]) {
                setFiled(parentId, target, key, [])
                const via = parseViaKey(key)
                if (via && filterRef(target, via.field, parentId, -1)) {
                    held.get(target)?.setFilters(filtersFor(target))
                }
            }
        }
        filings.delete(parentId)
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
