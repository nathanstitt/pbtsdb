import {
    createCollection,
    createLiveQueryCollection,
    type LoadSubsetOptions,
    type SyncConfig,
} from '@tanstack/db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

type Row = { id: string; name: string }
type SyncChannel = Pick<
    Parameters<SyncConfig<Row, string | number>['sync']>[0],
    'begin' | 'write' | 'commit'
>
type AcceptedState = {
    getAcceptedSyncedRow?: (key: string) => Row | undefined
    acceptedSyncedEntries?: () => Iterable<[string, Row]>
}

/**
 * pbtsdb rests on behaviours TanStack DB does not document: two behind
 * per-query expand, the accepted synced rows behind the write guard, and the
 * cache write behind the ownership claim. This test reproduces each mechanism
 * with plain TanStack pieces so an upgrade that changes one fails here, with
 * a message naming the assumption.
 */
describe('TanStack DB assumptions behind per-query expand', () => {
    it('calls subscribeChanges on the object passed to from(), and forwards extra load options to queryKey', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const seenKeyOptions: Record<string, unknown>[] = []
        const seenLoadSubscriptions: unknown[] = []

        const options = queryCollectionOptions<{ id: string }>({
            queryClient,
            queryKey: (opts: LoadSubsetOptions) => {
                seenKeyOptions.push(opts as Record<string, unknown>)
                return ['pin']
            },
            queryFn: async () => [{ id: '1' }],
            getKey: item => item.id,
            syncMode: 'on-demand',
        })
        const innerSync = options.sync.sync
        options.sync = {
            ...options.sync,
            sync: params => {
                const res = innerSync(params)
                if (!res || typeof res === 'function' || !res.loadSubset) return res
                const { loadSubset } = res
                return {
                    ...res,
                    loadSubset: (opts: LoadSubsetOptions) => {
                        seenLoadSubscriptions.push(opts.subscription)
                        return loadSubset({ ...opts, marker: 'from-view' } as LoadSubsetOptions)
                    },
                }
            },
        }
        const base = createCollection(options)

        let subscribeCalledOnView = false
        const tagged = new WeakSet<object>()
        const view = Object.create(base) as typeof base
        Object.defineProperties(view, {
            id: { value: 'pin?view' },
            subscribeChanges: {
                value: (...args: Parameters<typeof base.subscribeChanges>) => {
                    subscribeCalledOnView = true
                    const subscription = base.subscribeChanges(...args)
                    tagged.add(subscription)
                    return subscription
                },
            },
        })

        const live = createLiveQueryCollection({ query: q => q.from({ v: view }) })
        await live.preload()

        expect(
            subscribeCalledOnView,
            'Assumption 1 broke: the live query no longer calls subscribeChanges on the object passed to from()'
        ).toBe(true)
        expect(
            seenLoadSubscriptions.some(s => typeof s === 'object' && s !== null && tagged.has(s)),
            'Assumption 1 broke: loadSubset no longer receives the subscription returned by subscribeChanges'
        ).toBe(true)
        expect(
            seenKeyOptions.some(o => o.marker === 'from-view'),
            'Assumption 2 broke: an extra field on load options no longer reaches queryKey(opts)'
        ).toBe(true)
        expect(live.toArray.map(row => row.id)).toEqual(['1'])
    })

    it('keeps accepted sync rows apart from the optimistic overlay while a mutation persists', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        let settle: () => void = () => undefined
        let channel: SyncChannel | undefined
        const options = queryCollectionOptions<Row>({
            queryClient,
            queryKey: ['pin-synced'],
            queryFn: async () => [{ id: '1', name: 'server' }],
            getKey: item => item.id,
            onUpdate: () =>
                new Promise<{ refetch: false }>(resolve => {
                    settle = () => resolve({ refetch: false })
                }),
        })
        const innerSync = options.sync.sync
        options.sync = {
            ...options.sync,
            sync: params => {
                channel = params
                return innerSync(params)
            },
        }
        const collection = createCollection(options)
        await collection.preload()
        const tx = collection.update('1', draft => {
            draft.name = 'draft'
        })

        expect(collection.get('1')?.name).toBe('draft')
        expect(
            collection.get('1')?.$hasPendingWrites,
            'Assumption 3 broke: $hasPendingWrites no longer reports a pending optimistic mutation'
        ).toBe(true)

        // A sync transaction committed while the mutation persists is accepted
        // but held: base still shows the old row, the accepted row the new one.
        channel?.begin()
        channel?.write({ type: 'update', value: { id: '1', name: 'echo' } })
        channel?.commit()
        const state = (collection as unknown as { _state: AcceptedState })._state
        expect(collection.base.get('1')?.name).toBe('server')
        expect(
            state.getAcceptedSyncedRow?.('1')?.name,
            'Assumption 4 broke: collection._state.getAcceptedSyncedRow no longer returns a held sync row. pbtsdb reads it through acceptedRow in build-collection.ts; find the new accessor before touching anything else.'
        ).toBe('echo')
        expect(
            [...(state.acceptedSyncedEntries?.() ?? [])].map(([, row]) => row.name),
            'Assumption 4 broke: collection._state.acceptedSyncedEntries no longer lists held sync rows'
        ).toEqual(['echo'])

        settle()
        await tx.when('settled')
        expect(collection.get('1')?.name).toBe('echo')
        expect(collection.get('1')?.$hasPendingWrites).toBe(false)
    })

    it('applies a cache write to an observed on-demand query as a result, owning its rows', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const collection = createCollection(
            queryCollectionOptions<Row>({
                queryClient,
                queryKey: () => ['pin-claim'],
                queryFn: async () => [{ id: '1', name: 'server' }],
                getKey: item => item.id,
                syncMode: 'on-demand',
            })
        )
        const live = createLiveQueryCollection({ query: q => q.from({ r: collection }) })
        await live.preload()
        await vi.waitFor(() => expect(collection.has('1')).toBe(true))

        queryClient.setQueryData<Row[]>(['pin-claim'], data => [
            ...(data ?? []),
            { id: '2', name: 'claimed' },
        ])
        await vi.waitFor(() =>
            expect(
                collection.get('2')?.name,
                'Assumption 5 broke: query-db-collection no longer applies a cache write to an observed query. pbtsdb claims its own writes this way in synced-store.ts.'
            ).toBe('claimed')
        )

        // Owned: a result without the row prunes it.
        queryClient.setQueryData<Row[]>(['pin-claim'], [{ id: '1', name: 'server' }])
        await vi.waitFor(() =>
            expect(
                collection.has('2'),
                'Assumption 5 broke: a cache write no longer gives the query ownership of its rows'
            ).toBe(false)
        )
    })
})
