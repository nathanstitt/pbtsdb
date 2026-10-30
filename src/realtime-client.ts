import { logger } from './logger'
import { REALTIME_TOPIC_MAX_LENGTH } from './pocketbase-limits'
import type { RealtimeStatus } from './sync-status'

export interface RealtimeEvent {
    action: string
    record: unknown
    /** Per-client sequence, sent by a server with resume support. */
    seq?: number
}

export type RealtimeListener = (event: RealtimeEvent) => void

/** The fields of an SSE event that pbtsdb reads. */
export type EventSourceMessage = { data?: unknown; lastEventId?: string | null }

export type EventSourceListener = (event: EventSourceMessage) => void

/**
 * What the client needs from an EventSource: the global one, or any
 * implementation an app supplies. It must:
 * - dispatch each SSE event to the listeners added for its `event` name,
 *   with `data` and `lastEventId` set;
 * - dispatch `error` through `addEventListener` (pbtsdb does not read
 *   `onerror`) when the stream ends for any reason, including a clean
 *   close by the server;
 * - not reconnect itself: pbtsdb calls `close()` on the first `error`, and
 *   opens a new connection through the factory.
 */
export type EventSourceLike = {
    addEventListener(type: string, listener: EventSourceListener): void
    removeEventListener(type: string, listener: EventSourceListener): void
    close(): void
}

/** Opens the SSE connection to `url`; called again on each connect. */
export type RealtimeEventSourceFactory = (url: string) => EventSourceLike

/**
 * Returns the delay in milliseconds before the next reconnect. `attempt`
 * is 0 for the first retry after the connection drops and grows by one
 * for each retry that fails; it returns to 0 once a connection succeeds.
 */
export type RealtimeBackoff = (attempt: number) => number

