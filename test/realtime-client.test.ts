import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    createRealtimeClient,
    type EventSourceLike,
    RealtimeDisconnectedError,
    RealtimeTopicTooLongError,
} from '../src/realtime-client'

class FakeEventSource implements EventSourceLike {
    static instances: FakeEventSource[] = []
    onerror: ((ev: Event) => void) | null = null
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

    it('leaves subscribe pending until PB_CONNECT, not merely until queued', async () => {
        FakeEventSource.instances = []
        const sent: { clientId: string; subscriptions: string[] }[] = []
        const client = createRealtimeClient({
            url: 'http://pb.test/api/realtime',
            send: async body => {
                sent.push(body)
            },
            eventSource: url => new FakeEventSource(url),
            backoff: [0],
        })
        let settled = false
        const sub = client
            .subscribe('t1', () => undefined)
            .then(fn => {
                settled = true
                return fn
            })
        await flush()
        expect(settled).toBe(false)
        expect(sent).toHaveLength(0)
        const source = FakeEventSource.instances.at(-1)
        if (!source) throw new Error('no EventSource opened')
        source.emit('PB_CONNECT', { clientId: 'client-1' }, 'client-1')
        await sub
        expect(settled).toBe(true)
        expect(sent).toHaveLength(1)
    })

    it('keeps a subscribe made during an in-flight POST pending until the POST carrying it completes', async () => {
        FakeEventSource.instances = []
        const sent: { clientId: string; subscriptions: string[] }[] = []
        const gate: Array<() => void> = []
        const client = createRealtimeClient({
            url: 'http://pb.test/api/realtime',
            send: async body => {
                sent.push(body)
                await new Promise<void>(resolve => gate.push(resolve))
            },
            eventSource: url => new FakeEventSource(url),
            backoff: [0],
        })
        const first = client.subscribe('t1', () => undefined)
        await flush()
        const source = FakeEventSource.instances.at(-1)
        if (!source) throw new Error('no EventSource opened')
        source.emit('PB_CONNECT', { clientId: 'client-1' }, 'client-1')
        await flush()
        expect(sent).toHaveLength(1)

        let secondSettled = false
        const second = client
            .subscribe('t2', () => undefined)
            .then(fn => {
                secondSettled = true
                return fn
            })
        await flush()
        expect(secondSettled).toBe(false)
        expect(sent).toHaveLength(1)

        gate.shift()?.()
        await first
        await flush()
        expect(secondSettled).toBe(false)
        expect(sent).toHaveLength(2)
        expect(sent[1].subscriptions).toEqual(['t1', 't2'])

        gate.shift()?.()
        await second
        expect(secondSettled).toBe(true)
    })

    it('POSTs the full list on a resumed reconnect when a topic changed during the gap', async () => {
        vi.useFakeTimers()
        const { client, sent, connect } = setup({ resumed: true })
        const sub = client.subscribe('t1', () => undefined)
        await vi.advanceTimersByTimeAsync(0)
        const first = connect('client-1')
        await sub
        expect(sent).toHaveLength(1)
        first.fail()
        await vi.advanceTimersByTimeAsync(0)
        void client.subscribe('t2', () => undefined)
        const second = FakeEventSource.instances[1]
        second.emit('PB_CONNECT', { clientId: 'client-1', resumed: true }, 'client-1')
        await vi.advanceTimersByTimeAsync(0)
        expect(sent).toHaveLength(2)
        expect(sent[1]).toEqual({ clientId: 'client-1', subscriptions: ['t1', 't2'] })
    })

    it('removes a topic whose POST rejected so it cannot leak into a later send', async () => {
        FakeEventSource.instances = []
        let shouldFail = true
        const sent: { clientId: string; subscriptions: string[] }[] = []
        const client = createRealtimeClient({
            url: 'http://pb.test/api/realtime',
            send: async body => {
                if (shouldFail) {
                    shouldFail = false
                    throw new Error('boom')
                }
                sent.push(body)
            },
            eventSource: url => new FakeEventSource(url),
            backoff: [0],
        })
        const sub = client.subscribe('t1', () => undefined)
        await flush()
        const source = FakeEventSource.instances.at(-1)
        if (!source) throw new Error('no EventSource opened')
        source.emit('PB_CONNECT', { clientId: 'client-1' }, 'client-1')
        await expect(sub).rejects.toThrow('boom')
        expect(client.topics()).toEqual([])

        await client.subscribe('t2', () => undefined)
        expect(sent).toEqual([{ clientId: 'client-1', subscriptions: ['t2'] }])
    })

