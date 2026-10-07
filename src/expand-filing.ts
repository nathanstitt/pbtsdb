import { markFiledSubset, parseViaKey, type RelationTargets, splitPaths } from './expand-paths'
import { logger } from './logger'
import { expandOf, idOf, idsOf, isObject } from './records'
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

/** `parentId` now files exactly `rowIds` into `target` under expand `key`. */
export type SetFiled = (
    parentId: string,
    target: RelationTarget,
    key: string,
    rowIds: Iterable<string>
) => void

export interface ExpandFiler {
    /**
     * File every expanded record into its target, one write per relation
     * key, and reconcile each parent's filings for the expand paths the
     * request asked for: a requested key a record does not carry means the
     * relation is empty or unreadable, so rows filed under it before are
     * released.
     */
    upsertExpanded: (
        records: readonly object[],
        targets: RelationTargets | undefined,
        requestedPaths: readonly string[]
    ) => Promise<void>
    /** PocketBase omits an empty back-relation's key, so absence means zero children. */
    markEmptyBackRelations: (items: readonly object[], heads: readonly BackRelationHead[]) => void
}

/** The paths under `key`: `a.b.c` requested as `key.a.b.c`. */
function tailsOf(paths: readonly string[], key: string): string[] {
    return paths.filter(path => path.startsWith(`${key}.`)).map(path => path.slice(key.length + 1))
}

export interface ExpandFilerDeps {
    collectionName: string
    setFiled: SetFiled
    /** This collection's identity as a parent: the holder its filings carry. */
    holder: object
    /**
     * A parent record whose filings must not be reconciled: a copy older
     * than the stored row, or a row deleted while its fetch was in flight.
     */
    isStale: (record: object) => boolean
}

export function createExpandFiler(deps: ExpandFilerDeps): ExpandFiler {
    const { collectionName, setFiled, holder } = deps

    async function fileGroup(
        key: string,
        group: ExpandedGroup,
        target: RelationTarget,
        requestedPaths: readonly string[]
    ): Promise<boolean> {
        const values = lastById(group.values)
        const filed = await target.writeFiled(values, holder)
        await upsertExpanded(values, target.relationTargets, tailsOf(requestedPaths, key), true)
        if (!filed) return false
        for (const [parentId, parentValues] of group.byParent) {
            setFiled(parentId, target, key, idsOf(parentValues))
            markFiledSubset(target, key, parentValues, parentId)
        }
        return true
    }

    // A requested key a record does not carry is an empty or unreadable
    // relation: whatever the record filed under it before is released.
    function releaseAbsent(
        records: readonly object[],
        targets: RelationTargets,
        keys: Iterable<string>
    ): void {
        for (const key of keys) {
            const target = targets[key]
            if (!target) continue
            for (const record of records) {
                const parentId = idOf(record)
                if (parentId && expandOf(record)?.[key] === undefined) {
                    setFiled(parentId, target, key, [])
                }
            }
        }
    }

    // Nested levels are the target's rows, not this parent's, so staleness
    // is checked at the top level only.
    async function upsertExpanded(
        all: readonly object[],
        targets: RelationTargets | undefined,
        requestedPaths: readonly string[],
        nested = false
    ): Promise<void> {
        if (!targets) return
        const records = nested ? all : all.filter(record => !deps.isStale(record))
        const grouped = groupExpandedByKey(records)
        const unfiled = new Set<string>()
        for (const [key, group] of grouped) {
            const target = targets[key]
            if (!target) {
                logger.debug('No relation target for expanded field', { collectionName, key })
                continue
            }
            if (!(await fileGroup(key, group, target, requestedPaths))) unfiled.add(key)
        }
        const heads = new Set(requestedPaths.map(path => path.split('.')[0]))
        releaseAbsent(
            records,
            targets,
            [...heads].filter(key => !unfiled.has(key))
        )
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
                    if (expand?.[key] === undefined) target.markSubsetLoaded(field, id)
                }
            }
        },
    }
}
