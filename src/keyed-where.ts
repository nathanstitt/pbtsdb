import type { IR } from '@tanstack/db'

type Node = { type: string; name?: string; args?: Node[]; path?: string[]; value?: unknown }

function isIdRef(node: Node | undefined): boolean {
    return node?.type === 'ref' && node.path?.length === 1 && node.path[0] === 'id'
}

function stringValue(node: Node | undefined): string | undefined {
    return node?.type === 'val' && typeof node.value === 'string' ? node.value : undefined
}

function collectEq(a: Node | undefined, b: Node | undefined): string[] | undefined {
    const other = isIdRef(a) ? b : isIdRef(b) ? a : undefined
    if (!other) return undefined
    const value = stringValue(other)
    return value === undefined ? undefined : [value]
}

function collectIn(a: Node | undefined, b: Node | undefined): string[] | undefined {
    if (!isIdRef(a) || b?.type !== 'val' || !Array.isArray(b.value)) return undefined
    return b.value.every(v => typeof v === 'string') ? (b.value as string[]) : undefined
}

function collectOr(args: Node[]): string[] | undefined {
    const ids: string[] = []
    for (const arg of args) {
        const sub = collect(arg)
        if (!sub) return undefined
        ids.push(...sub)
    }
    return ids
}

function collect(node: Node): string[] | undefined {
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
 * The ids a `where` selects when it is nothing but `id` equalities: `eq(id, x)`,
 * `in(id, [...])`, or an `or` of those. Anything else returns `undefined`.
 */
export function idsFromWhere(
    where: IR.BasicExpression<boolean> | undefined | null
): string[] | undefined {
    if (!where) return undefined
    const ids = collect(where as unknown as Node)
    return ids ? [...new Set(ids)].sort() : undefined
}
