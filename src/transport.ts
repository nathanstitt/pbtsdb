import type PocketBase from 'pocketbase'
import type { RecordSubscribeOptions, RecordSubscription } from 'pocketbase'
import { realtimeTopic } from './pocketbase-limits'
import { createRealtimeClient, type RealtimeClient } from './realtime-client'

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
    /** @internal Number of listeners registered through `onReconnect`; tests assert on it. */
    reconnectListenerCount: () => number
}

type Entry = { client: RealtimeClient; reconnectListeners: Set<(resumed: boolean) => void> }

const entries = new WeakMap<PocketBase, Entry>()

// PocketBase rejects a subscriptions POST whose auth record differs from
// the connection's with a 403, and an unchanged topic list sends no POST
// at all, so a login, logout or user switch must forget the session. A
// token refresh keeps the record and needs nothing.
function watchAuth(pb: PocketBase, client: RealtimeClient): void {
    let authId = pb.authStore.record?.id
    pb.authStore.onChange((_token, record) => {
        if (record?.id === authId) return
        authId = record?.id
        client.reset()
    })
}

function entryFor(pb: PocketBase): Entry {
    let entry = entries.get(pb)
    if (!entry) {
        const reconnectListeners = new Set<(resumed: boolean) => void>()
        const client = createRealtimeClient({
            url: pb.buildURL('/api/realtime'),
            send: body => pb.send('/api/realtime', { method: 'POST', body, requestKey: null }),
            onReconnect: resumed => {
                for (const listener of reconnectListeners) listener(resumed)
            },
        })
        watchAuth(pb, client)
        entry = { client, reconnectListeners }
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
        reconnectListenerCount: () => entry.reconnectListeners.size,
    }
}
