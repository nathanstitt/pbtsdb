import type { SyncConfig } from '@tanstack/db'
import type { QueryClient } from '@tanstack/react-query'
import { idOf } from './records'

type SyncParams<T extends object> = Parameters<SyncConfig<T, string | number>['sync']>[0]

/** The part of a running sync session pbtsdb writes through. */
export type SyncChannel<T extends object> = Pick<SyncParams<T>, 'begin' | 'write' | 'commit'>

/** What the store reads from the collection it writes into. */
export interface SyncedStoreDeps<T extends object> {
    collectionName: string
    queryClient: QueryClient
    /** The row once every accepted sync transaction applies; see docs/internals.md. */
    acceptedRow: (id: string) => T | undefined
}

/**
 * pbtsdb's authoritative writes (realtime echoes, mutation write-backs, filed
 * relation rows) as sync transactions on the running session, plus the cache
 * claim that keeps their ownership (see docs/internals.md, "Authoritative
 * writes").
 */
export interface SyncedStore<T extends object> {
    /** Bind the session `sync()` was called with; replaces any earlier one. */
    attach: (channel: SyncChannel<T>) => void
    /** Forget `channel` if it is still the bound session. */
    detach: (channel: SyncChannel<T>) => void
    /**
     * Upsert `rows` and delete `ids` in one sync transaction. Returns false,
     * writing nothing, when no sync session is running. A delete of a key the
     * store lacks writes nothing but still leaves every cached result.
     */
    apply: (rows: readonly T[], ids?: readonly string[]) => boolean
}

/** `data` with `written` rows replaced or appended and `removed` rows dropped. */
function withClaimed<T extends object>(
    data: readonly T[],
    written: ReadonlyMap<string, T>,
    removed: ReadonlySet<string>
): T[] {
    const appended = new Map(written)
    const next: T[] = []
    for (const row of data) {
        const id = idOf(row)
        if (id === undefined) {
            next.push(row)
            continue
        }
        if (removed.has(id)) continue
        next.push(appended.get(id) ?? row)
        appended.delete(id)
    }
    next.push(...appended.values())
    return next
}

export function createSyncedStore<T extends object>(deps: SyncedStoreDeps<T>): SyncedStore<T> {
    const { collectionName, queryClient, acceptedRow } = deps
    let session: SyncChannel<T> | undefined

    // TanStack DB keeps the object a sync source writes as the stored row,
    // so each write gets its own copy: a caller that later changes its object
    // in place cannot change the store behind the collection's back, nor trip
    // the development-only SyncRowReusedWithoutPreviousValueError.
    function lastById(rows: readonly T[]): Map<string, T> {
        const byId = new Map<string, T>()
        for (const row of rows) {
            const id = idOf(row)
            if (id !== undefined) byId.set(id, { ...row })
        }
        return byId
    }

    function transact(channel: SyncChannel<T>, fn: () => void): void {
        channel.begin()
        try {
            fn()
        } catch (error) {
            const cancel = new AbortController()
            cancel.abort()
            channel.commit(cancel.signal)
            throw error
        }
        channel.commit()
    }

    // A row in a query's cached result is owned by that query: its next
    // refetch may prune it, and unloading it drops the row once no query
    // owns it. Every cached query of the collection claims the rows written
    // here, as query-db-collection's own writes did before 1.3.
    function claim(written: Map<string, T>, removed: Set<string>): void {
        for (const query of queryClient.getQueryCache().findAll({ queryKey: [collectionName] })) {
            queryClient.setQueryData<T[]>(query.queryKey, data =>
                Array.isArray(data) ? withClaimed(data, written, removed) : data
            )
        }
    }

    return {
        attach(channel) {
            session = channel
        },
        detach(channel) {
            if (session === channel) session = undefined
        },
        apply(rows, ids = []) {
            const channel = session
            if (!channel) return false
            const written = lastById(rows)
            const removed = new Set(ids.filter(id => !written.has(id)))
            const present = [...removed].filter(id => acceptedRow(id) !== undefined)
            if (written.size > 0 || present.length > 0) {
                transact(channel, () => {
                    for (const [id, row] of written) {
                        channel.write({ type: acceptedRow(id) ? 'update' : 'insert', value: row })
                    }
                    for (const id of present) channel.write({ type: 'delete', key: id })
                })
            }
            // A cached result still listing a removed row would restore it
            // when its query next mounts, so the claim runs even when the
            // store no longer held the row.
            claim(written, removed)
            return true
        },
    }
}