    it('rejects a pending subscribe on disconnect and leaves no registration behind', async () => {
        const { client } = setup()
        const sub = client.subscribe('t1', () => undefined)
        await flush()
        client.disconnect()
        await expect(sub).rejects.toBeInstanceOf(RealtimeDisconnectedError)
        expect(client.topics()).toEqual([])
    })

    it('keeps a second subscribe to an unconfirmed topic pending, and rejects both if the POST fails', async () => {
        FakeEventSource.instances = []
        const sent: { clientId: string; subscriptions: string[] }[] = []
        const gate: Array<() => void> = []
        const client = createRealtimeClient({
            url: 'http://pb.test/api/realtime',
            send: async body => {
                sent.push(body)
                await new Promise<void>((_resolve, reject) =>
                    gate.push(() => reject(new Error('boom')))
                )
            },
            eventSource: url => new FakeEventSource(url),
            backoff: [0],
        })
        const first = client.subscribe('t1', () => undefined)
        await flush()
        const source = FakeEventSource.instances.at(-1)
        if (!source) throw new Error('no EventSource opened')
        source.emit('PB_CONNECT', { clientId: 'client-1' }, 'client-1')
        await flush()
        expect(sent).toHaveLength(1)

        let secondSettled = false
        const second = client
            .subscribe('t1', () => undefined)
            .catch(error => {
                secondSettled = true
                throw error
            })
        await flush()
        expect(secondSettled).toBe(false)

        while (gate.length > 0) gate.shift()?.()
        await expect(first).rejects.toThrow('boom')
        await flush()
        while (gate.length > 0) gate.shift()?.()
        await expect(second).rejects.toThrow('boom')
        expect(client.topics()).toEqual([])
    })

    it('settles an unsubscribe made while disconnected instead of hanging forever', async () => {
        const { client, connect } = setup()
        const sub = client.subscribe('t1', () => undefined)
        await flush()
        const source = connect()
        const unsubscribe = await sub
        source.fail()
        await unsubscribe()
        expect(FakeEventSource.instances).toHaveLength(1)
        expect(client.isConnected()).toBe(false)
    })

    it('always re-POSTs on subscribe so a topic the server is about to drop is kept', async () => {
        FakeEventSource.instances = []
        const sent: { clientId: string; subscriptions: string[] }[] = []
        const gate: Array<() => void> = []
        const client = createRealtimeClient({
            url: 'http://pb.test/api/realtime',
            send: async body => {
                sent.push(body)
                await new Promise<void>(resolve => gate.push(resolve))
            },
            eventSource: url => new FakeEventSource(url),
            backoff: [0],
        })
        const a = client.subscribe('A', () => undefined)
        const b = client.subscribe('B', () => undefined)
        await flush()
        const source = FakeEventSource.instances.at(-1)
        if (!source) throw new Error('no EventSource opened')
        source.emit('PB_CONNECT', { clientId: 'client-1' }, 'client-1')
        await flush()
        gate.shift()?.()
        const unsubA = await a
        await b
        expect(sent).toHaveLength(1)

        // Unsubscribe A: its POST (without A) starts and is held open by the gate.
        void unsubA()
        await flush()
        expect(sent).toHaveLength(2)
        expect(sent[1].subscriptions).toEqual(['B'])

        // A is subscribed again while that POST is still in flight and `confirmed`
        // still lists A (from the very first POST) — it must not resolve at once.
        let resubscribed = false
        const resubA = client
            .subscribe('A', () => undefined)
            .then(fn => {
                resubscribed = true
                return fn
            })
        await flush()
        expect(resubscribed).toBe(false)

        gate.shift()?.()
        await flush()
        gate.shift()?.()
        await flush()
        expect(resubscribed).toBe(true)
        expect(sent).toHaveLength(3)
        expect(sent[2].subscriptions).toEqual(['B', 'A'])
        await resubA
    })