export interface RealtimeClientDeps {
    /** Absolute URL of `/api/realtime`; read each time a connection opens. */
    readonly url: string
    /** `POST /api/realtime` with the SDK's auth; rejects on a non-2xx response. */
    send: (body: { clientId: string; subscriptions: string[] }) => Promise<unknown>
    /** Read each time a connection opens; the global `EventSource` when unset. */
    readonly eventSource?: RealtimeEventSourceFactory
    /** After a reconnect. `resumed` is true when the server replayed the gap. */
    onReconnect?: (resumed: boolean) => void
    /** After any transition `status()` may report; may fire with no change. */
    onStatusChange?: () => void
    /** Read each time a reconnect is scheduled; {@link defaultRealtimeBackoff} when unset. */
    readonly backoff?: RealtimeBackoff
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

/** Rejects a pending `subscribe` whose `signal` aborted. */
export class RealtimeSubscribeAbortedError extends Error {
    constructor() {
        super('Realtime subscription was aborted before it was confirmed')
        this.name = 'RealtimeSubscribeAbortedError'
    }
}

/**
 * One SSE connection to PocketBase with its topic list. Topic changes made
 * in one tick go out in one POST; `subscribe` resolves once the server has
 * the topic (see docs/internals.md, "Realtime client").
 */
export interface RealtimeClient {
    /**
     * Resolves once a POST carrying the topic succeeds. A POST that fails
     * in a way a new connection can clear (see `isTransientPostError`) keeps
     * it pending until the reconnect's POST; another 4xx rejects it. Aborting `signal` while pending drops the
     * registration and rejects with `RealtimeSubscribeAbortedError`.
     */
    subscribe: (
        topic: string,
        listener: RealtimeListener,
        options?: { signal?: AbortSignal }
    ) => Promise<() => Promise<void>>
    topics: () => string[]
    isConnected: () => boolean
    status: () => RealtimeStatus
    clientId: () => string | undefined
    disconnect: () => void
    /**
     * Closes the connection, forgets the server-side session and keeps the
     * client closed: no connect happens until `enable()`. Registrations and
     * listeners are kept, so `enable()` resumes every topic.
     */
    disable: () => void
    /** Lifts `disable()` and connects at once if any topic is registered. */
    enable: () => void
    /** False while `disable()` is in effect. */
    isEnabled: () => boolean
    /**
     * Forgets the server-side session (client id, confirmed topics) and
     * reconnects at once if any topic is registered, posting the full list
     * under whatever auth the caller's `send` carries now. Call this after
     * an auth change (login, logout, user switch) the shared connection
     * cannot otherwise see, so the server does not keep serving the old
     * user's subscriptions. Registrations and listeners are kept; pending
     * `subscribe` calls settle once the new connection's POST completes.
     * While `disable()` is in effect the session is forgotten but no
     * connection opens.
     */
    reset: () => void
    /**
     * Runs a scheduled reconnect at once and restarts the backoff, keeping
     * the client id and last `seq` so the server can resume. A no-op unless
     * a retry is waiting.
     */
    retryNow: () => void
    /** @internal Simulates the live connection dropping, the way `onerror` would; tests use it. */
    simulateDisconnect: () => void
}

export const REALTIME_BACKOFF_MAX_MS = 30_000

/**
 * Doubles from 250 ms up to {@link REALTIME_BACKOFF_MAX_MS}. Each delay
 * is between half and all of that value, picked at random, so clients that
 * lost the server together do not retry together.
 */
export const defaultRealtimeBackoff: RealtimeBackoff = attempt => {
    const ceiling = Math.min(REALTIME_BACKOFF_MAX_MS, 250 * 2 ** attempt)
    return ceiling / 2 + Math.random() * (ceiling / 2)
}

/** `removal` marks a POST that only drops topics: its caller needs no confirmation. */
type Waiter = { resolve: () => void; reject: (error: unknown) => void; removal: boolean }

// Statuses a new connection can clear: PocketBase answers 404 for a client
// id it no longer holds (a forced or idle close, a restart) and 403 when the
// request's auth differs from the connection's; 408 and 429 pass on a later
// try. No response (status 0) and a server error may pass too. Any other
// 4xx is the server's answer to this topic list and would fail again, so it
// must not start a reconnect loop.
const TRANSIENT_POST_STATUSES = new Set([0, 403, 404, 408, 429])

// The server's client for this id is gone (404) or holds another auth
// (403); resuming it would fail the same way.
const SESSION_LOST_STATUSES = new Set([403, 404])

function postStatus(error: unknown): number | undefined {
    const status = (error as { status?: unknown } | null)?.status
    return typeof status === 'number' ? status : undefined
}

function isTransientPostError(error: unknown): boolean {
    const status = postStatus(error)
    return status !== undefined && (status >= 500 || TRANSIENT_POST_STATUSES.has(status))
}

export function createRealtimeClient(deps: RealtimeClientDeps): RealtimeClient {
    const listeners = new Map<string, Set<RealtimeListener>>()
    const dispatchers = new Map<string, EventSourceListener>()
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
    /** When the current reconnect episode began; cleared once a connection's POST succeeds. */
    let lostAt: number | undefined
    let nextRetryAt = 0
    let everConnected = false
    /**
     * Set when a POST fails with an unknown outcome: the topics the server
     * held throughout, whether it applied the failed lists or not. A resumed
     * reconnect replays only these.
     */
    let heldSinceFailure: string[] | undefined
    /** Bumped on every accepted `PB_CONNECT`; a POST sent on an earlier connection is stale. */
    let connection = 0
    /** Bumped by `reset()` and every full teardown; a POST that outlives its session is stale. */
    let session = 0
    let disabled = false

    function topics(): string[] {
        return [...listeners.keys()]
    }

    function status(): RealtimeStatus {
        if (disabled || (!source && reconnectTimer === undefined)) return { state: 'disabled' }
        if (connected) return { state: 'connected' }
        if (lostAt !== undefined) {
            return { state: 'reconnecting', attempt: attempts, nextRetryAt, since: lostAt }
        }
        return { state: 'connecting' }
    }

    function statusChanged(): void {
        deps.onStatusChange?.()
    }

    function dispatcherFor(topic: string): EventSourceListener {
        let dispatch = dispatchers.get(topic)
        if (!dispatch) {
            dispatch = message => {
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

    async function sendTopics(list: string[]): Promise<void> {
        if (list.length === 0) {
            close(true)
            clientId = undefined
            lastSeq = undefined
            statusChanged()
            return
        }
        if (sameList(list, confirmed)) return
        const id = clientId
        if (!id) return
        await deps.send({ clientId: id, subscriptions: list })
        if (clientId === id) confirmed = list
    }

    /** Removal waiters settle at once; the rest go back to the front of the queue. */
    function requeue(pending: Waiter[]): void {
        settleWaiters(pending.filter(waiter => waiter.removal))
        waiters = [...pending.filter(waiter => !waiter.removal), ...waiters]
    }

    /**
     * A POST outlived its connection (a reconnect, a `reset()` or a full
     * teardown ran while it was in flight): its waiters never got the topic
     * on the current connection, so they go back to the queue for the next
     * `runSubmit` pass instead of settling now.
     */
    function requeueStale(pending: Waiter[]): void {
        if (disabled) {
            settleWaiters(pending)
            return
        }
        requeue(pending)
        resubmit = true
    }

    /** Nothing is wanted while disconnected: settles whatever is queued, since no POST can ever carry it. */
    function settleWhileDisconnected(): void {
        if (listeners.size > 0) return
        const pending = waiters
        waiters = []
        close(true)
        clientId = undefined
        lastSeq = undefined
        statusChanged()
        settleWaiters(pending)
    }

    // The server may or may not have applied `list`, so nothing counts as
    // confirmed and the next POST always goes out.
    function outcomeUnknown(list: string[]): void {
        heldSinceFailure = (heldSinceFailure ?? confirmed).filter(topic => list.includes(topic))
        confirmed = []
    }

    /**
     * A POST failed in a way a new connection can clear. Its subscriptions
     * stay registered and pending, and the stream is replaced: it can stay
     * open while the POST fails, and then nothing else reconnects. The
     * reconnect's POST carries every registered topic and settles the
     * waiters. After a 403 or 404 the reconnect does not resume, because the
     * server's client for the old id is gone or holds another auth.
     */
    function keepThroughFailedPost(pending: Waiter[], error: unknown): void {
        logger.warn('Realtime subscriptions POST failed; reconnecting', { error })
        requeue(pending)
        const status = postStatus(error)
        if (status !== undefined && SESSION_LOST_STATUSES.has(status)) {
            clientId = undefined
            lastSeq = undefined
        }
        if (!source) return
        close(false)
        scheduleReconnect()
        statusChanged()
    }

    // A POST is stale when its session ended or a newer connection took
    // over. A resumed connection keeps the client id, so only the connection
    // count tells its POSTs from those of the connection it replaced.
    async function postTopics(pending: Waiter[], startedSession: number): Promise<void> {
        const list = topics()
        const startedId = clientId
        const startedConnection = connection
        const isStale = () => session !== startedSession || connection !== startedConnection
        try {
            await sendTopics(list)
            if (isStale()) requeueStale(pending)
            else settleWaiters(pending)
        } catch (error) {
            const transient = isTransientPostError(error)
            if (transient && session === startedSession && clientId === startedId) {
                outcomeUnknown(list)
            }
            if (isStale()) {
                requeueStale(pending)
            } else if (transient) {
                keepThroughFailedPost(pending, error)
            } else {
                logger.error('Failed to set realtime subscriptions', { error })
                settleWaiters(pending, error)
            }
        }
    }

    async function runSubmit(): Promise<void> {
        if (submitting) {
            resubmit = true
            return
        }
        if (!connected || !clientId) {
            settleWhileDisconnected()
            return
        }
        submitting = true
        const pending = waiters
        waiters = []
        try {
            await postTopics(pending, session)
        } finally {
            submitting = false
            if (resubmit) {
                resubmit = false
                void runSubmit()
            }
        }
    }

    function submit(removal = false): Promise<void> {
        const done = new Promise<void>((resolve, reject) => {
            waiters.push({ resolve, reject, removal })
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
     * first connect again, not a reconnect. `session` bumps too, so a POST
     * still in flight from before this teardown cannot settle against it.
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
            lostAt = undefined
            session += 1
        }
    }

    // Forgets the server-side session and connects again under the current
    // auth, unless disabled. `everConnected` is kept: the connection after a
    // reset or a re-enable is a reconnect, so every ready collection reloads.
    function forgetSession(): void {
        if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
        reconnectTimer = undefined
        source?.close()
        source = undefined
        connected = false
        confirmed = []
        clientId = undefined
        lastSeq = undefined
        attempts = 0
        lostAt = undefined
        session += 1
        if (listeners.size > 0) {
            try {
                connect()
            } catch (error) {
                logger.error('Failed to reconnect after reset', { error })
            }
        }
        statusChanged()
    }

    function scheduleReconnect(): void {
        const delay = (deps.backoff ?? defaultRealtimeBackoff)(attempts)
        attempts += 1
        lostAt ??= Date.now()
        nextRetryAt = Date.now() + delay
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
        statusChanged()
    }

    function connect(): void {
        if (source || disabled) return
        const previousId = clientId
        const openSource = deps.eventSource ?? ((url: string) => new EventSource(url))
        const target = openSource(connectUrl())
        source = target
        statusChanged()
        target.addEventListener('error', () => handleConnectionLost(target))
        target.addEventListener('PB_CONNECT', message => {
            if (source !== target) return
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
            connection += 1
            if (!resumed) {
                lastSeq = undefined
                confirmed = []
            }
            attachAll(target)
            // Set on connect, not after the POST: a reset() while the first
            // POST is in flight replaces `source`, and the connection it opens
            // must still count as a reconnect so the gap is reloaded.
            const isReconnect = everConnected
            everConnected = true
            statusChanged()
            submit().then(
                () => {
                    if (source !== target) return
                    attempts = 0
                    lostAt = undefined
                    const held = heldSinceFailure
                    heldSinceFailure = undefined
                    const lost =
                        held !== undefined && confirmed.some(topic => !held.includes(topic))
                    statusChanged()
                    if (isReconnect) deps.onReconnect?.(resumed && !lost)
                },
                () => {
                    if (source !== target || !isReconnect) return
                    close(false)
                    scheduleReconnect()
                    statusChanged()
                }
            )
        })
    }

    function addListener(topic: string, listener: RealtimeListener): void {
        let set = listeners.get(topic)
        const isNew = set === undefined
        if (!set) {
            set = new Set()
            listeners.set(topic, set)
        }
        set.add(listener)
        if (isNew && source && connected) source.addEventListener(topic, dispatcherFor(topic))
    }

    /** Returns true when `topic` has no listener left, so the server's list must change. */
    function removeListener(topic: string, listener: RealtimeListener): boolean {
        const current = listeners.get(topic)
        if (!current?.delete(listener) || current.size > 0) return false
        listeners.delete(topic)
        const dispatch = dispatchers.get(topic)
        if (dispatch) {
            source?.removeEventListener(topic, dispatch)
            dispatchers.delete(topic)
        }
        return true
    }

    // A subscribe can stay pending across reconnects; aborting it drops the
    // registration at once, so no later POST carries it.
    function awaitConfirmation(
        ready: Promise<void>,
        topic: string,
        listener: RealtimeListener,
        signal: AbortSignal | undefined
    ): Promise<() => Promise<void>> {
        const unsubscribe = async () => {
            if (removeListener(topic, listener)) await submit(true).catch(() => undefined)
        }
        return new Promise((resolve, reject) => {
            let settled = false
            const finish = () => {
                settled = true
                signal?.removeEventListener('abort', onAbort)
            }
            function onAbort() {
                if (settled) return
                finish()
                if (removeListener(topic, listener)) void submit(true).catch(() => undefined)
                reject(new RealtimeSubscribeAbortedError())
            }
            signal?.addEventListener('abort', onAbort)
            ready.then(
                () => {
                    if (settled) return
                    finish()
                    resolve(unsubscribe)
                },
                (error: unknown) => {
                    if (settled) return
                    finish()
                    removeListener(topic, listener)
                    reject(error)
                }
            )
        })
    }

    return {
        subscribe(topic, listener, options) {
            const signal = options?.signal
            if (signal?.aborted) return Promise.reject(new RealtimeSubscribeAbortedError())
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
            addListener(topic, listener)
            // While disabled nothing can confirm a topic; the registration
            // goes out with the first POST after enable(). Resolving now lets
            // the caller open and close entries, so idle cleanup still runs.
            const ready = disabled ? Promise.resolve() : submit()
            return awaitConfirmation(ready, topic, listener, signal)
        },
        topics,
        isConnected: () => connected,
        status,
        clientId: () => clientId,
        disconnect() {
            close(true)
            clientId = undefined
            lastSeq = undefined
            const pending = waiters
            waiters = []
            listeners.clear()
            dispatchers.clear()
            statusChanged()
            settleWaiters(pending, new RealtimeDisconnectedError())
        },
        simulateDisconnect() {
            if (source) handleConnectionLost(source)
        },
        reset: forgetSession,
        retryNow() {
            if (reconnectTimer === undefined) return
            clearTimeout(reconnectTimer)
            reconnectTimer = undefined
            attempts = 0
            if (listeners.size === 0) return
            try {
                connect()
            } catch (error) {
                logger.error('Failed to reconnect', { error })
            }
        },
        // Pending subscribes settle: their topics are registered and go out
        // with the first POST after enable(), the same as a subscribe made
        // while disabled.
        disable() {
            disabled = true
            forgetSession()
            const pending = waiters
            waiters = []
            settleWaiters(pending)
        },
        enable() {
            if (!disabled) return
            disabled = false
            if (listeners.size > 0) connect()
            statusChanged()
        },
        isEnabled: () => !disabled,
    }
}
