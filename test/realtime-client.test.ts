import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    createRealtimeClient,
    type EventSourceLike,
    RealtimeTopicTooLongError,
} from '../src/realtime-client'

class FakeEventSource implements EventSourceLike {
    static instances: FakeEventSource[] = []
    onerror: ((ev: unknown) => void) | null = null
    closed = false
    private listeners = new Map<string, Set<(ev: MessageEvent) => void>>()

    constructor(readonly url: string) {
        FakeEventSource.instances.push(this)
    }

    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
        if (!listener || typeof listener !== 'function') return
        let set = this.listeners.get(type)
        if (!set) {
            set = new Set()
            this.listeners.set(type, set)
        }
        set.add(listener as (ev: MessageEvent) => void)
    }

    removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
        if (!listener || typeof listener !== 'function') return
        this.listeners.get(type)?.delete(listener as (ev: MessageEvent) => void)
    }

    close(): void {
        this.closed = true
    }

    emit(type: string, data: unknown, lastEventId = ''): void {
        const event = { data: JSON.stringify(data), lastEventId } as MessageEvent
        for (const listener of this.listeners.get(type) ?? []) listener(event)
    }

    fail(): void {
        this.onerror?.(new Event('error'))
    }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function setup(options: { resumed?: boolean } = {}) {
    FakeEventSource.instances = []
    const sent: { clientId: string; subscriptions: string[] }[] = []
    const reconnects: boolean[] = []
    const client = createRealtimeClient({
        url: 'http://pb.test/api/realtime',
        send: async body => {
            sent.push(body)
        },
        eventSource: url => new FakeEventSource(url),
        onReconnect: resumed => reconnects.push(resumed),
        backoff: [0],
    })
    const connect = (id = 'client-1') => {
        const source = FakeEventSource.instances.at(-1)
        if (!source) throw new Error('no EventSource opened')
        source.emit(
            'PB_CONNECT',
            { clientId: id, ...(options.resumed ? { resumed: true } : {}) },
            id
        )
        return source
    }
    return { client, sent, reconnects, connect }
}

afterEach(() => {
    vi.useRealTimers()
})

describe('realtime client', () => {
    it('opens one EventSource, waits for PB_CONNECT, and sends every pending topic in one POST', async () => {
        const { client, sent, connect } = setup()
        const a = client.subscribe('books/*?a', () => undefined)
        const b = client.subscribe('books/*?b', () => undefined)
        await flush()
        expect(FakeEventSource.instances).toHaveLength(1)
        expect(sent).toHaveLength(0)
        connect()
        await Promise.all([a, b])
        expect(sent).toEqual([{ clientId: 'client-1', subscriptions: ['books/*?a', 'books/*?b'] }])
        expect(client.isConnected()).toBe(true)
    })

    it('coalesces changes made in one tick and skips an unchanged list', async () => {
        const { client, sent, connect } = setup()
        const first = client.subscribe('t1', () => undefined)
        await flush()
        connect()
        const unsubscribe = await first
        const second = client.subscribe('t2', () => undefined)
        const third = client.subscribe('t3', () => undefined)
        await Promise.all([second, third])
        expect(sent).toHaveLength(2)
        expect(sent[1].subscriptions).toEqual(['t1', 't2', 't3'])
        await client.subscribe('t2', () => undefined)
        expect(sent).toHaveLength(2)
        await unsubscribe()
        expect(sent[2].subscriptions).toEqual(['t2', 't3'])
    })

    it('dispatches an event to every listener of its topic and tracks seq', async () => {
        const { client, connect } = setup()
        const seen: string[] = []
        const sub = client.subscribe('books/*', e => seen.push(`a:${e.action}`))
        const sub2 = client.subscribe('books/*', e => seen.push(`b:${e.action}`))
        await flush()
        const source = connect()
        await Promise.all([sub, sub2])
        source.emit('books/*', { action: 'create', record: { id: '1' }, seq: 7 })
        source.emit('authors/*', { action: 'create', record: { id: '2' }, seq: 8 })
        expect(seen).toEqual(['a:create', 'b:create'])
    })

    it('rejects a topic over the cap without sending it', async () => {
        const { client, sent } = setup()
        const topic = `books/*?options=${'x'.repeat(2500)}`
        await expect(client.subscribe(topic, () => undefined)).rejects.toBeInstanceOf(
            RealtimeTopicTooLongError
        )
        await flush()
        expect(sent).toHaveLength(0)
        expect(client.topics()).toEqual([])
    })

    it('reconnects after an error, re-sends the topics with the new id, and reports no resume', async () => {
        vi.useFakeTimers()
        const { client, sent, reconnects, connect } = setup()
        const sub = client.subscribe('t1', () => undefined)
        await vi.advanceTimersByTimeAsync(0)
        const first = connect('client-1')
        await sub
        first.fail()
        await vi.advanceTimersByTimeAsync(0)
        expect(first.closed).toBe(true)
        expect(FakeEventSource.instances).toHaveLength(2)
        const second = FakeEventSource.instances[1]
        expect(second.url).toContain('resume=client-1')
        second.emit('PB_CONNECT', { clientId: 'client-2' }, 'client-2')
        await vi.advanceTimersByTimeAsync(0)
        expect(sent.at(-1)).toEqual({ clientId: 'client-2', subscriptions: ['t1'] })
        expect(reconnects).toEqual([false])
    })

    it('sends the last seq on resume, and neither re-POSTs nor reports a reload when resumed', async () => {
        vi.useFakeTimers()
        const { client, sent, reconnects, connect } = setup({ resumed: true })
        const sub = client.subscribe('t1', () => undefined)
        await vi.advanceTimersByTimeAsync(0)
        const first = connect('client-1')
        await sub
        first.emit('t1', { action: 'update', record: { id: '1' }, seq: 41 })
        first.fail()
        await vi.advanceTimersByTimeAsync(0)
        const second = FakeEventSource.instances[1]
        expect(second.url).toContain('resume=client-1')
        expect(second.url).toContain('after=41')
        second.emit('PB_CONNECT', { clientId: 'client-1', resumed: true }, 'client-1')
        await vi.advanceTimersByTimeAsync(0)
        expect(sent).toHaveLength(1)
        expect(reconnects).toEqual([true])
    })

    it('closes the connection when the last topic is unsubscribed and never throws', async () => {
        const { client, connect } = setup()
        const sub = client.subscribe('t1', () => undefined)
        await flush()
        const source = connect()
        const unsubscribe = await sub
        await unsubscribe()
        await unsubscribe()
        expect(source.closed).toBe(true)
        expect(client.isConnected()).toBe(false)
    })
})
