/** The state of pbtsdb's realtime connection for one PocketBase client. */
export type RealtimeStatus =
    /** `disconnectRealtime(pb)` is in effect, or no collection has subscribed yet. */
    | { state: 'disabled' }
    /** The first connection of a session is opening. */
    | { state: 'connecting' }
    /** The stream is open and `PB_CONNECT` was received. */
    | { state: 'connected' }
    /**
     * The stream dropped, or never came up, and a retry is scheduled.
     * `attempt` is the number of the retry, `nextRetryAt` when it fires and
     * `since` when the connection was lost, both epoch milliseconds.
     */
    | { state: 'reconnecting'; attempt: number; nextRetryAt: number; since: number }

/** Loads that are not progressing, across every collection of one client. */
export type LoadStatus = {
    /** Live demands sleeping in their `loadRetryDelays` backoff. */
    retrying: number
    /** When the oldest still-retrying load first failed, epoch milliseconds. */
    failingSince?: number
    /** Live demands whose load ended in an error that is not retried, such as a 403 or 404. */
    failed: number
}

export type SyncStatus = {
    realtime: RealtimeStatus
    loads: LoadStatus
}

export type SyncStatusListener = (status: SyncStatus) => void

export interface SyncStatusStore {
    get: () => SyncStatus
    subscribe: (listener: SyncStatusListener) => () => void
    /** Reads every source again and notifies when a value changed. */
    refresh: () => void
}

function sameRealtime(a: RealtimeStatus, b: RealtimeStatus): boolean {
    if (a.state !== b.state) return false
    if (a.state !== 'reconnecting' || b.state !== 'reconnecting') return true
    return a.attempt === b.attempt && a.nextRetryAt === b.nextRetryAt && a.since === b.since
}

function sameLoads(a: LoadStatus, b: LoadStatus): boolean {
    return a.retrying === b.retrying && a.failed === b.failed && a.failingSince === b.failingSince
}

export function mergeLoads(sources: Iterable<LoadStatus>): LoadStatus {
    const merged: LoadStatus = { retrying: 0, failed: 0 }
    for (const loads of sources) {
        merged.retrying += loads.retrying
        merged.failed += loads.failed
        if (loads.failingSince === undefined) continue
        if (merged.failingSince === undefined || loads.failingSince < merged.failingSince) {
            merged.failingSince = loads.failingSince
        }
    }
    return merged
}

/**
 * Snapshots are stable: `get()` returns the same object, with the same
 * nested objects, until a value changes, so `useSyncExternalStore` does
 * not re-render on every refresh.
 */
export function createSyncStatusStore(deps: {
    realtime: () => RealtimeStatus
    loads: () => Iterable<LoadStatus>
}): SyncStatusStore {
    const listeners = new Set<SyncStatusListener>()
    let snapshot: SyncStatus = { realtime: deps.realtime(), loads: mergeLoads(deps.loads()) }

    function next(): SyncStatus | undefined {
        const realtime = deps.realtime()
        const loads = mergeLoads(deps.loads())
        const realtimeChanged = !sameRealtime(snapshot.realtime, realtime)
        const loadsChanged = !sameLoads(snapshot.loads, loads)
        if (!realtimeChanged && !loadsChanged) return undefined
        return {
            realtime: realtimeChanged ? realtime : snapshot.realtime,
            loads: loadsChanged ? loads : snapshot.loads,
        }
    }

    return {
        get: () => snapshot,
        subscribe(listener) {
            listeners.add(listener)
            return () => {
                listeners.delete(listener)
            }
        },
        refresh() {
            const changed = next()
            if (!changed) return
            snapshot = changed
            for (const listener of listeners) listener(snapshot)
        },
    }
}
