import { logger } from './logger'
import { REALTIME_MAX_FILTER_LENGTH, subsetFilters } from './pocketbase-limits'
import type { HeldTarget, RelationTarget } from './types'

/**
 * Relation targets a collection holds live while its own subscription is
 * open, each told which rows this collection filed into it.
 */
export interface HeldTargets {
    recordFiled: (target: RelationTarget, field: string, values: Iterable<string>) => void
    /** Hold exactly `desired`; release every other held target. */
    sync: (desired: Set<RelationTarget>) => void
    releaseAll: () => void
    /** Forget what was filed; the next hold subscribes to nothing until refiled. */
    clearFiled: () => void
    count: () => number
}

export function createHeldTargets(collectionName: string, holder: object): HeldTargets {
    const held = new Map<RelationTarget, HeldTarget>()
    // Kept across releases, so a re-hold re-subscribes these filters without
    // filing again. The rows filed under a released hold leave the target;
    // a re-hold does not put them back.
    const filedByTarget = new Map<RelationTarget, Map<string, Set<string>>>()

    function filtersFor(target: RelationTarget): string[] {
        const byField = filedByTarget.get(target)
        if (!byField) return []
        const filters: string[] = []
        for (const [field, values] of byField) {
            filters.push(
                ...subsetFilters({ field, values: [...values] }, REALTIME_MAX_FILTER_LENGTH)
            )
        }
        return filters
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
        recordFiled(target, field, values) {
            let byField = filedByTarget.get(target)
            if (!byField) {
                byField = new Map()
                filedByTarget.set(target, byField)
            }
            let recorded = byField.get(field)
            if (!recorded) {
                recorded = new Set()
                byField.set(field, recorded)
            }
            let grew = false
            for (const value of values) {
                if (recorded.has(value)) continue
                recorded.add(value)
                grew = true
            }
            if (grew) held.get(target)?.setFilters(filtersFor(target))
        },
        sync,
        releaseAll: () => sync(new Set()),
        clearFiled: () => filedByTarget.clear(),
        count: () => held.size,
    }
}
