import PocketBase from 'pocketbase'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCollection } from '../src'
import { realtimeClientFor } from '../src/transport'
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
})
