import type PocketBase from 'pocketbase'
import type { RecordSubscribeOptions, RecordSubscription } from 'pocketbase'
import { realtimeTopic } from './pocketbase-limits'
import {
    createRealtimeClient,
    type RealtimeClient,
    type RealtimeEventSourceFactory,
} from './realtime-client'
import {
    createSyncStatusStore,
    type LoadStatus,
    type SyncStatus,
    type SyncStatusListener,
    type SyncStatusStore,
} from './sync-status'

export type Unsubscribe = () => Promise<void>

/** What pbtsdb needs from the server for realtime. REST calls stay on the SDK. */
export interface Transport {
    /** Resolves once the server has the topic. */
    subscribe: <T extends object>(
        collectionName: string,
        options: RecordSubscribeOptions | undefined,
        handler: (event: RecordSubscription<T>) => void
    ) => Promise<Unsubscribe>
    /** Called after every reconnect of the shared connection. */
    onReconnect: (listener: (resumed: boolean) => void) => () => void
    /** Called when `pb.authStore` changes to another auth record, before the realtime session resets. */
    onAuthChange: (listener: () => void) => () => void
    /** @internal Number of listeners registered through `onReconnect`; tests assert on it. */
    reconnectListenerCount: () => number
    /** Counts `source` into the client's `SyncStatus.loads` until the returned function is called. */
    addLoadSource: (source: () => LoadStatus) => () => void
    /** Call after anything a load source reports may have changed. */
    loadStatusChanged: () => void
    /** @internal Number of load sources registered; tests assert on it. */
    loadSourceCount: () => number
}

type Entry = {
    client: RealtimeClient
    reconnectListeners: Set<(resumed: boolean) => void>
    authListeners: Set<() => void>
    status: SyncStatusStore
    loadSources: Set<() => LoadStatus>
    eventSource?: RealtimeEventSourceFactory
}

const entries = new WeakMap<PocketBase, Entry>()

// PocketBase rejects a subscriptions POST whose auth record differs from
// the connection's with a 403, and an unchanged topic list sends no POST
// at all, so a login, logout or user switch must forget the session. A
// token refresh keeps the record and needs nothing.
function watchAuth(pb: PocketBase, entry: Entry): void {
    let authId = pb.authStore.record?.id
    pb.authStore.onChange((_token, record) => {
        if (record?.id === authId) return
        authId = record?.id
        for (const listener of entry.authListeners) listener()
        entry.client.reset()
    })
}

function entryFor(pb: PocketBase): Entry {
    let entry = entries.get(pb)
    if (!entry) {
        const reconnectListeners = new Set<(resumed: boolean) => void>()
        const loadSources = new Set<() => LoadStatus>()
        let status: SyncStatusStore | undefined
        let created: Entry | undefined
        const client = createRealtimeClient({
            get url() {
                return pb.buildURL('/api/realtime')
            },
            get eventSource() {
                return created?.eventSource
            },
            send: body => pb.send('/api/realtime', { method: 'POST', body, requestKey: null }),
            onReconnect: resumed => {
                for (const listener of reconnectListeners) listener(resumed)
            },
            onStatusChange: () => status?.refresh(),
        })
        status = createSyncStatusStore({
            realtime: client.status,
            loads: () => [...loadSources].map(source => source()),
        })
        entry = { client, reconnectListeners, authListeners: new Set(), status, loadSources }
        created = entry
        watchAuth(pb, entry)
        entries.set(pb, entry)
    }
    return entry
}

/** @internal The realtime client behind `transportFor(pb)`; tests spy on its `subscribe`. */
export function realtimeClientFor(pb: PocketBase): RealtimeClient {
    return entryFor(pb).client
}

/**
 * Forgets the shared realtime connection's server-side session and
 * reconnects under `pb`'s current auth, re-sending every subscribed topic.
 * pbtsdb does this itself when `pb.authStore` changes to another auth
 * record; call it for a change the store cannot see, such as a server
 * switch. It also lifts {@link disconnectRealtime}. A no-op if `pb` has no
 * realtime connection yet.
 */
export function resetRealtime(pb: PocketBase): void {
    const client = entries.get(pb)?.client
    if (!client) return
    client.reset()
    client.enable()
}

/**
 * Closes pbtsdb's realtime connection for `pb` and keeps it closed: no
 * connection opens until {@link resetRealtime}. Collections keep working
 * over REST and keep their subscriptions registered, so a later
 * `resetRealtime(pb)` resumes every topic and reloads every ready
 * collection. Use it at logout, or at startup where realtime is not wanted.
 */
export function disconnectRealtime(pb: PocketBase): void {
    entryFor(pb).client.disable()
}

/**
 * Sets how pbtsdb opens its realtime connection for `pb`, in place of the
 * global `EventSource`. Use it where no global exists (React Native), or to
 * send headers the browser `EventSource` cannot, such as `Authorization`.
 * The factory is called on each connect, so read `pb.authStore.token`
 * inside it: a refreshed token is then sent on the next reconnect. Send no
 * `Authorization` header when there is no token. The next connection uses
 * the factory; an open connection is kept. `undefined` restores the default.
 *
 * @example
 * // RNEventSource from react-native-sse
 * setRealtimeEventSource(pb, url =>
 *     new RNEventSource(url, {
 *         headers: pb.authStore.token ? { Authorization: pb.authStore.token } : {},
 *     })
 * )
 */
export function setRealtimeEventSource(
    pb: PocketBase,
    factory: RealtimeEventSourceFactory | undefined
): void {
    entryFor(pb).eventSource = factory
}

/**
 * The sync state of `pb`'s collections: whether pbtsdb's realtime stream
 * is up, and how many live loads are stuck in retry or ended in an error
 * the server meant. The snapshot is stable until a value changes, so it
 * suits `useSyncExternalStore`; see {@link subscribeSyncStatus}.
 */
export function getSyncStatus(pb: PocketBase): SyncStatus {
    return entryFor(pb).status.get()
}

/**
 * Calls `listener` with each new {@link getSyncStatus} snapshot. Returns
 * the unsubscribe function.
 */
export function subscribeSyncStatus(pb: PocketBase, listener: SyncStatusListener): () => void {
    return entryFor(pb).status.subscribe(listener)
}

export function transportFor(pb: PocketBase): Transport {
    const entry = entryFor(pb)
    return {
        subscribe: <T extends object>(
            collectionName: string,
            options: RecordSubscribeOptions | undefined,
            handler: (event: RecordSubscription<T>) => void
        ) =>
            entry.client.subscribe(realtimeTopic(collectionName, options), event =>
                handler(event as unknown as RecordSubscription<T>)
            ),
        onReconnect(listener) {
            entry.reconnectListeners.add(listener)
            return () => {
                entry.reconnectListeners.delete(listener)
            }
        },
        onAuthChange(listener) {
            entry.authListeners.add(listener)
            return () => {
                entry.authListeners.delete(listener)
            }
        },
        reconnectListenerCount: () => entry.reconnectListeners.size,
        addLoadSource(source) {
            entry.loadSources.add(source)
            return () => {
                entry.loadSources.delete(source)
                entry.status.refresh()
            }
        },
        loadStatusChanged: entry.status.refresh,
        loadSourceCount: () => entry.loadSources.size,
    }
}
