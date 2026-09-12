import { deepEquals } from '@tanstack/db'
import { mergeExpand } from './expand-merge'

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
