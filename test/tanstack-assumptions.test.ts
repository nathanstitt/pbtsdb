import {
    createCollection,
    createLiveQueryCollection,
    type LoadSubsetOptions,
    type SyncConfig,
} from '@tanstack/db'
import { describe, expect, it } from 'vitest'

type Row = { id: string }

/**
 * pbtsdb's views (`fetchRelations`, `withRealtime`) are objects created from
 * the base collection with their own `subscribeChanges`. They work only
 * while TanStack DB's live query calls `subscribeChanges` on the object
 * passed to `from()` and hands that subscription to `loadSubset`. An upgrade
 * that changes either fails here, with a message naming the assumption.
 */
describe('TanStack DB assumptions behind views', () => {
    it('calls subscribeChanges on the object passed to from() and hands loadSubset that subscription', async () => {
        const seen: unknown[] = []
        let written = false
        const sync: SyncConfig<Row, string>['sync'] = ({ begin, write, commit, markReady }) => {
            markReady()
            return {
                loadSubset: (opts: LoadSubsetOptions) => {
                    seen.push(opts.subscription)
                    if (written) return true
                    written = true
                    begin()
                    write({ type: 'insert', value: { id: '1' } })
                    return commit()
                },
                cleanup: () => undefined,
            }
        }
        const base = createCollection<Row, string>({
            id: 'pin',
            getKey: item => item.id,
            syncMode: 'on-demand',
            sync: { sync },
        })

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
        try {
            await live.preload()
            expect(
                subscribeCalledOnView,
                'the live query no longer calls subscribeChanges on the object passed to from()'
            ).toBe(true)
            expect(
                seen.some(s => typeof s === 'object' && s !== null && tagged.has(s)),
                'loadSubset no longer receives the subscription returned by subscribeChanges'
            ).toBe(true)
            expect(live.toArray.map(item => item.id)).toEqual(['1'])
        } finally {
            await live.cleanup()
            await base.cleanup()
        }
    })
})
