import { logger } from './logger'
import { REALTIME_TOPIC_MAX_LENGTH } from './pocketbase-limits'

export interface RealtimeEvent {
    action: string
    record: unknown
    /** Per-client sequence, sent by a server with resume support. */
    seq?: number
}

export type RealtimeListener = (event: RealtimeEvent) => void

/** What the client needs from an EventSource; the global one or a React Native polyfill. */
export type EventSourceLike = {
    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void
    close(): void
    onerror: ((ev: Event) => void) | null
}

export interface RealtimeClientDeps {
    /** Absolute URL of `/api/realtime`. */
    url: string
    /** `POST /api/realtime` with the SDK's auth; rejects on a non-2xx response. */
    send: (body: { clientId: string; subscriptions: string[] }) => Promise<unknown>
    eventSource?: (url: string) => EventSourceLike
    /** After a reconnect. `resumed` is true when the server replayed the gap. */
    onReconnect?: (resumed: boolean) => void
    backoff?: readonly number[]
}

export class RealtimeTopicTooLongError extends Error {
    constructor(length: number) {
        super(
            `Realtime topic is ${length} characters; the server accepts ${REALTIME_TOPIC_MAX_LENGTH}`
        )
        this.name = 'RealtimeTopicTooLongError'
    }
}

/** Rejects a `subscribe` whose topic was never confirmed because `disconnect()` was called first. */
export class RealtimeDisconnectedError extends Error {
    constructor() {
        super('Realtime client was disconnected before this subscription was confirmed')
        this.name = 'RealtimeDisconnectedError'
    }
}

/**
 * One SSE connection to PocketBase with its topic list. Topic changes made
 * in one tick go out in one POST; `subscribe` resolves once the server has
 * the topic (see docs/internals.md, "Realtime client").
 */
export interface RealtimeClient {
    subscribe: (topic: string, listener: RealtimeListener) => Promise<() => Promise<void>>
    topics: () => string[]
    isConnected: () => boolean
    clientId: () => string | undefined
    disconnect: () => void
    /** @internal Simulates the live connection dropping, the way `onerror` would; tests use it. */
    simulateDisconnect: () => void
}

export const REALTIME_BACKOFF_MS: readonly number[] = [200, 300, 500, 1000, 1200, 1500, 2000]

type Waiter = { resolve: () => void; reject: (error: unknown) => void }

