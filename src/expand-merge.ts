type Expandable = { expand?: Record<string, unknown> } & Record<string, unknown>

type Entry = { id?: unknown; updated?: unknown }

function sameRelationValue(a: unknown, b: unknown): boolean {
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((value, index) => value === b[index])
    }
    return a === b
}

// True when `stored` describes the same record as `incoming` but carries a
// strictly newer `updated`. An in-flight parent fetch that resolves after a
// relation-target echo otherwise reverts the patch with its older copy.
function storedIsNewer(incoming: unknown, stored: unknown): boolean {
    const a = incoming as Entry | null | undefined
    const b = stored as Entry | null | undefined
    if (!a || !b || a.id !== b.id) return false
    if (typeof a.updated !== 'string' || typeof b.updated !== 'string') return false
    return b.updated > a.updated
}

function newerEntry(incoming: unknown, stored: unknown): unknown {
    if (Array.isArray(incoming) && Array.isArray(stored)) {
        let changed = false
        const merged = incoming.map(entry => {
            const match = stored.find(
                candidate => (candidate as Entry | null)?.id === (entry as Entry | null)?.id
            )
            if (!storedIsNewer(entry, match)) return entry
            changed = true
            return match
        })
        return changed ? merged : incoming
    }
    return storedIsNewer(incoming, stored) ? stored : incoming
}

/**
 * Carry `expand` entries from the stored row onto an incoming row that lacks them,
 * as long as the relation field itself did not change, and keep a stored entry
 * that is newer than the incoming one for the same record. Never mutates `incoming`.
 */
export function mergeExpand<T extends object>(incoming: T, existing: T | undefined): T {
    const stored = (existing as Expandable | undefined)?.expand
    if (!stored) return incoming
    const row = incoming as Expandable
    const merged: Record<string, unknown> = { ...(row.expand ?? {}) }
    let carried = false
    for (const [relation, value] of Object.entries(stored)) {
        if (relation in merged) {
            const kept = newerEntry(merged[relation], value)
            if (kept === merged[relation]) continue
            merged[relation] = kept
            carried = true
            continue
        }
        if (!sameRelationValue(row[relation], (existing as Expandable)[relation])) continue
        merged[relation] = value
        carried = true
    }
    return carried ? ({ ...row, expand: merged } as T) : incoming
}
