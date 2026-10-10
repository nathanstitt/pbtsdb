import PocketBase from 'pocketbase'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCollection } from '../src'
import {
    realtimeClientFor,
    reconnectRealtime,
    setRealtimeBackoff,
    setRealtimeEventSource,
} from '../src/transport'
import type { Schema } from './schema'

class IdleEventSource {
    static urls: string[] = []
    constructor(url: string) {
        IdleEventSource.urls.push(url)
    }
    addEventListener() {}
    removeEventListener() {}
    close() {}
}

describe('transport', () => {
    afterEach(() => {
        vi.useRealTimers()
        vi.unstubAllGlobals()
        IdleEventSource.urls = []
    })

    it('reads the realtime URL when connecting, not when the collection is created', () => {
        vi.stubGlobal('EventSource', IdleEventSource)
        const pb = new PocketBase('http://unresolved.test')
        let resolved = false
        const buildURL = vi.spyOn(pb, 'buildURL').mockImplementation(path => {
            if (!resolved) throw new Error('server address accessed before it was resolved')
            return `http://resolved.test${path}`
        })

        createCollection<Schema>(pb)('books', { syncMode: 'on-demand' })
        expect(buildURL).not.toHaveBeenCalled()

        resolved = true
        void realtimeClientFor(pb).subscribe('books', () => {})
        expect(IdleEventSource.urls).toEqual(['http://resolved.test/api/realtime'])
    })

    it('opens the connection with the factory from setRealtimeEventSource', () => {
        vi.stubGlobal('EventSource', IdleEventSource)
        const pb = new PocketBase('http://pb.test')
        const urls: string[] = []
        setRealtimeEventSource(pb, url => {
            urls.push(url)
            return new IdleEventSource(url)
        })

        void realtimeClientFor(pb).subscribe('books', () => {})
        expect(urls).toEqual(['http://pb.test/api/realtime'])
    })

    it('lets the factory send the token current at each connect', async () => {
        vi.useFakeTimers()
        const pb = new PocketBase('http://pb.test')
        const record = { id: 'user00000000000', collectionId: 'users', collectionName: 'users' }
        pb.authStore.save('token-1', record)
        const headers: Record<string, string>[] = []
        setRealtimeEventSource(pb, url => {
            headers.push(pb.authStore.token ? { Authorization: pb.authStore.token } : {})
            return new IdleEventSource(url)
        })

        const client = realtimeClientFor(pb)
        void client.subscribe('books', () => {})
        pb.authStore.save('token-2', record)
        client.simulateDisconnect()
        await vi.runOnlyPendingTimersAsync()
        expect(headers).toEqual([{ Authorization: 'token-1' }, { Authorization: 'token-2' }])
    })

    it('uses the global EventSource after the factory is cleared', () => {
        vi.stubGlobal('EventSource', IdleEventSource)
        const pb = new PocketBase('http://pb.test')
        const factory = vi.fn((url: string) => new IdleEventSource(url))
        setRealtimeEventSource(pb, factory)
        setRealtimeEventSource(pb, undefined)

        void realtimeClientFor(pb).subscribe('books', () => {})
        expect(factory).not.toHaveBeenCalled()
        expect(IdleEventSource.urls).toEqual(['http://pb.test/api/realtime'])
    })

    it('waits the delay from setRealtimeBackoff, and reconnectRealtime skips it', async () => {
        vi.useFakeTimers()
        vi.stubGlobal('EventSource', IdleEventSource)
        const pb = new PocketBase('http://pb.test')
        const attempts: number[] = []
        setRealtimeBackoff(pb, attempt => {
            attempts.push(attempt)
            return 60_000
        })

        const client = realtimeClientFor(pb)
        void client.subscribe('books', () => {})
        client.simulateDisconnect()
        expect(attempts).toEqual([0])
        await vi.advanceTimersByTimeAsync(59_999)
        expect(IdleEventSource.urls).toHaveLength(1)

        reconnectRealtime(pb)
        expect(IdleEventSource.urls).toHaveLength(2)
    })

    it('reconnectRealtime is a no-op for a client with no realtime connection', () => {
        expect(() => reconnectRealtime(new PocketBase('http://pb.test'))).not.toThrow()
    })
})
