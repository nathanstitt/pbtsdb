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
    onerror: ((ev: unknown) => void) | null
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
}

export const REALTIME_BACKOFF_MS: readonly number[] = [200, 300, 500, 1000, 1200, 1500, 2000]

type Waiter = { resolve: () => void; reject: (error: unknown) => void }

export function createRealtimeClient(deps: RealtimeClientDeps): RealtimeClient {
    const backoff = deps.backoff ?? REALTIME_BACKOFF_MS
    const openSource =
        deps.eventSource ?? ((url: string) => new EventSource(url) as unknown as EventSourceLike)

    const listeners = new Map<string, Set<RealtimeListener>>()
    const dispatchers = new Map<string, EventListener>()
    let source: EventSourceLike | undefined
    let connected = false
    let clientId: string | undefined
    let lastSeq: number | undefined
    let lastSent: string[] = []
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

    function settleWaiters(error?: unknown): void {
        const pending = waiters
        waiters = []
        for (const waiter of pending) error === undefined ? waiter.resolve() : waiter.reject(error)
    }

    async function sendTopics(): Promise<void> {
        if (!connected || !clientId) return
        const list = topics()
        if (list.length === 0) {
            close()
            settleWaiters()
            return
        }
        if (sameList(list, lastSent)) {
            settleWaiters()
            return
        }
        const id = clientId
        await deps.send({ clientId: id, subscriptions: list })
        if (clientId === id) lastSent = list
    }

    async function runSubmit(): Promise<void> {
        if (submitting) {
            resubmit = true
            return
        }
        submitting = true
        try {
            await sendTopics()
            settleWaiters()
        } catch (error) {
            logger.error('Failed to set realtime subscriptions', { error })
            settleWaiters(error)
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

    function close(): void {
        if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
        reconnectTimer = undefined
        source?.close()
        source = undefined
        connected = false
        lastSent = []
    }

    function scheduleReconnect(): void {
        const delay = backoff[Math.min(attempts, backoff.length - 1)] ?? 0
        attempts += 1
        reconnectTimer = setTimeout(() => {
            reconnectTimer = undefined
            if (listeners.size > 0) connect()
        }, delay)
    }

    function connect(): void {
        if (source) return
        const previousId = clientId
        const target = openSource(connectUrl())
        source = target
        target.onerror = () => {
            if (source !== target) return
            logger.debug('Realtime connection lost', { clientId })
            close()
            scheduleReconnect()
        }
        target.addEventListener('PB_CONNECT', (ev: Event) => {
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
            attempts = 0
            if (!resumed) {
                lastSeq = undefined
                lastSent = []
            } else {
                lastSent = topics()
            }
            attachAll(target)
            void submit()
            if (everConnected) deps.onReconnect?.(resumed)
            everConnected = true
        })
    }

    return {
        subscribe(topic, listener) {
            if (topic.length > REALTIME_TOPIC_MAX_LENGTH) {
                return Promise.reject(new RealtimeTopicTooLongError(topic.length))
            }
            let set = listeners.get(topic)
            const isNew = set === undefined
            if (!set) {
                set = new Set()
                listeners.set(topic, set)
            }
            set.add(listener)
            if (isNew && source && connected) source.addEventListener(topic, dispatcherFor(topic))
            if (!source) connect()
            const ready = isNew || !connected ? submit() : Promise.resolve()
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
            return ready.then(() => unsubscribe)
        },
        topics,
        isConnected: () => connected,
        clientId: () => clientId,
        disconnect() {
            close()
            clientId = undefined
            lastSeq = undefined
        },
    }
}
