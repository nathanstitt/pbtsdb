import {
    BTreeIndex,
    type Collection,
    createCollection as createTanStackCollection,
    type DeleteMutationFn,
    type InsertMutationFn,
    type UpdateMutationFn,
    type UtilsRecord,
    whenSyncAccepted,
} from '@tanstack/db'
import type PocketBase from 'pocketbase'
import type { RecordSubscribeOptions, RecordSubscription } from 'pocketbase'
import {
    createExpandFiler,
    stripFetchedRelations,
    targetsAlong,
    withoutExpand,
} from './expand-filing'
import {
    joinPaths,
    normalizePaths,
    type RelationTargets,
    splitPaths,
    validateExpandPath,
} from './expand-paths'
import { createFetcher } from './fetch-records'
import { createHeldTargets } from './held-targets'
import { ACCEPTED, createLedger } from './ledger'
import { createLoadedSubsets } from './loaded-subsets'
import { logger } from './logger'
import { createMembership } from './membership'
import { createRealtimeSubscription } from './realtime-subscription'
import { idOf } from './records'
import type { PbRequest } from './request'
import { createSyncAdapter, type SyncAdapterDeps } from './sync-adapter'
import { createSyncedStore } from './synced-store'
import { transportFor } from './transport'
import type {
    CreateCollectionOptions,
    ExtractRecordType,
    HeldTarget,
    RealtimeMode,
    SchemaDeclaration,
} from './types'
import { createViewRegistry, createViews, type ViewTag } from './views'

const REALTIME_MODES: readonly RealtimeMode[] = ['collection', 'query']

/**
 * Options applied to every collection built by a {@link createCollection} factory.
 */
export interface CreateCollectionFactoryOptions {
    /**
     * Extra options passed to every real-time subscription this factory creates,
     * such as `headers`, `filter`, `expand` or `fields`.
     *
     * Invoked on every subscribe attempt rather than read once: each filtered
     * entry of a `realtime: 'query'` collection and each restart (reconnect,
     * wider expand) calls it again, so a value captured at build time would go
     * stale.
     *
     * Returning `undefined` subscribes with no extra options.
     */
    subscribeOptions?: () => RecordSubscribeOptions | undefined
}

/**
 * pbtsdb's utilities on `collection.utils`. The same functions are also
 * assigned on the collection itself.
 */
export interface PbCollectionUtils<T extends object> extends UtilsRecord {
    /**
     * Land rows the server returned as confirmed state, for example a custom
     * endpoint's response. A row older than the stored one is ignored.
     * Resolves when the rows are accepted; they become visible with the
     * settlement of any persisting mutation, so a mutation handler can await it.
     * Throws on an eager collection that is idle: it does not start a full load.
     */
    accept: (rows: readonly T[]) => Promise<void>
    /**
     * Refetch every live query's subset (the whole collection in eager mode)
     * and release the realtime-topic and accepted holders of rows the results
     * do not confirm; rows a subset or a parent holds stay. Resolves when the
     * rows are accepted; they become visible with the settlement of any
     * persisting mutation.
     */
    reload: () => Promise<void>
    /**
     * Remove rows the server deleted, for example after a custom endpoint
     * deleted them. The rows leave every holder, and a fetch in flight does
     * not put them back. Resolves when the removal is accepted, so a custom
     * delete handler can await it. A no-op while the collection is not
     * syncing.
     */
    evict: (ids: readonly string[]) => Promise<void>
}

/**
 * Helpers added to collection instances.
 * @internal
 */
