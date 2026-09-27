import { logger } from './logger'
import { idOf, updatedAtOf } from './records'

/** What the guard reads from and writes to the collection it protects. */
export interface GuardedStore<T extends object> {
    isReady: () => boolean
    syncedRow: (id: string) => T | undefined
    /** True while an optimistic mutation on `id` has not settled. */
    hasPendingMutation: (id: string) => boolean
    writeUpsert: (records: T[]) => void
}

export interface SyncedWrite {
    type: string
    value?: unknown
    key?: unknown
}

/** An in-flight fetch's view of rows confirmed after it was issued. */
export interface TrackedFetch {
    confirmed: Set<string>
    done: () => void
}

/**
 * Guards the synced store against writes that would revert a row: late query
 * results and reordered echoes (see docs/internals.md, "Staleness" and
 * "Confirmed rows and in-flight fetches").
 */
export interface SyncedWriteGuard<T extends object> {
    /** Run pbtsdb's own authoritative write; exempt from the optimistic check. */
    writeOwn: (fn: () => void) => void
    isOwnWrite: () => boolean
    shouldDrop: (op: SyncedWrite) => boolean
    isStaleServerRecord: (record: unknown) => boolean
    /** Record that the server holds these rows, for every fetch in flight. */
    markConfirmedPresent: (records: readonly T[]) => void
    trackFetch: () => TrackedFetch
    /** A fetch result plus every row confirmed while it was in flight. */
    withRowsConfirmedMidFlight: (items: T[], confirmed: Set<string>) => T[]
    /** Land a mutation's server rows once its transaction has persisted. */
    writeBackAfterPersisted: (
        transaction: { isPersisted: { promise: Promise<unknown> } },
        records: T[]
    ) => void
}

export function createSyncedWriteGuard<T extends object>(
    collectionName: string,
    store: GuardedStore<T>
): SyncedWriteGuard<T> {
    let applyingOwnWrite = false
    const inFlight = new Set<Set<string>>()

    // Strictly older by `updated` than the synced row; ISO 8601 strings compare
    // chronologically. Equal is the same version and must pass, since that is
    // what clears a lingering optimistic overlay.
    function isStaleServerRecord(record: unknown): boolean {
        const id = idOf(record)
        if (!id) return false
        const incoming = updatedAtOf(record)
        if (!incoming) return false
        const current = updatedAtOf(store.syncedRow(id))
        return current !== undefined && incoming < current
    }

    function writeKey(op: SyncedWrite): string | null {
        if (op.type !== 'insert' && op.type !== 'update') return null
        if (typeof op.key === 'string') return op.key
        return idOf(op.value) ?? null
    }

    function markConfirmedPresent(records: readonly T[]): void {
        if (inFlight.size === 0) return
        for (const record of records) {
            const id = idOf(record)
            if (!id) continue
            for (const confirmed of inFlight) confirmed.add(id)
        }
    }

    function withRowsConfirmedMidFlight(items: T[], confirmed: Set<string>): T[] {
        if (confirmed.size === 0) return items
        const resultIds = new Set(items.map(idOf))
        const merged: T[] = []
        for (const id of confirmed) {
            if (resultIds.has(id)) continue
            const row = store.syncedRow(id)
            if (row) merged.push(row)
        }
        if (merged.length === 0) return items
        logger.debug('Merging rows confirmed while fetch was in flight', {
            collectionName,
            ids: merged.map(idOf),
        })
        return [...items, ...merged]
    }

    return {
        writeOwn(fn) {
            applyingOwnWrite = true
            try {
                fn()
            } finally {
                applyingOwnWrite = false
            }
        },
        isOwnWrite: () => applyingOwnWrite,
        // A write to a key the synced store lacks is populating it and must
        // pass, or the row is absent once the overlay clears.
        shouldDrop(op) {
            const key = writeKey(op)
            if (key === null) return false
            if (!applyingOwnWrite && store.hasPendingMutation(key) && store.syncedRow(key)) {
                logger.debug('Dropping synced write for optimistically-pending row', {
                    collectionName,
                    id: key,
                })
                return true
            }
            if (isStaleServerRecord(op.value)) {
                logger.debug('Dropping stale synced write', { collectionName, id: key })
                return true
            }
            return false
        },
        isStaleServerRecord,
        markConfirmedPresent,
        trackFetch() {
            const confirmed = new Set<string>()
            inFlight.add(confirmed)
            return { confirmed, done: () => inFlight.delete(confirmed) }
        },
        withRowsConfirmedMidFlight,
        // Rows are marked confirmed at once. The write waits for persistence
        // (see docs/internals.md, "Write-back timing"), skips a collection
        // that is not ready, and drops rows the store already supersedes.
        writeBackAfterPersisted(transaction, records) {
            markConfirmedPresent(records)
            void transaction.isPersisted.promise.then(
                () => {
                    if (!store.isReady()) return
                    const fresh = records.filter(record => !isStaleServerRecord(record))
                    if (fresh.length > 0) this.writeOwn(() => store.writeUpsert(fresh))
                },
                () => undefined
            )
        },
    }
}
