import {
    BasicIndex,
    createLiveQueryCollection,
    createCollection as createLocalCollection,
    eq,
    type SyncConfig,
} from '@tanstack/db'
import PocketBase from 'pocketbase'
import { describe, expect, it } from 'vitest'
import { createCollection, disconnectRealtime } from '../src'
import type { Books, Schema } from './schema'

// A lazy join replaces its segments
// when the parent keys churn; @tanstack/db 0.12 awaits the replaced loads
// together with the replacement and then aborts them when the replacement
// settles. An aborted load that rejected put the live query into the error
// state; it must resolve quietly instead.

type Held = { path: string; filter: string; release: (rows: Partial<Books>[]) => void }

// A PocketBase client whose list responses are released by hand, so the
// test decides which in-flight load settles first.
class HeldPocketBase extends PocketBase {
    held: Held[] = []

    constructor() {
        super('http://127.0.0.1:1')
        this.autoCancellation(false)
    }

    override send<T = unknown>(
        path: string,
        options: { query?: Record<string, unknown>; filter?: string }
    ): Promise<T> {
        // The SDK moves `filter` into `query` inside the real `send`.
        const filter = String(options.query?.filter ?? options.filter ?? '')
        return new Promise<T>(resolve => {
            this.held.push({
                path,
                filter,
                release: rows =>
                    resolve({
                        page: 1,
                        perPage: 1000,
                        totalItems: rows.length,
                        totalPages: 1,
                        items: rows,
                    } as T),
            })
        })
    }
}

type Author = { id: string }

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('a lazy join whose replaced segment load is aborted', () => {
    it('keeps the live query ready', async () => {
        const pb = new HeldPocketBase()
        disconnectRealtime(pb)
        // Indexed, as the app's collections are: without an index on the join
        // key core scans the whole collection instead of loading it by keys.
        const books = createCollection<Schema>(pb)('books', {
            syncMode: 'on-demand',
            collectionOptions: { autoIndex: 'eager', defaultIndexType: BasicIndex },
        })

        let sync!: Pick<Parameters<SyncConfig<Author>['sync']>[0], 'begin' | 'write' | 'commit'>
        const authors = createLocalCollection<Author>({
            id: 'authors-local',
            getKey: a => a.id,
            startSync: true,
            sync: {
                sync: ({ begin, write, commit, markReady }) => {
                    sync = { begin, write, commit }
                    markReady()
                },
            },
        })

        const live = createLiveQueryCollection({
            startSync: true,
            query: q =>
                q
                    .from({ a: authors })
                    .leftJoin({ b: books }, ({ a, b }) => eq(a.id, b.author))
                    .select(({ a, b }) => ({ id: a.id, book: b?.id })),
        })
        const transitions: string[] = []
        live.on('status:change', e => transitions.push(`${e.previousStatus}->${e.status}`))
        await tick()

        // One segment, O1, for the books of a1 and a2.
        sync.begin()
        sync.write({ type: 'insert', value: { id: 'a1' } })
        sync.write({ type: 'insert', value: { id: 'a2' } })
        sync.commit()
        await tick()
        expect(pb.held).toHaveLength(1)
        expect(pb.held[0].filter).toContain('a1')
        expect(pb.held[0].filter).toContain('a2')

        // Churn: a2 leaves, a3 arrives. Core starts a replacement, R, for
        // a1 and a3 that replaces O1, and awaits both.
        sync.begin()
        sync.write({ type: 'delete', value: { id: 'a2' } })
        sync.write({ type: 'insert', value: { id: 'a3' } })
        sync.commit()
        await tick()
        expect(pb.held).toHaveLength(2)
        expect(pb.held[1].filter).toContain('a3')

        // R settles first, so core aborts O1 while it is still in flight.
        pb.held[1].release([])
        await tick()
        await tick()
        pb.held[0].release([])
        await tick()
        await tick()

        expect(transitions).toEqual([])
        expect(live.status).toBe('ready')
        expect(live.toArray.map(r => r.id).sort()).toEqual(['a1', 'a3'])
    })
})
