import type { IR } from '@tanstack/db'
import { escapeValue } from './pocketbase-query-converter'

export type WhereSubset = { field: string; values: string[] }

type Node = { type: string; name?: string; args?: Node[]; path?: string[]; value?: unknown }

function fieldRef(node: Node | undefined): string | undefined {
    return node?.type === 'ref' && node.path?.length === 1 ? node.path[0] : undefined
}

function stringValue(node: Node | undefined): string | undefined {
    return node?.type === 'val' && typeof node.value === 'string' ? node.value : undefined
}

function collectEq(a: Node | undefined, b: Node | undefined): WhereSubset | undefined {
    const field = fieldRef(a) ?? fieldRef(b)
    if (field === undefined) return undefined
    const value = stringValue(fieldRef(a) !== undefined ? b : a)
    return value === undefined ? undefined : { field, values: [value] }
}

function collectIn(a: Node | undefined, b: Node | undefined): WhereSubset | undefined {
    const field = fieldRef(a)
    if (field === undefined || b?.type !== 'val' || !Array.isArray(b.value)) return undefined
    return b.value.every(v => typeof v === 'string')
        ? { field, values: b.value as string[] }
        : undefined
}

function collectOr(args: Node[]): WhereSubset | undefined {
    let field: string | undefined
    const values: string[] = []
    for (const arg of args) {
        const sub = collect(arg)
        if (!sub || (field !== undefined && sub.field !== field)) return undefined
        field = sub.field
        values.push(...sub.values)
    }
    return field === undefined ? undefined : { field, values }
}

function collect(node: Node): WhereSubset | undefined {
    if (node.type !== 'func' || !node.args) return undefined
    const [a, b] = node.args
    switch (node.name) {
        case 'eq':
            return collectEq(a, b)
        case 'in':
            return collectIn(a, b)
        case 'or':
            return collectOr(node.args)
        default:
            return undefined
    }
}

/**
 * The single-field subset a `where` selects when it is nothing but equalities on
 * one top-level field: `eq(field, x)`, `in(field, [...])`, or an `or` of those.
 * Anything else returns `undefined`.
 */
export function subsetFromWhere(
    where: IR.BasicExpression<boolean> | undefined | null
): WhereSubset | undefined {
    if (!where) return undefined
    const subset = collect(where as unknown as Node)
    return subset ? { field: subset.field, values: [...new Set(subset.values)].sort() } : undefined
}

// PocketBase refuses a filter over MaxFilterLength (3500 bytes) with a generic
// 400, and a subset's size is the caller's data — a user's memberships, a
// mailbox's threads. The margin below the server cap absorbs multi-byte values,
// since `.length` counts UTF-16 units.
const MAX_FILTER_LENGTH = 2500

/**
 * The PocketBase filters that select `subset`, each short enough for the server
 * to accept: one when every value fits, more when they do not.
 */
export function subsetFilters({ field, values }: WhereSubset): string[] {
    const filters: string[] = []
    let current = ''
    for (const value of values) {
        const clause = `${field} = ${escapeValue(value)}`
        const joined = current ? `${current} || ${clause}` : clause
        if (current && joined.length > MAX_FILTER_LENGTH) {
            filters.push(current)
            current = clause
        } else {
            current = joined
        }
    }
    if (current) filters.push(current)
    return filters
}

/** Whether a row's `field` is one of `wanted` (a multiple relation matches by containment). */
export function matchesSubset(row: object, field: string, wanted: ReadonlySet<string>): boolean {
    const value = (row as Record<string, unknown>)[field]
    if (typeof value === 'string') return wanted.has(value)
    if (Array.isArray(value))
        return value.some(item => typeof item === 'string' && wanted.has(item))
    return false
}
