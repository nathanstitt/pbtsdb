import { markFiledSubset, parseViaKey, type RelationTargets, splitPaths } from './expand-paths'
import { logger } from './logger'
import { expandOf, idOf, isObject } from './records'
import type { RelationTarget } from './types'

/** A back-relation (`<collection>_via_<field>`) at the head of an active expand path. */
export interface BackRelationHead {
    target: RelationTarget
    key: string
    field: string
}

export function backRelationHeads(
    expandString: string | undefined,
    targets: RelationTargets | undefined
): BackRelationHead[] {
    if (!targets) return []
    const heads: BackRelationHead[] = []
    for (const key of splitPaths(expandString).map(path => path.split('.')[0])) {
        const target = targets[key]
        const via = target && parseViaKey(key)
        if (target && via) heads.push({ target, key, field: via.field })
    }
    return heads
}

/** Every collection along the given expand paths, through nested targets. */
export function targetsAlong(
    paths: Iterable<string>,
    targets: RelationTargets | undefined
): Set<RelationTarget> {
    const found = new Set<RelationTarget>()
    for (const path of paths) {
        let current = targets
        for (const segment of path.split('.')) {
            const target = current?.[segment]
            if (!target) break
            found.add(target)
            current = target.relationTargets
        }
    }
    return found
}

// A filed copy never carries `expand`: parts with a declared target are filed
// by the recursive call, and parts without one have nowhere to go.
export function withoutExpand(values: object[]): object[] {
    return values.map(value => {
        const { expand: _expand, ...plain } = value as { expand?: unknown }
        return plain
    })
}

// pbtsdb asked PocketBase for these relations only to file them into their
// target collections; the copies never reach a row in any cache.
export function stripFetchedRelations<T extends object>(
    items: T[],
    expandString: string | undefined
): T[] {
    const heads = new Set(splitPaths(expandString).map(path => path.split('.')[0]))
    if (heads.size === 0) return items
    return items.map(item => {
        const { expand, ...plain } = item as T & { expand?: Record<string, unknown> }
        if (!expand) return item
        const kept = Object.fromEntries(Object.entries(expand).filter(([key]) => !heads.has(key)))
        return (Object.keys(kept).length > 0 ? { ...plain, expand: kept } : plain) as T
    })
}

type ExpandedGroup = { values: object[]; byParent: [string, object[]][] }

function groupExpandedByKey(records: readonly object[]): Map<string, ExpandedGroup> {
    const byKey = new Map<string, ExpandedGroup>()
    for (const record of records) {
        const expand = expandOf(record)
        if (!expand) continue
        const parentId = idOf(record)
        for (const [key, value] of Object.entries(expand)) {
            const values = (Array.isArray(value) ? value : [value]).filter(isObject)
            const group = byKey.get(key) ?? { values: [], byParent: [] }
            group.values.push(...values)
            if (parentId) group.byParent.push([parentId, values])
            byKey.set(key, group)
        }
    }
    return byKey
}

// Many parents can expand the same record; the last copy wins.
function lastById(values: object[]): object[] {
    const byId = new Map<string | undefined, object>()
    for (const value of values) byId.set(idOf(value), value)
    return [...byId.values()]
}

/** Records what a parent filed into a target: ids for a forward relation, parent ids for a back-relation. */
export type RecordFiled = (target: RelationTarget, field: string, values: Iterable<string>) => void

export interface ExpandFiler {
    /** File every expanded record into its target, one write per relation key. */
    upsertExpanded: (
        records: readonly object[],
        targets: RelationTargets | undefined
    ) => Promise<void>
    /** PocketBase omits an empty back-relation's key, so absence means zero children. */
    markEmptyBackRelations: (items: readonly object[], heads: readonly BackRelationHead[]) => void
}

export function createExpandFiler(collectionName: string, recordFiled: RecordFiled): ExpandFiler {
    function recordFiledGroup(
        target: RelationTarget,
        key: string,
        group: ExpandedGroup,
        values: object[]
    ): void {
        const via = parseViaKey(key)
        if (via) {
            recordFiled(
                target,
                via.field,
                group.byParent.map(([parentId]) => parentId)
            )
        } else {
            recordFiled(
                target,
                'id',
                values.flatMap(value => idOf(value) ?? [])
            )
        }
    }

    async function upsertExpanded(
        records: readonly object[],
        targets: RelationTargets | undefined
    ): Promise<void> {
        if (!targets) return
        for (const [key, group] of groupExpandedByKey(records)) {
            const target = targets[key]
            if (!target) {
                logger.debug('No relation target for expanded field', { collectionName, key })
                continue
            }
            const values = lastById(group.values)
            const filed = await target.writeFiled(values)
            await upsertExpanded(values, target.relationTargets)
            if (!filed) continue
            recordFiledGroup(target, key, group, values)
            for (const [parentId, parentValues] of group.byParent) {
                markFiledSubset(target, key, parentValues, parentId)
            }
        }
    }

    return {
        upsertExpanded,
        markEmptyBackRelations(items, heads) {
            if (heads.length === 0) return
            for (const item of items) {
                const id = idOf(item)
                if (!id) continue
                const expand = expandOf(item)
                for (const { target, key, field } of heads) {
                    if (expand?.[key] !== undefined) continue
                    target.markSubsetLoaded(field, id)
                    recordFiled(target, field, [id])
                }
            }
        },
    }
}
