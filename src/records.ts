// Accessors for the untyped records PocketBase hands back: rows, expand
// entries, and realtime events.

export function idOf(value: unknown): string | undefined {
    if (!value || typeof value !== 'object' || !('id' in value)) return undefined
    return typeof value.id === 'string' ? value.id : undefined
}

export function updatedAtOf(value: unknown): string | undefined {
    if (!value || typeof value !== 'object' || !('updated' in value)) return undefined
    return typeof value.updated === 'string' && value.updated !== '' ? value.updated : undefined
}

export function expandOf(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || !('expand' in value)) return undefined
    const { expand } = value
    return expand && typeof expand === 'object' ? (expand as Record<string, unknown>) : undefined
}

export function isObject(value: unknown): value is object {
    return typeof value === 'object' && value !== null
}