export interface CollectionSubscriptionHelpers<T extends object> {
    /** The PocketBase collection name */
    collectionName: string
    /** Wait for subscription to be established (useful in tests) */
    waitForSubscription: (timeout?: number) => Promise<void>
    /** Check if collection has an active subscription */
    isSubscribed: () => boolean
    /**
     * Relation targets declared through `relations`. Relation plumbing, not public API.
     * @internal
     */
    relationTargets: RelationTargets | undefined
    /**
     * Number of relation targets currently held live. Relation plumbing, not public API.
     * @internal
     */
    heldRelationTargetCount: () => number
    /**
     * Record that every row with `field === value` is now in this collection's store. Relation plumbing, not public API.
     * @internal
     */
    markSubsetLoaded: (field: string, value: string) => void
    /**
     * Number of field/value pairs currently marked loaded. Relation plumbing, not public API.
     * @internal
     */
    loadedSubsetCount: () => number
    /**
     * Hold this collection live as a relation target; see RelationTarget.holdLive. Relation plumbing, not public API.
     * @internal
     */
    holdLive: (holder: object) => HeldTarget
    /**
     * Receive rows a parent expanded into this collection; see RelationTarget.writeFiled. Relation plumbing, not public API.
     * @internal
     */
    writeFiled: (records: object[], holder: object) => Promise<boolean>
    /**
     * Release rows a parent stopped filing here; see RelationTarget.releaseFiled. Relation plumbing, not public API.
     * @internal
     */
    releaseFiled: (ids: readonly string[], holder: object) => void
    /**
     * A parent's fetch may file a subset here; see RelationTarget.expectFiling. Relation plumbing, not public API.
     * @internal
     */
    expectFiling: (field: string, settles: Promise<void>) => () => void
    /** See {@link PbCollectionUtils.accept}. */
    accept: PbCollectionUtils<T>['accept']
    /** See {@link PbCollectionUtils.reload}. */
    reload: PbCollectionUtils<T>['reload']
    /** See {@link PbCollectionUtils.evict}. */
    evict: PbCollectionUtils<T>['evict']
}

/**
 * Runtime shape of a built collection, before the public factory narrows it.
 * @internal
 */
export type BuiltCollection<T extends object> = Collection<
    T,
    string | number,
    PbCollectionUtils<T>,
    never,
    T
> &
    CollectionSubscriptionHelpers<T> & {
        fetchRelations: (...paths: string[]) => BuiltCollection<T>
        withRealtime: (mode: RealtimeMode) => BuiltCollection<T>
    }

/** @internal */
export interface BuildCollectionInput<
    Schema extends SchemaDeclaration,
    C extends keyof Schema & string,
> {
    pb: PocketBase
    factoryOptions: CreateCollectionFactoryOptions | undefined
    collectionName: C
    options: CreateCollectionOptions<Schema, C> | undefined
}

