import { createCollection, createLiveQueryCollection, type LoadSubsetOptions } from '@tanstack/db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'

/**
 * pbtsdb's per-query expand rests on two behaviours TanStack DB does not
 * document. This test reproduces the mechanism with plain TanStack pieces so an
 * upgrade that changes either fails here, with a message naming the assumption.
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
})
