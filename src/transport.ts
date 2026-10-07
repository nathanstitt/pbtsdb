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

function entryFor(pb: PocketBase): Entry {
    let entry = entries.get(pb)
    if (!entry) {
        const reconnectListeners = new Set<(resumed: boolean) => void>()
        const client = createRealtimeClient({
            url: pb.buildURL('/api/realtime'),
            send: body => pb.send('/api/realtime', { method: 'POST', body }),
            onReconnect: resumed => {
                for (const listener of reconnectListeners) listener(resumed)
            },
        })
        entry = { client, reconnectListeners }
        entries.set(pb, entry)
    }
    return entry
}

/** @internal The realtime client behind `transportFor(pb)`; tests spy on its `subscribe`. */
export function realtimeClientFor(pb: PocketBase): RealtimeClient {
    return entryFor(pb).client
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