/** @internal */
export function buildCollection<Schema extends SchemaDeclaration, C extends keyof Schema & string>(
    input: BuildCollectionInput<Schema, C>
): BuiltCollection<ExtractRecordType<Schema, C>> {
    const { pb, factoryOptions, collectionName, options } = input
    type RecordType = ExtractRecordType<Schema, C>

    const relationTargets = options?.relations as RelationTargets | undefined
    for (const [key, target] of Object.entries(relationTargets ?? {})) {
        if (
            typeof target?.writeFiled !== 'function' ||
            typeof target.holdLive !== 'function' ||
            typeof target.expectFiling !== 'function'
        ) {
            throw new Error(
                `Collection '${collectionName}': relation '${key}' is not a pbtsdb collection`
            )
        }
    }
    const alwaysFetch = normalizePaths(options?.alwaysFetchRelations ?? [])
    for (const path of alwaysFetch) validateExpandPath(collectionName, relationTargets, path)
    const syncMode = options?.syncMode ?? 'eager'
    const realtimeMode: RealtimeMode = options?.realtime ?? 'collection'
    const refetchOnMutation = options?.refetchOnMutation ?? false

    function assertRealtimeMode(mode: RealtimeMode): void {
        if (!REALTIME_MODES.includes(mode)) {
            throw new Error(
                `Collection '${collectionName}': unknown realtime mode '${String(mode)}'`
            )
        }
        if (mode === 'query' && syncMode !== 'on-demand') {
            throw new Error(
                `Collection '${collectionName}': realtime 'query' requires syncMode 'on-demand'`
            )
        }
    }
    assertRealtimeMode(realtimeMode)

    // Paths requested by views that have subscribed at least once. Eager fetches
    // read it because they cannot receive per-subset options; the realtime
    // subscription reads it so echoes carry every relation in use.
    const requestedExpand = new Set<string>()

    const pendingSubscribeExpand = () => joinPaths([...alwaysFetch, ...requestedExpand])

    function activeExpand(request: PbRequest): string | undefined {
        return joinPaths([
            ...alwaysFetch,
            ...splitPaths(request.expand),
            ...(syncMode === 'eager' ? requestedExpand : []),
        ])
    }

    // The factory's own subscribeOptions() merged with the expand union.
    function realtimeSubscribeOptions(): RecordSubscribeOptions | undefined {
        const base = factoryOptions?.subscribeOptions?.()
        const expand = joinPaths([
            ...splitPaths(pendingSubscribeExpand()),
            ...splitPaths(base?.expand),
        ])
        return expand ? { ...base, expand } : base
    }

    // Every held target, every subset mark and, in on-demand mode, every
    // accepted row exists to serve rows realtime keeps fresh; with nothing
    // live and nothing wanted, release them all.
    function releaseAll(): void {
        held.releaseAll()
        subsets.clear()
        if (syncMode === 'on-demand') membership.drop([ACCEPTED])
    }

    // In eager mode the whole collection stays loaded after the last
    // subscriber leaves, until GC, so a topic's rows keep their holder until
    // reload() or cleanup. In on-demand mode they leave with the topic.
    function releaseTopic(topic: string): void {
        if (syncMode === 'eager') return
        if (membership.drop([topic]) === false) {
            logger.debug('Ignoring topic release while sync is not running', {
                collectionName,
                topic,
            })
        }
    }

    // This collection's identity as a parent: the holder its filed rows and
    // holds carry in every relation target.
    const parentHolder = { parent: collectionName }

    const ledger = createLedger<RecordType>()
    const store = createSyncedStore<RecordType>(collectionName)
    const subsets = createLoadedSubsets()
    const membership = createMembership<RecordType>({
        collectionName,
        ledger,
        store,
        onRemoved: rows => {
            for (const row of rows) {
                subsets.forgetRow(row)
                const id = idOf(row)
                if (id !== undefined) held.forgetParentRow(id)
            }
        },
    })
    const held = createHeldTargets(collectionName, parentHolder)
    const filer = createExpandFiler(collectionName, held.setFiled, parentHolder)
    const fetcher = createFetcher<RecordType>({
        pb,
        collectionName,
        relationTargets,
        activeExpand,
        syncedRow: ledger.row,
        syncedRows: ledger.rows,
        subsets,
        filer,
    })
    const transport = transportFor(pb)
    const realtime = createRealtimeSubscription<RecordType>({
        transport,
        collectionName,
        handleEvent: (event, topic, expand) => handleRealtimeEvent(event, topic, expand),
        pendingExpand: pendingSubscribeExpand,
        subscribeOptions: realtimeSubscribeOptions,
        onEntryOpened: () =>
            held.sync(targetsAlong(splitPaths(pendingSubscribeExpand()), relationTargets)),
        onEntryClosed: releaseTopic,
        onIdle: releaseAll,
    })
    const adapter = createSyncAdapter<RecordType>({
        collectionName,
        syncMode,
        realtimeMode,
        ledger,
        store,
        membership,
        fetcher,
        subsets,
        realtime,
        registry: (): ReturnType<SyncAdapterDeps<RecordType>['registry']> => registry,
        onCleanup: () => held.clearFiled(),
    })

    // `false` disables the mutation; `undefined` selects the built-in handler.
    function resolveHandler<H>(option: H | false | undefined, fallback: H): H | undefined {
        return option === false ? undefined : (option ?? fallback)
    }

    // A handler lands the server's rows before it returns: TanStack DB drops
    // the optimistic state when the handler settles, and rows written while
    // it runs publish together with that drop. The receipt is not awaited:
    // core holds this transaction until the handler's own transaction
    // settles, which is after the handler returns.
    function landServerRows(rows: RecordType[]): void {
        const result = membership.accept(rows)
        if (result === false) {
            logger.debug('Dropping write-back while sync is not running', { collectionName })
        }
    }

    // reload() resolves on acceptance, so awaiting it here cannot wait for
    // this handler's own transaction.
    async function settleHandler(): Promise<void> {
        if (refetchOnMutation) await adapter.reload()
    }

    const defaultInsert: InsertMutationFn<RecordType> = async ({ transaction }) => {
        const created = await Promise.all(
            transaction.mutations.map(async mutation => {
                const {
                    created: _created,
                    updated: _updated,
                    collectionId: _collectionId,
                    collectionName: _collectionName,
                    ...data
                } = mutation.modified as unknown as Record<string, unknown>
                return pb.collection(collectionName).create<RecordType>(data)
            })
        )
        landServerRows(created)
        await settleHandler()
    }

    const defaultUpdate: UpdateMutationFn<RecordType> = async ({ transaction }) => {
        const updated = await Promise.all(
            transaction.mutations.map(mutation =>
                pb
                    .collection(collectionName)
                    .update<RecordType>(mutation.original.id, mutation.changes)
            )
        )
        landServerRows(updated)
        await settleHandler()
    }

    // The server deleted `ids`: no fetch in flight may put them back, and
    // they leave every holder. Acceptance is at commit, so awaiting it from
    // inside a handler cannot wait for that handler's own transaction.
    async function evict(ids: readonly string[]): Promise<void> {
        for (const id of ids) adapter.noteDeleted(id)
        await whenAccepted(membership.dropAll(ids))
    }

    const defaultDelete: DeleteMutationFn<RecordType> = async ({ transaction }) => {
        const ids = await Promise.all(
            transaction.mutations.map(async mutation => {
                await pb.collection(collectionName).delete(mutation.original.id)
                return mutation.original.id
            })
        )
        await evict(ids)
        await settleHandler()
    }

    // TanStack DB 0.6 turned auto-indexing off by default; without an index an
    // orderBy+limit query loads the whole subset instead of paging lazily and
    // warns on every compile. Restore the earlier default; callers can override
    // both settings through collectionOptions, and `gcTime` reaches core
    // through the same spread. rowUpdateMode 'full' makes core store the
    // object the ledger writes, so the ledger row and the stored row match.
    const collection = createTanStackCollection<
        RecordType,
        string | number,
        PbCollectionUtils<RecordType>
    >({
        autoIndex: 'eager',
        defaultIndexType: BTreeIndex,
        ...options?.collectionOptions,
        id: collectionName,
        syncMode,
        getKey: (item: RecordType) => {
            const id = idOf(item)
            if (id === undefined) {
                throw new Error(
                    `Record in collection '${collectionName}' is missing required 'id' field. Received: ${JSON.stringify(item)}`
                )
            }
            return id
        },
        sync: { sync: adapter.sync, rowUpdateMode: 'full' },
        onInsert: resolveHandler(options?.onInsert, defaultInsert),
        onUpdate: resolveHandler(options?.onUpdate, defaultUpdate),
        onDelete: resolveHandler(options?.onDelete, defaultDelete),
        utils: { accept, reload: adapter.reload, evict },
    })

    // A reconnect the server did not resume lost every event of the gap.
    // Reload what is live; a resumed connection replayed it already.
    // Registered only while the collection is syncing: it is removed on
    // `cleaned-up` so a long-lived `pb` does not accumulate one listener per
    // `buildCollection` call. A restart after cleanup registers again.
    // Cleanup also clears marks a parent set before sync ever started; the
    // adapter's own cleanup runs only for a started sync.
    let removeReconnectListener: (() => void) | undefined
    collection.on('status:change', event => {
        if (event.status === 'cleaned-up') subsets.clear()
        if (!removeReconnectListener && (event.status === 'loading' || event.status === 'ready')) {
            removeReconnectListener = transport.onReconnect(resumed => {
                if (resumed || !realtime.isOpen() || !collection.isReady()) return
                void adapter.reload().catch(error =>
                    logger.error('Failed to reload after realtime reconnect', {
                        collectionName,
                        error,
                    })
                )
            })
        } else if (removeReconnectListener && event.status === 'cleaned-up') {
            removeReconnectListener()
            removeReconnectListener = undefined
        }
    })

    // Captured before the base collection's own subscribeChanges is replaced
    // below, so views and the base both reach TanStack's original.
    const originalSubscribeChanges = collection.subscribeChanges.bind(collection)
    type ChangesSubscription = ReturnType<typeof originalSubscribeChanges>
    const registry = createViewRegistry(originalSubscribeChanges)

    // Subscribe while counting toward the '*' entry; the count drops once,
    // on the first unsubscribe.
    function subscribeCounted(subscribe: () => ChangesSubscription): ChangesSubscription {
        realtime.addCollectionSubscriber()
        let subscription: ChangesSubscription
        try {
            subscription = subscribe()
        } catch (error) {
            realtime.dropCollectionSubscriber()
            throw error
        }
        const unsubscribe = subscription.unsubscribe.bind(subscription)
        let released = false
        subscription.unsubscribe = () => {
            if (!released) {
                released = true
                realtime.dropCollectionSubscriber()
                realtime.reconcile()
            }
            unsubscribe()
        }
        return subscription
    }

    function subscribeChangesFor(tag: ViewTag | undefined) {
        return (...args: Parameters<typeof originalSubscribeChanges>) => {
            if (tag) noteViewSubscribed(tag.paths)
            const subscription =
                (tag?.realtime ?? realtimeMode) === 'collection'
                    ? subscribeCounted(() => registry.subscribeTagged(tag, args))
                    : registry.subscribeTagged(tag, args)
            realtime.reconcile()
            return subscription
        }
    }

    Object.defineProperty(collection, 'subscribeChanges', {
        value: subscribeChangesFor(undefined),
    })

    const views = createViews({
        collectionName,
        collection,
        alwaysFetch,
        relationTargets,
        realtimeMode,
        assertRealtimeMode,
        subscribeChangesFor,
    })

    // PocketBase can redeliver or reorder echoes; the ledger drops a strictly
    // older create/update. A delete on a filter topic releases that topic,
    // its subsets, the parents whose hold covers it and the accepted
    // holder; a delete on '*' removes the row. A delete is also recorded
    // against every fetch in flight, whose result may predate it.
    function handleRealtimeEvent(
        event: RecordSubscription<RecordType>,
        topic: string,
        expand: string | undefined
    ): void {
        const id = idOf(event.record)
        if (!id) return
        if (event.action === 'delete') {
            adapter.noteDeleted(id)
            const applied =
                topic === '*'
                    ? membership.dropAll([id])
                    : membership.drop(
                          [
                              topic,
                              ...adapter.subsetsFor(topic),
                              ...(holdersByFilter.get(topic) ?? []),
                              ACCEPTED,
                          ],
                          [id]
                      )
            if (applied === false) {
                logger.debug('Ignoring delete echo while sync is not running', {
                    collectionName,
                    id,
                })
            }
            return
        }
        const [stored] = stripFetchedRelations([event.record], pendingSubscribeExpand())
        const applied = membership.land(topic, [stored])
        if (applied === false) {
            logger.debug('Ignoring realtime echo while sync is not running', { collectionName, id })
            return
        }
        membership.drop([ACCEPTED], [id])
        filer.upsertExpanded([event.record], relationTargets, splitPaths(expand)).catch(error =>
            logger.error('Failed to upsert expanded records from realtime echo', {
                collectionName,
                error,
            })
        )
    }

    // preload() on an on-demand collection logs a warning; startSyncImmediate()
    // does not. On-demand marks ready synchronously, so the wait ends at once.
    async function ensureSyncing(): Promise<boolean> {
        if (collection.isReady()) return true
        if (collection.status === 'error') return false
        const idle = collection.status === 'idle' || collection.status === 'cleaned-up'
        if (syncMode === 'eager') {
            // Filing must not start a full eager load; a load already
            // running (a hold started it) is worth waiting for.
            if (idle) return false
            await collection.preload()
            return true
        }
        if (idle) collection.startSyncImmediate()
        if (!collection.isReady()) {
            await new Promise<void>(resolve => {
                collection.onFirstReady(resolve)
            })
        }
        return true
    }

    // Receives rows a parent expanded through a relation to this collection.
    // Returns whether the write happened: a caller marks a subset complete
    // only after a real filing.
    async function writeFiled(records: object[], holder: object): Promise<boolean> {
        if (!(await ensureSyncing())) {
            logger.warn(
                `not syncing filed rows into ${collectionName} because store is not yet ready`
            )
            return false
        }
        return membership.land(holder, withoutExpand(records) as RecordType[]) !== false
    }

    // Awaits acceptance, not visibility: a custom mutation handler that calls
    // accept() or evict() would otherwise wait for its own transaction.
    async function whenAccepted(applied: ReturnType<typeof membership.land>): Promise<void> {
        if (applied === true || applied === false) return
        const accepted = whenSyncAccepted(applied)
        if (accepted !== true) await accepted
    }

    async function accept(rows: readonly RecordType[]): Promise<void> {
        if (!(await ensureSyncing())) {
            throw new Error(`Collection '${collectionName}' is not syncing; accept() has no store`)
        }
        await whenAccepted(membership.accept(rows))
    }

    // Parents whose hold covers each realtime filter, so a delete on that
    // topic releases their filings of the row.
    const holdersByFilter = new Map<string, Set<object>>()

    function swapHolderFilters(holder: object, previous: string[], next: string[]): void {
        for (const filter of previous) {
            const holders = holdersByFilter.get(filter)
            holders?.delete(holder)
            if (holders?.size === 0) holdersByFilter.delete(filter)
        }
        for (const filter of next) {
            let holders = holdersByFilter.get(filter)
            if (!holders) {
                holders = new Set()
                holdersByFilter.set(filter, holders)
            }
            holders.add(holder)
        }
        realtime.swapHoldFilters(previous, next)
    }

    // A parent's hold on this collection as a relation target. Keeps sync
    // alive and GC blocked like any subscriber. In collection mode the hold
    // counts toward '*'; in query mode it is uncounted and the parent
    // supplies the filters covering the rows it filed here. Releasing it
    // releases every row the parent filed under `holder`.
    function holdLive(holder: object): HeldTarget {
        const subscribe = () => originalSubscribeChanges(() => {}, { includeInitialState: false })
        const subscription =
            realtimeMode === 'collection' ? subscribeCounted(subscribe) : subscribe()
        let current: string[] = []
        let released = false
        realtime.reconcile()
        return {
            setFilters: filters => {
                if (released) return
                const next = [...new Set(filters)]
                swapHolderFilters(holder, current, next)
                current = next
            },
            release: () => {
                if (released) return
                released = true
                swapHolderFilters(holder, current, [])
                current = []
                membership.drop([holder])
                subscription.unsubscribe()
            },
        }
    }

    // A parent row stopped filing these rows here (its expand no longer
    // returns them, or it left the parent's store).
    function releaseFiled(ids: readonly string[], holder: object): void {
        if (membership.drop([holder], ids) === false) {
            logger.debug('Ignoring filed-row release while sync is not running', {
                collectionName,
            })
        }
    }

    // Record which expand paths a view has subscribed with at least once.
    // Eager collections cannot request per-subset options, so a wider union
    // needs a reload; a live realtime subscription needs a restart.
    function noteViewSubscribed(paths: string[]): void {
        let grew = false
        for (const path of paths) {
            if (requestedExpand.has(path)) continue
            requestedExpand.add(path)
            grew = true
        }
        if (!grew) return
        if (
            syncMode === 'eager' &&
            collection.status !== 'idle' &&
            collection.status !== 'cleaned-up'
        ) {
            void adapter.reload().catch(error =>
                logger.error('Failed to reload after widening expand', {
                    collectionName,
                    error,
                })
            )
        }
        realtime.restart()
    }

    Object.assign(collection, {
        collectionName,
        relationTargets,
        waitForSubscription: realtime.wait,
        isSubscribed: realtime.isOpen,
        heldRelationTargetCount: held.count,
        markSubsetLoaded: subsets.mark,
        loadedSubsetCount: subsets.count,
        holdLive,
        writeFiled,
        releaseFiled,
        expectFiling: fetcher.expectFiling,
        accept,
        reload: adapter.reload,
        evict,
        fetchRelations: views.fetchRelations,
        withRealtime: views.withRealtime,
    })

    return collection as unknown as BuiltCollection<RecordType>
}
