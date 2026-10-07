import type { RecordSubscribeOptions } from 'pocketbase'
import type { WhereSubset } from './keyed-where'
import { escapeValue } from './pocketbase-query-converter'

// PocketBase refuses a filter over MaxFilterLength (3500 bytes) with a generic
// 400, and a subset's size is the caller's data — a user's memberships, a
// mailbox's threads. The margin below the server cap absorbs multi-byte values,
// since `.length` counts UTF-16 units.
const MAX_FILTER_LENGTH = 2500

// PocketBase caps a realtime subscription topic at 2500 characters, and the
// SDK URI-encodes the filter into the topic at roughly 2.1x its length; this
// leaves room for `expand` and factory headers in the same topic.
export const REALTIME_MAX_FILTER_LENGTH = 1000

/** PocketBase rejects a realtime subscription topic longer than this. */
export const REALTIME_TOPIC_MAX_LENGTH = 2500

// Option keys the PocketBase SDK keeps out of `query` (normalizeUnknownQueryParams).
const SDK_RESERVED_OPTIONS = new Set([
    'requestKey',
    '$cancelKey',
    '$autoCancel',
    'fetch',
    'headers',
    'body',
    'query',
    'params',
    'cache',
    'credentials',
    'integrity',
    'keepalive',
    'method',
    'mode',
    'redirect',
    'referrer',
    'referrerPolicy',
    'signal',
    'window',
])

/**
 * The topic the PocketBase server expects for a wildcard subscription on
 * `collectionName` with `options`, built the way the JS SDK builds it:
 * every key the SDK does not reserve moves into `query`.
 */
export function realtimeTopic(
    collectionName: string,
    options: RecordSubscribeOptions | undefined
): string {
    const topic = `${collectionName}/*`
    if (!options) return topic
    const query: Record<string, unknown> = { ...options.query }
    for (const [key, value] of Object.entries(options)) {
        if (!SDK_RESERVED_OPTIONS.has(key)) query[key] = value
    }
    const encoded = encodeURIComponent(JSON.stringify({ query, headers: options.headers }))
    return `${topic}?options=${encoded}`
}

/** Length of {@link realtimeTopic}; the server rejects one over `REALTIME_TOPIC_MAX_LENGTH`. */
export function realtimeTopicLength(
    collectionName: string,
    options: RecordSubscribeOptions | undefined
): number {
    return realtimeTopic(collectionName, options).length
}

/**
 * The PocketBase filters that select `subset`, each short enough for the server
 * to accept: one when every value fits, more when they do not. `maxLength`
 * defaults to the REST fetch budget; pass `REALTIME_MAX_FILTER_LENGTH` when the
 * filters go to a realtime subscription instead.
 */
export function subsetFilters(
    { field, values }: WhereSubset,
    maxLength = MAX_FILTER_LENGTH
): string[] {
    const filters: string[] = []
    let current = ''
    for (const value of values) {
        const clause = `${field} = ${escapeValue(value)}`
        const joined = current ? `${current} || ${clause}` : clause
        if (current && joined.length > maxLength) {
            filters.push(current)
            current = clause
        } else {
            current = joined
        }
    }
    if (current) filters.push(current)
    return filters
}
