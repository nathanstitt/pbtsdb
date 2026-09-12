type Expandable = { expand?: Record<string, unknown> } & Record<string, unknown>

function sameRelationValue(a: unknown, b: unknown): boolean {
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((value, index) => value === b[index])
    }
    return a === b
}

/**
 * Carry `expand` entries from the stored row onto an incoming row that lacks them,
 * as long as the relation field itself did not change. Never mutates `incoming`.
 */
export function mergeExpand<T extends object>(
    incoming: T,
    existing: Expandable | undefined
): T & { expand?: Record<string, unknown> } {
    const stored = existing?.expand
    if (!stored) return incoming as T & { expand?: Record<string, unknown> }
    const row = incoming as Expandable
    const merged: Record<string, unknown> = { ...(row.expand ?? {}) }
    let carried = false
    for (const [relation, value] of Object.entries(stored)) {
        if (relation in merged) continue
        if (!sameRelationValue(row[relation], existing[relation])) continue
        merged[relation] = value
        carried = true
    }
    return carried
        ? ({ ...row, expand: merged } as T & { expand?: Record<string, unknown> })
        : (incoming as T & { expand?: Record<string, unknown> })
}