    it('fires onReconnect only after the re-POST following reconnect settles', async () => {
        vi.useFakeTimers()
        FakeEventSource.instances = []
        const order: string[] = []
        const gate: Array<() => void> = []
        const client = createRealtimeClient({
            url: 'http://pb.test/api/realtime',
            send: async body => {
                order.push(`send:${body.subscriptions.join(',')}`)
                await new Promise<void>(resolve => gate.push(resolve))
            },
            eventSource: url => new FakeEventSource(url),
            onReconnect: resumed => order.push(`reconnect:${resumed}`),
            backoff: [0],
        })
        const sub = client.subscribe('t1', () => undefined)
        await vi.advanceTimersByTimeAsync(0)
        const first = FakeEventSource.instances.at(-1)
        if (!first) throw new Error('no EventSource opened')
        first.emit('PB_CONNECT', { clientId: 'client-1' }, 'client-1')
        await vi.advanceTimersByTimeAsync(0)
        gate.shift()?.()
        await sub
        first.fail()
        await vi.advanceTimersByTimeAsync(0)
        const second = FakeEventSource.instances.at(-1)
        if (!second) throw new Error('no second EventSource opened')
        second.emit('PB_CONNECT', { clientId: 'client-2' }, 'client-2')
        await vi.advanceTimersByTimeAsync(0)
        expect(order.at(-1)).toBe('send:t1')
        gate.shift()?.()
        await vi.advanceTimersByTimeAsync(0)
        expect(order).toEqual(['send:t1', 'send:t1', 'reconnect:false'])
    })

    it('retries a re-POST that fails after reconnect instead of leaving the server with no topics', async () => {
        vi.useFakeTimers()
        FakeEventSource.instances = []
        let failNext = false
        const sent: { clientId: string; subscriptions: string[] }[] = []
        const client = createRealtimeClient({
            url: 'http://pb.test/api/realtime',
            send: async body => {
                if (failNext) {
                    failNext = false
                    throw new Error('boom')
                }
                sent.push(body)
            },
            eventSource: url => new FakeEventSource(url),
            backoff: [0],
        })
        const sub = client.subscribe('t1', () => undefined)
        await vi.advanceTimersByTimeAsync(0)
        const first = FakeEventSource.instances.at(-1)
        if (!first) throw new Error('no EventSource opened')
        first.emit('PB_CONNECT', { clientId: 'client-1' }, 'client-1')
        await sub
        expect(sent).toHaveLength(1)
        first.fail()
        await vi.advanceTimersByTimeAsync(0)
        const second = FakeEventSource.instances.at(-1)
        if (!second) throw new Error('no second EventSource opened')
        failNext = true
        second.emit('PB_CONNECT', { clientId: 'client-2' }, 'client-2')
        await vi.advanceTimersByTimeAsync(0)
        expect(FakeEventSource.instances).toHaveLength(3)
        const third = FakeEventSource.instances.at(-1)
        if (!third) throw new Error('no third EventSource opened')
        third.emit('PB_CONNECT', { clientId: 'client-3' }, 'client-3')
        await vi.advanceTimersByTimeAsync(0)
        expect(sent.at(-1)).toEqual({ clientId: 'client-3', subscriptions: ['t1'] })
        expect(client.topics()).toEqual(['t1'])
    })

    it('ignores a stray PB_CONNECT from a superseded EventSource', async () => {
        vi.useFakeTimers()
        const { client, sent, connect } = setup()
        const sub = client.subscribe('t1', () => undefined)
        await vi.advanceTimersByTimeAsync(0)
        const first = connect('client-1')
        await sub
        first.fail()
        await vi.advanceTimersByTimeAsync(0)
        const second = FakeEventSource.instances.at(-1)
        if (!second) throw new Error('no second EventSource opened')
        second.emit('PB_CONNECT', { clientId: 'client-2' }, 'client-2')
        await vi.advanceTimersByTimeAsync(0)
        expect(sent.at(-1)).toEqual({ clientId: 'client-2', subscriptions: ['t1'] })

        first.emit('PB_CONNECT', { clientId: 'client-stale' }, 'client-stale')
        await vi.advanceTimersByTimeAsync(0)
        expect(client.clientId()).toBe('client-2')
    })

    it('rejects without leaving a registration when connect() throws synchronously', async () => {
        const client = createRealtimeClient({
            url: 'http://pb.test/api/realtime',
            send: async () => undefined,
            eventSource: () => {
                throw new Error('no EventSource available')
            },
        })
        await expect(client.subscribe('t1', () => undefined)).rejects.toThrow(
            'no EventSource available'
        )
        expect(client.topics()).toEqual([])
    })

    it('clears the client id when the last topic is unsubscribed so the next subscribe starts fresh', async () => {
        const { client, connect } = setup()
        const sub = client.subscribe('t1', () => undefined)
        await flush()
        connect()
        const unsubscribe = await sub
        await unsubscribe()
        expect(client.clientId()).toBeUndefined()

        FakeEventSource.instances = []
        void client.subscribe('t2', () => undefined)
        await flush()
        const second = FakeEventSource.instances.at(-1)
        if (!second) throw new Error('no EventSource opened')
        expect(second.url).not.toContain('resume=')
    })
})
