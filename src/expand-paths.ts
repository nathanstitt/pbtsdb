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
