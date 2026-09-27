import type { LoadSubsetOptions } from '@tanstack/db'
import { normalizePaths, type RelationTargets, validateExpandPath } from './expand-paths'
import type { LoadOptions } from './request'
import type { RealtimeMode } from './types'

/**
 * What a view adds to every subscription made through it: extra expand paths
 * and, when set, a realtime mode that overrides the collection default.
 */
export interface ViewTag {
    paths: string[]
    realtime: RealtimeMode | undefined
}

export interface ViewRegistry<Args extends unknown[], Sub extends object> {
    /** The tag for a load, from its subscription or the subscribe call on the stack. */
    tagFor: (opts: LoadSubsetOptions) => ViewTag | undefined
    /** Load options with the tagged view's expand paths. */
    withViewExpand: (opts: LoadSubsetOptions) => LoadOptions
    subscribeTagged: (tag: ViewTag | undefined, args: Args) => Sub
}

/**
 * Tags subscriptions with their view. A subscription's first loadSubset runs
 * inside subscribeChanges, before the subscription object exists to tag, so
 * while a view's subscribe call is on the stack its tag applies to untagged
 * load options.
 */
export function createViewRegistry<Args extends unknown[], Sub extends object>(
    subscribe: (...args: Args) => Sub
): ViewRegistry<Args, Sub> {
    const tags = new WeakMap<object, ViewTag>()
    let subscribing: ViewTag | undefined

    function tagFor(opts: LoadSubsetOptions): ViewTag | undefined {
        return (opts.subscription && tags.get(opts.subscription)) ?? subscribing
    }

    return {
        tagFor,
        withViewExpand(opts) {
            const paths = tagFor(opts)?.paths
            return paths ? { ...opts, expand: paths } : opts
        },
        subscribeTagged(tag, args) {
            subscribing = tag
            try {
                const subscription = subscribe(...args)
                if (tag) tags.set(subscription, tag)
                return subscription
            } finally {
                subscribing = undefined
            }
        },
    }
}

export interface ViewDeps<V extends object> {
    collectionName: string
    collection: V
    alwaysFetch: readonly string[]
    relationTargets: RelationTargets | undefined
    realtimeMode: RealtimeMode
    assertRealtimeMode: (mode: RealtimeMode) => void
    subscribeChangesFor: (tag: ViewTag) => unknown
}

export interface Views<V extends object> {
    fetchRelations: (...paths: string[]) => V
    withRealtime: (mode: RealtimeMode) => V
}

/**
 * Views share the collection's store and prototype; each is identified by its
 * normalized expand paths plus its realtime override. A mode equal to the
 * collection default is stored as `undefined`, so it never creates a view.
 */
export function createViews<V extends object>(deps: ViewDeps<V>): Views<V> {
    const { collectionName, collection, alwaysFetch, relationTargets, realtimeMode } = deps
    const views = new Map<string, V>()

    function createView(tag: ViewTag): V {
        const query: string[] = []
        if (tag.paths.length > 0) query.push(`expand=${tag.paths.join(',')}`)
        if (tag.realtime) query.push(`realtime=${tag.realtime}`)
        const view: V = Object.create(collection)
        Object.defineProperties(view, {
            id: { value: `${collectionName}?${query.join('&')}` },
            subscribeChanges: { value: deps.subscribeChangesFor(tag) },
            fetchRelations: {
                value: (...more: string[]) => viewFor([...tag.paths, ...more], tag.realtime),
            },
            withRealtime: {
                value: (mode: RealtimeMode) => {
                    deps.assertRealtimeMode(mode)
                    const override = mode === realtimeMode ? undefined : mode
                    if (tag.realtime !== undefined && tag.realtime !== override) {
                        throw new Error(
                            `A view of "${collectionName}" already uses realtime '${tag.realtime}'`
                        )
                    }
                    return viewFor(tag.paths, mode)
                },
            },
        })
        return view
    }

    function viewFor(paths: readonly string[], realtime: RealtimeMode | undefined): V {
        for (const path of paths) validateExpandPath(collectionName, relationTargets, path)
        const all = normalizePaths([...alwaysFetch, ...paths])
        const override = realtime === realtimeMode ? undefined : realtime
        if (override === undefined && all.every(path => alwaysFetch.includes(path))) {
            return collection
        }
        const key = `${all.join(',')}|${override ?? ''}`
        let view = views.get(key)
        if (!view) {
            view = createView({ paths: all, realtime: override })
            views.set(key, view)
        }
        return view
    }

    return {
        fetchRelations: (...paths) => viewFor(paths, undefined),
        withRealtime: mode => {
            deps.assertRealtimeMode(mode)
            return viewFor([], mode)
        },
    }
}
