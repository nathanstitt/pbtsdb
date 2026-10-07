import { markFiledSubset, parseViaKey, type RelationTargets, splitPaths } from './expand-paths'
import type { FilingChange } from './held-targets'
import { logger } from './logger'
import { expandOf, idOf, idsOf, isObject } from './records'
import type { RelationTarget } from './types'

export type { FilingChange } from './held-targets'

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

/**
 * Root row `rootId` now files exactly `rowIds` into `target` under expand
 * path `key`, with realtime filters on `filterValues` (the immediate
 * parent ids for a back-relation). The change is committed once the root
 * row has landed, or undone when it is discarded.
 */
export type SetFiled = (
    rootId: string,
    target: RelationTarget,
    key: string,
    rowIds: Iterable<string>,
    filterValues?: Iterable<string>
) => FilingChange

export interface ExpandFiler {
    /**
     * File every expanded record into its target, one write per relation
     * key, and record each parent's filings for the expand paths the
     * request asked for: a requested key a record does not carry means the
     * relation is empty or unreadable. Resolves with one change: `commit`
     * it after the parent rows land, so a parent is never visible without
     * its relation; `undo` it when the parent rows are discarded, so a
     * result that is thrown away changes nothing.
     */
    fileExpanded: (
        records: readonly object[],
        targets: RelationTargets | undefined,
        requestedPaths: readonly string[]
    ) => Promise<FilingChange>
    /** `fileExpanded` committed at once, for a parent that has already landed. */
    upsertExpanded: (
        records: readonly object[],
        targets: RelationTargets | undefined,
        requestedPaths: readonly string[]
    ) => Promise<void>
    /**
     * Whether `fileExpanded` has rows to write and every target it would
     * write to is syncing, so the filing lands within the current task and
     * the parent can wait for it. False when there is nothing to file, so
     * the parent lands at once.
     */
    canFileFirst: (records: readonly object[], targets: RelationTargets | undefined) => boolean
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

    type Releases = FilingChange[]
    /** The root rows that reach a row at the current level. */
    type Roots = (id: string) => Iterable<string>
    type PerRoot = Map<string, { rows: Set<string>; parents: Set<string> }>

    /**
     * What each root files under `key` at this level: the expanded row ids,
     * and the immediate parent ids a back-relation filters on. A root whose
     * records lack a requested key files nothing under it, which ends what it
     * filed there before.
     */
    function entryFor(perRoot: PerRoot, root: string): { rows: Set<string>; parents: Set<string> } {
        let found = perRoot.get(root)
        if (!found) {
            found = { rows: new Set(), parents: new Set() }
            perRoot.set(root, found)
        }
        return found
    }

    function addTo(index: Map<string, Set<string>>, key: string, value: string): void {
        let values = index.get(key)
        if (!values) {
            values = new Set()
            index.set(key, values)
        }
        values.add(value)
    }

    /** Every root that reaches this level files under a requested key, with nothing when its records lack it. */
    function rootsReaching(
        records: readonly object[],
        via: boolean,
        rootsOf: Roots,
        perRoot: PerRoot
    ): void {
        for (const record of records) {
            const parentId = idOf(record)
            if (!parentId) continue
            for (const root of rootsOf(parentId)) {
                const found = entryFor(perRoot, root)
                if (via) found.parents.add(parentId)
            }
        }
    }

    function collectRoots(
        records: readonly object[],
        group: ExpandedGroup,
        requested: boolean,
        via: boolean,
        rootsOf: Roots
    ): { perRoot: PerRoot; childRoots: Map<string, Set<string>> } {
        const perRoot: PerRoot = new Map()
        const childRoots = new Map<string, Set<string>>()
        if (requested) rootsReaching(records, via, rootsOf, perRoot)
        for (const [parentId, values] of group.byParent) {
            const ids = idsOf(values)
            for (const root of rootsOf(parentId)) {
                const found = entryFor(perRoot, root)
                found.parents.add(parentId)
                for (const id of ids) {
                    found.rows.add(id)
                    addTo(childRoots, id, root)
                }
            }
        }
        return { perRoot, childRoots }
    }

