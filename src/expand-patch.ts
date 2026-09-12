import { deepEquals } from '@tanstack/db'
import { mergeExpand } from './expand-merge'
import { logger } from './logger'
import type { ExpandTargetCollection, RelationDependent } from './types'

export type RelatedAction = 'create' | 'update' | 'delete'

type Row = Record<string, unknown> & { expand?: Record<string, unknown> }

function embeddedId(value: unknown): string | undefined {
    return (value as { id: string } | null | undefined)?.id
}

function patchUpdate(
    row: Row,
    field: string,
    record: Record<string, unknown> & { id: string }
): Row | undefined {
    const embedded = row.expand?.[field]
    if (embedded === undefined) return undefined
    let next: unknown
    if (Array.isArray(embedded)) {
        const index = embedded.findIndex(entry => embeddedId(entry) === record.id)
        if (index === -1) return undefined
        const replaced = mergeExpand(record, embedded[index] as { id: string })
        next = embedded.map((entry, i) => (i === index ? replaced : entry))
    } else {
        if (embeddedId(embedded) !== record.id) return undefined
        next = mergeExpand(record, embedded as { id: string })
    }
    if (deepEquals(next, embedded)) return undefined
    return { ...row, expand: { ...row.expand, [field]: next } }
}

function patchDelete(row: Row, field: string, id: string): Row | undefined {
    const value = row[field]
    const embedded = row.expand?.[field]
    if (Array.isArray(value)) {
        if (!value.includes(id)) return undefined
        const patched: Row = { ...row, [field]: value.filter(item => item !== id) }
        if (Array.isArray(embedded)) {
            patched.expand = {
                ...row.expand,
                [field]: embedded.filter(entry => embeddedId(entry) !== id),
            }
        }
        return patched
    }
    if (value !== id) return undefined
    const patched: Row = { ...row, [field]: '' }
    if (embedded !== undefined) {
        const expand = { ...row.expand }
        delete expand[field]
        patched.expand = expand
    }
    return patched
}

/**
 * Apply a relation target's realtime change to one parent row. Returns a new
 * row, or `undefined` when the row is unaffected or the result would be
 * identical, so callers can skip the write.
 */
export function patchEmbedded<T extends object>(
    row: T,
    field: string,
    action: RelatedAction,
    record: Record<string, unknown> & { id: string }
): T | undefined {
    const current = row as Row
    const patched =
        action === 'delete'
            ? patchDelete(current, field, record.id)
            : patchUpdate(current, field, record)
    return patched as T | undefined
}

// Dependents grouped by parent, registration order preserved both for the
// parents and for each parent's fields. One parent may declare several
// relations onto the same target; all of its fields must reach it in a single
// call, because `visited` is keyed per row and the first call marks the row.
function fieldsByParent(
    dependents: readonly RelationDependent[]
): Map<ExpandTargetCollection, string[]> {
    const grouped = new Map<ExpandTargetCollection, string[]>()
    for (const { field, parent } of dependents) {
        const fields = grouped.get(parent)
        if (fields) fields.push(field)
        else grouped.set(parent, [field])
    }
    return grouped
}

/**
 * Fan a relation target's change out to every collection that embeds it.
 * Each dependent patches its own rows and recurses with the same `visited`
 * set, so a cyclic relation graph terminates and a row is patched at most
 * once per originating echo.
 */
export function propagateRelatedChange(
    source: ExpandTargetCollection,
    action: RelatedAction,
    record: Record<string, unknown> & { id: string },
    visited: Set<string>
): void {
    for (const [parent, fields] of fieldsByParent(source.relationDependents ?? [])) {
        try {
            parent.applyRelatedChange?.(fields, action, record, visited)
        } catch (error) {
            logger.error('Failed to patch a relation dependent', {
                collectionName: source.collectionName,
                dependent: parent.collectionName,
                fields,
                error,
            })
        }
    }
}
