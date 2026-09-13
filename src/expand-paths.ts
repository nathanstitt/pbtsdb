import type { ExpandTargetCollection } from './types'

export type RelationTargets = Record<string, ExpandTargetCollection>

export function normalizePaths(paths: Iterable<string>): string[] {
    const set = new Set<string>()
    for (const path of paths) {
        const trimmed = path.trim()
        if (trimmed) set.add(trimmed)
    }
    return [...set].sort()
}

export function splitPaths(csv: string | undefined): string[] {
    return csv ? normalizePaths(csv.split(',')) : []
}

export function joinPaths(paths: Iterable<string>): string | undefined {
    const normalized = normalizePaths(paths)
    return normalized.length > 0 ? normalized.join(',') : undefined
}

export const BACK_RELATION_EXPAND_CAP = 1000

/** `<collection>_via_<field>` → `{ field }`, split at the first `_via_`. */
export function parseViaKey(key: string): { field: string } | undefined {
    const index = key.indexOf('_via_')
    if (index < 0) return undefined
    const field = key.slice(index + '_via_'.length)
    return field ? { field } : undefined
}

/**
 * After a parent filed the values expanded under `key`, record on the target
 * that the subset `field = parentId` is complete — unless the key is a forward
 * relation or PocketBase may have capped the expand.
 */
export function markFiledSubset(
    target: ExpandTargetCollection,
    key: string,
    values: readonly object[],
    parentId: string
): void {
    const via = parseViaKey(key)
    if (!via || values.length >= BACK_RELATION_EXPAND_CAP) return
    target.markSubsetLoaded?.(via.field, parentId)
}

export function validateExpandPath(
    collectionName: string,
    targets: RelationTargets | undefined,
    path: string
): void {
    if (!targets) {
        throw new Error(
            `Cannot expand "${path}" on collection "${collectionName}": no relations declared`
        )
    }
    let current: RelationTargets | undefined = targets
    for (const segment of path.split('.')) {
        const next: ExpandTargetCollection | undefined = current?.[segment]
        if (!next) {
            throw new Error(
                `Cannot expand "${path}" on collection "${collectionName}": segment "${segment}" is not a declared relation`
            )
        }
        current = next.relationTargets
    }
}