export function createRealtimeClient(deps: RealtimeClientDeps): RealtimeClient {
    const backoff = deps.backoff ?? REALTIME_BACKOFF_MS
    const openSource = deps.eventSource ?? ((url: string) => new EventSource(url))

    const listeners = new Map<string, Set<RealtimeListener>>()
    const dispatchers = new Map<string, EventListener>()
    let source: EventSourceLike | undefined
    let connected = false
    let clientId: string | undefined
    let lastSeq: number | undefined
    /** The topic list the server last confirmed; survives a resumed reconnect's `close()`. */
    let confirmed: string[] = []
    let waiters: Waiter[] = []
    let submitQueued = false
    let submitting = false
    let resubmit = false
    let attempts = 0
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let everConnected = false

    function topics(): string[] {
        return [...listeners.keys()]
    }

    function dispatcherFor(topic: string): EventListener {
        let dispatch = dispatchers.get(topic)
        if (!dispatch) {
            dispatch = (ev: Event) => {
                const message = ev as MessageEvent
                let event: RealtimeEvent
                try {
                    event = JSON.parse(String(message.data)) as RealtimeEvent
                } catch {
                    return
                }
                if (typeof event.seq === 'number') lastSeq = event.seq
                for (const listener of listeners.get(topic) ?? []) listener(event)
            }
            dispatchers.set(topic, dispatch)
        }
        return dispatch
    }

    function sameList(a: readonly string[], b: readonly string[]): boolean {
        return a.length === b.length && a.every(topic => b.includes(topic))
    }

    function settleWaiters(pending: Waiter[], error?: unknown): void {
        for (const waiter of pending) error === undefined ? waiter.resolve() : waiter.reject(error)
    }

    async function sendTopics(): Promise<void> {
        const list = topics()
        if (list.length === 0) {
            close(true)
            clientId = undefined
            lastSeq = undefined
            return
        }
        if (sameList(list, confirmed)) return
        const id = clientId
        if (!id) return
        await deps.send({ clientId: id, subscriptions: list })
        if (clientId === id) confirmed = list
    }

    async function runSubmit(): Promise<void> {
        if (submitting) {
            resubmit = true
            return
        }
        if (!connected || !clientId) {
            if (listeners.size === 0) {
                const pending = waiters
                waiters = []
                close(true)
                clientId = undefined
                lastSeq = undefined
                settleWaiters(pending)
            }
            return
        }
        submitting = true
        const pending = waiters
        waiters = []
        try {
            await sendTopics()
            settleWaiters(pending)
        } catch (error) {
            logger.error('Failed to set realtime subscriptions', { error })
            settleWaiters(pending, error)
        } finally {
            submitting = false
            if (resubmit) {
                resubmit = false
                void runSubmit()
            }
        }
    }

    function submit(): Promise<void> {
        const done = new Promise<void>((resolve, reject) => {
            waiters.push({ resolve, reject })
        })
        if (!submitQueued) {
            submitQueued = true
            queueMicrotask(() => {
                submitQueued = false
                void runSubmit()
            })
        }
        return done
    }

    function attachAll(target: EventSourceLike): void {
        for (const topic of listeners.keys()) target.addEventListener(topic, dispatcherFor(topic))
    }

    function connectUrl(): string {
        if (!clientId) return deps.url
        const params = new URLSearchParams({ resume: clientId })
        if (lastSeq !== undefined) params.set('after', String(lastSeq))
        return `${deps.url}${deps.url.includes('?') ? '&' : '?'}${params}`
    }

    /**
     * Closes the connection. `forget` clears `confirmed` because the server's
     * state for this client is gone too (the last topic was removed, or the
     * caller is disconnecting outright) — not on a transient error, where a
     * resumed reconnect may still find the server holding the old list.
     * `everConnected` resets with it: a session after a full teardown is a
     * first connect again, not a reconnect.
     */
    function close(forget: boolean): void {
        if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
        reconnectTimer = undefined
        source?.close()
        source = undefined
        connected = false
        if (forget) {
            confirmed = []
            everConnected = false
        }
    }

    function scheduleReconnect(): void {
        const delay = backoff[Math.min(attempts, backoff.length - 1)] ?? 0
        attempts += 1
        reconnectTimer = setTimeout(() => {
            reconnectTimer = undefined
            if (listeners.size > 0) connect()
        }, delay)
    }

    function handleConnectionLost(target: EventSourceLike): void {
        if (source !== target) return
        logger.debug('Realtime connection lost', { clientId })
        close(false)
        scheduleReconnect()
    }

    function connect(): void {
        if (source) return
        const previousId = clientId
        const target = openSource(connectUrl())
        source = target
        target.onerror = () => handleConnectionLost(target)
        target.addEventListener('PB_CONNECT', (ev: Event) => {
            if (source !== target) return
            const message = ev as MessageEvent
            let data: { clientId?: string; resumed?: boolean } = {}
            try {
                data = JSON.parse(String(message.data)) as typeof data
            } catch {
                data = {}
            }
            const id = message.lastEventId || data.clientId
            if (!id) return
            const resumed = data.resumed === true && id === previousId
            clientId = id
            connected = true
            if (!resumed) {
                lastSeq = undefined
                confirmed = []
            }
            attachAll(target)
            const isReconnect = everConnected
            submit().then(
                () => {
                    attempts = 0
                    if (isReconnect) deps.onReconnect?.(resumed)
                    everConnected = true
                },
                () => {
                    everConnected = true
                    if (!isReconnect || source !== target) return
                    close(false)
                    scheduleReconnect()
                }
            )
        })
    }

    return {
        subscribe(topic, listener) {
            if (topic.length > REALTIME_TOPIC_MAX_LENGTH) {
                return Promise.reject(new RealtimeTopicTooLongError(topic.length))
            }
            if (!source) {
                try {
                    connect()
                } catch (error) {
                    return Promise.reject(error)
                }
            }
            let set = listeners.get(topic)
            const isNew = set === undefined
            if (!set) {
                set = new Set()
                listeners.set(topic, set)
            }
            set.add(listener)
            if (isNew && source && connected) source.addEventListener(topic, dispatcherFor(topic))
            const ready = submit()
            const unsubscribe = async () => {
                const current = listeners.get(topic)
                if (!current?.delete(listener)) return
                if (current.size > 0) return
                listeners.delete(topic)
                const dispatch = dispatchers.get(topic)
                if (dispatch) {
                    source?.removeEventListener(topic, dispatch)
                    dispatchers.delete(topic)
                }
                await submit().catch(() => undefined)
            }
            return ready.then(
                () => unsubscribe,
                (error: unknown) => {
                    const current = listeners.get(topic)
                    if (current?.delete(listener) && current.size === 0) {
                        listeners.delete(topic)
                        const dispatch = dispatchers.get(topic)
                        if (dispatch) {
                            source?.removeEventListener(topic, dispatch)
                            dispatchers.delete(topic)
                        }
                    }
                    throw error
                }
            )
        },
        topics,
        isConnected: () => connected,
        clientId: () => clientId,
        disconnect() {
            close(true)
            clientId = undefined
            lastSeq = undefined
            const pending = waiters
            waiters = []
            listeners.clear()
            dispatchers.clear()
            settleWaiters(pending, new RealtimeDisconnectedError())
        },
        simulateDisconnect() {
            if (source) handleConnectionLost(source)
        },
    }
}