    /** A root with no rows under `prefix` files nothing deeper either. */
    function clearDeeper(
        root: string,
        targets: RelationTargets | undefined,
        paths: readonly string[],
        prefix: string,
        releases: Releases
    ): void {
        if (!targets) return
        for (const head of new Set(paths.map(path => path.split('.')[0]))) {
            const target = targets[head]
            if (!target) continue
            releases.push(setFiled(root, target, `${prefix}${head}`, [], []))
            clearDeeper(
                root,
                target.relationTargets,
                tailsOf(paths, head),
                `${prefix}${head}.`,
                releases
            )
        }
    }

    // Children before parents at every level, so a row never lands before
    // the rows it points at. Nested levels are the target's rows, not this
    // parent's, so staleness is checked at the top level only.
    type Level = {
        requestedPaths: readonly string[]
        releases: Releases
        rootsOf: Roots
        prefix: string
    }

    async function fileKey(
        records: readonly object[],
        level: Level,
        key: string,
        target: RelationTarget,
        group: ExpandedGroup,
        requested: boolean
    ): Promise<void> {
        const via = parseViaKey(key) !== undefined
        const { perRoot, childRoots } = collectRoots(records, group, requested, via, level.rootsOf)
        const values = lastById(group.values)
        const tails = tailsOf(level.requestedPaths, key)
        const path = `${level.prefix}${key}`
        if (values.length > 0) {
            await fileLevel(values, target.relationTargets, {
                requestedPaths: tails,
                releases: level.releases,
                rootsOf: id => childRoots.get(id) ?? [],
                prefix: `${path}.`,
            })
            if (!(await target.writeFiled(values, holder))) return
        }
        for (const [root, { rows, parents }] of perRoot) {
            level.releases.push(setFiled(root, target, path, rows, via ? parents : rows))
            if (rows.size === 0) {
                clearDeeper(root, target.relationTargets, tails, `${path}.`, level.releases)
            }
        }
        for (const [parentId, parentValues] of group.byParent) {
            markFiledSubset(target, key, parentValues, parentId)
        }
    }

    async function fileLevel(
        records: readonly object[],
        targets: RelationTargets | undefined,
        level: Level
    ): Promise<void> {
        if (!targets) return
        const grouped = groupExpandedByKey(records)
        const heads = new Set(level.requestedPaths.map(path => path.split('.')[0]))
        for (const key of new Set([...grouped.keys(), ...heads])) {
            const target = targets[key]
            if (!target) {
                if (grouped.has(key)) {
                    logger.debug('No relation target for expanded field', { collectionName, key })
                }
                continue
            }
            const group = grouped.get(key) ?? { values: [], byParent: [] }
            await fileKey(records, level, key, target, group, heads.has(key))
        }
    }

    async function fileExpanded(
        records: readonly object[],
        targets: RelationTargets | undefined,
        requestedPaths: readonly string[]
    ): Promise<FilingChange> {
        const releases: Releases = []
        await fileLevel(
            records.filter(record => !deps.isStale(record)),
            targets,
            { requestedPaths, releases, rootsOf: id => [id], prefix: '' }
        )
        return {
            commit: () => {
                for (const change of releases) change.commit()
            },
            undo: () => {
                for (const change of [...releases].reverse()) change.undo()
            },
        }
    }

    async function upsertExpanded(
        records: readonly object[],
        targets: RelationTargets | undefined,
        requestedPaths: readonly string[]
    ): Promise<void> {
        ;(await fileExpanded(records, targets, requestedPaths)).commit()
    }

    function targetsReady(records: readonly object[], targets: RelationTargets): boolean {
        for (const [key, group] of groupExpandedByKey(records)) {
            const target = targets[key]
            if (!target) continue
            if (!target.isReady()) return false
            const nested = target.relationTargets
            if (nested && !targetsReady(lastById(group.values), nested)) return false
        }
        return true
    }

    function canFileFirst(
        records: readonly object[],
        targets: RelationTargets | undefined
    ): boolean {
        if (!targets) return false
        const toFile = [...groupExpandedByKey(records).keys()].some(key => targets[key])
        return toFile && targetsReady(records, targets)
    }

    return {
        fileExpanded,
        upsertExpanded,
        canFileFirst,
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
