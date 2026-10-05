import type { LoadSubsetOptions } from '@tanstack/db'

// TanStack composes a boundary tie-check as `and(subscription.where, extra)`
// and loads it through the same subscription; a cursor page arrives with
// `where === subscription.where`. The subscription's own where is the
// query's base filter, which is the one realtime should follow: every chunk
// of one query then shares one entry. `options` is private in TanStack's
// types, but `subscribeChanges` always sets its `whereExpression` key (even
// to undefined). A missing key means the shape changed underneath us, so the
// caller falls back to the request's where rather than guessing.
function subscriptionWhere(
    opts: LoadSubsetOptions
): { known: true; where: LoadSubsetOptions['where'] } | { known: false } {
    const sub = opts.subscription as
        | { options?: { whereExpression?: LoadSubsetOptions['where'] } }
        | undefined
    if (!sub?.options || !('whereExpression' in sub.options)) return { known: false }
    return { known: true, where: sub.options.whereExpression }
}

// What a loadSubset asks for beyond the subscription's own where. TanStack
// composes every chunk as `and(subscription.where, extra)` with the same where
// object, or hands the extra alone when the subscription has no where.
function chunkExtra(
    where: LoadSubsetOptions['where'],
    subWhere: LoadSubsetOptions['where']
): LoadSubsetOptions['where'] | null {
    if (where === subWhere) return undefined
    if (subWhere === undefined) return where
    const node = where as { type?: string; name?: string; args?: unknown[] } | undefined
    if (
        node?.type === 'func' &&
        node.name === 'and' &&
        node.args?.length === 2 &&
        node.args[0] === subWhere
    ) {
        return node.args[1] as LoadSubsetOptions['where']
    }
    return null // unknown shape: do not guess
}

// A join or include loads its lazy side as `inArray(joinKey, keys)`
// through that side's subscription. The key is the lazy side's own `id`
// only when it joins on its id; a foreign-key join batches on that FK, so
// the field cannot tell a batch from a slice. The operator can: an
// ordered loader's tie-check is `eq`, `and(gte, lt)` for a Date, or
// `or(isNull, isUndefined)`, never a top-level `in`. A batch keeps its own
// filter or realtime never covers it; a tie-check shares the base entry.
export function realtimeWhereFor(opts: LoadSubsetOptions): LoadSubsetOptions['where'] {
    if (!opts.subscription) return opts.where
    const sub = subscriptionWhere(opts)
    if (!sub.known) return opts.where // unknown shape: per-chunk behavior
    const extra = chunkExtra(opts.where, sub.where)
    if (extra === null) return opts.where // unknown shape: per-chunk behavior
    if (extra === undefined) return sub.where // the base load or a cursor page
    const node = extra as { type?: string; name?: string } | undefined
    return node?.type === 'func' && node.name === 'in' ? opts.where : sub.where
}
