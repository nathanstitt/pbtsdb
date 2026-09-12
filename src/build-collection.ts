import {
    type Collection,
    createCollection as createTanStackCollection,
    type LoadSubsetOptions,
} from '@tanstack/db'
import {
    DeleteOperationItemNotFoundError,
    type QueryCollectionUtils,
    queryCollectionOptions,
} from '@tanstack/query-db-collection'
import type { QueryClient } from '@tanstack/react-query'
import type PocketBase from 'pocketbase'
import type { RecordSubscribeOptions, RecordSubscription } from 'pocketbase'
import { mergeExpand } from './expand-merge'
import type { RelationTargets } from './expand-paths'
import { joinPaths, normalizePaths, splitPaths, validateExpandPath } from './expand-paths'
import { logger } from './logger'
import { convertToPocketBaseFilter, convertToPocketBaseSort } from './pocketbase-query-converter'
import type {
    CreateCollectionOptions,
    ExpandTargetCollection,
    ExtractRecordType,
    SchemaDeclaration,
} from './types'

// Subscriptions created through a view, mapped to the view's expand paths. Keyed
// by the subscription object TanStack hands back to loadSubset/unloadSubset.
const viewPaths = new WeakMap<object, string[]>()

/**
 * Options applied to every collection built by a {@link createCollection} factory.
 */
export interface CreateCollectionFactoryOptions {
    /**
     * Extra options passed to every real-time subscription this factory creates,
     * such as `headers`, `filter`, `expand` or `fields`.
     *
     * Invoked at subscribe time rather than read once, because a subscription is
     * re-established on reconnect and whenever the subscriber count rises from
     * zero — a value captured at build time would go stale exactly then.
     *
     * Returning `undefined` subscribes with no extra options.
     */
    subscribeOptions?: () => RecordSubscribeOptions | undefined
}

/**
 * Subscription helpers added to collection instances.
 * @internal
 */
export interface CollectionSubscriptionHelpers {
    /** The PocketBase collection name */
    collectionName: string
    /** Wait for subscription to be established (useful in tests) */
    waitForSubscription: (timeout?: number) => Promise<void>
    /** Check if collection has an active subscription */
    isSubscribed: () => boolean
    /** Relation targets declared through `relations` */
    relationTargets: RelationTargets | undefined
}

/**
 * Runtime shape of a built collection, before the public factory narrows it.
 * @internal
 */
export type BuiltCollection<T extends object> = Collection<
    T,
    string | number,
    QueryCollectionUtils<T, string | number, T>,
    never,
    T
> &
    CollectionSubscriptionHelpers

/** @internal */
export interface BuildCollectionInput<
    Schema extends SchemaDeclaration,
    C extends keyof Schema & string,
> {
    pb: PocketBase
    queryClient: QueryClient
    factoryOptions: CreateCollectionFactoryOptions | undefined
    collectionName: C
    options: CreateCollectionOptions<Schema, C> | undefined
}

/** @internal */
export function buildCollection<Schema extends SchemaDeclaration, C extends keyof Schema & string>(
    input: BuildCollectionInput<Schema, C>
): BuiltCollection<ExtractRecordType<Schema, C>> {
    const { pb, queryClient, factoryOptions, collectionName, options } = input
    type RecordType = ExtractRecordType<Schema, C>

    const relationTargets = options?.relations as RelationTargets | undefined
    const alwaysExpand = normalizePaths(options?.alwaysExpand ?? [])
    for (const path of alwaysExpand) validateExpandPath(collectionName, relationTargets, path)
    const syncMode = options?.syncMode ?? 'eager'

    // Paths requested by views that have subscribed at least once. Eager fetches
    // read it because they cannot receive per-subset options; the realtime
    // subscription reads it so echoes carry every relation in use.
    const requestedExpand = new Set<string>()

    type LoadOptions = LoadSubsetOptions & { expand?: readonly string[] }
    type PbRequest = { filter?: string; sort?: string; limit?: number; expand?: string }

    function toRequest(opts: LoadSubsetOptions | undefined): PbRequest {
        const request: PbRequest = {}
        const filter = convertToPocketBaseFilter(opts?.where)
        const sort = convertToPocketBaseSort(opts?.orderBy)
        const expand = joinPaths((opts as LoadOptions | undefined)?.expand ?? [])
        if (filter) request.filter = filter
        if (sort) request.sort = sort
        if (opts?.limit) request.limit = opts.limit
        if (expand) request.expand = expand
        return request
    }

    function queryKeyFor(opts?: LoadSubsetOptions): [C] | [C, PbRequest] {
        const request = toRequest(opts)
        return Object.keys(request).length === 0 ? [collectionName] : [collectionName, request]
    }

    function activeExpand(request: PbRequest): string | undefined {
        return joinPaths([
            ...alwaysExpand,
            ...splitPaths(request.expand),
            ...(syncMode === 'eager' ? requestedExpand : []),
        ])
    }

    const ignoreAutoCancellation = options?.ignoreAutoCancellation ?? true
    const refetchOnMutation = options?.refetchOnMutation ?? false

    async function upsertInto(
        key: string,
        target: ExpandTargetCollection,
        values: object[]
    ): Promise<void> {
        if (!target.utils) return
        if (!target.isReady()) {
            if (target.config?.syncMode === 'on-demand') {
                await target._sync.startSync()
            } else {
                logger.warn(
                    `not syncing ${key} on ${collectionName} because store is not yet ready`
                )
                return
            }
        }
        target.utils.writeUpsert(values)
    }

    async function upsertExpandedField(
        key: string,
        value: object | object[],
        targets: RelationTargets
    ): Promise<void> {
        const target = targets[key]
        if (!target) {
            logger.debug('No relation target for expanded field', { collectionName, key })
            return
        }
        const values = Array.isArray(value) ? value : [value]
        await upsertInto(key, target, values)
        await upsertExpanded(values, target.relationTargets)
    }

    async function upsertExpanded(
        records: object[],
        targets: RelationTargets | undefined
    ): Promise<void> {
        if (!targets) return
        for (const record of records) {
            const expandData = (record as { expand?: Record<string, object | object[]> }).expand
            if (!expandData) continue
            for (const [key, value] of Object.entries(expandData)) {
                await upsertExpandedField(key, value, targets)
            }
        }
    }

    async function fetchItems(request: PbRequest): Promise<RecordType[]> {
        const { filter, sort, limit } = request
        const expand = activeExpand(request)

        if (limit) {
            // Use getList when limit is specified to avoid fetching all records
            const result = await pb.collection(collectionName).getList(1, limit, {
                filter,
                sort,
                skipTotal: true, // Optimize by skipping total count
                expand,
            })
            return result.items as unknown as RecordType[]
        }
        // Use getFullList to fetch all records with automatic pagination
        return (await pb.collection(collectionName).getFullList({
            filter,
            sort,
            expand,
        })) as unknown as RecordType[]
    }

    // Each in-flight fetch registers a set here before its request goes out;
    // authoritative local writes (mutation write-backs and realtime echoes)
    // add the confirmed record ids to every registered set. An id added
    // after a fetch was issued is newer than that fetch's view of the
    // server, so the result cannot speak to the id's absence. The merge
    // deliberately ignores the fetch's filter: the manual-write cache push
    // grants every active query ownership of every synced row, so even a
    // row outside this subset's filter must be shielded from its reconcile.
    //
    // Why this exists: @tanstack/query-db-collection's applySuccessfulResult
    // reconcile-DELETES every row a query owns that its result omits, and the
    // synced-write guard below deliberately exempts deletes. A subset read
    // issued before a row existed can therefore resolve late and delete the
    // just-confirmed row (rows a query owns include rows pushed into its
    // cache by the manual-write path that runs on every write-back). The fix
    // is applied to the RESULT rather than the delete: fetchRecords merges
    // such rows back in, which both prevents the delete and keeps the row
    // owned by the query — a dropped delete alone would still strip
    // ownership and leave the row to a later GC pass.
    const inFlightConfirmedIds = new Set<Set<string>>()

    function markConfirmedPresent(records: RecordType[]): void {
        if (inFlightConfirmedIds.size === 0) return
        for (const record of records) {
            const id = (record as { id?: unknown } | null | undefined)?.id
            if (typeof id !== 'string') continue
            for (const confirmed of inFlightConfirmedIds) confirmed.add(id)
        }
    }

    function withRowsConfirmedMidFlight(
        items: RecordType[],
        confirmedMidFlight: Set<string>
    ): RecordType[] {
        if (confirmedMidFlight.size === 0) return items
        const resultIds = new Set(
            items.map(item => (item as { id?: unknown } | null | undefined)?.id)
        )
        // Ids absent from the synced store (deleted mid-flight, or never
        // landed) have nothing to protect and drop out of the merge.
        const mergedIds = [...confirmedMidFlight].filter(
            id => !resultIds.has(id) && collection._state.syncedData.has(id)
        )
        if (mergedIds.length === 0) return items
        logger.debug('Merging rows confirmed while fetch was in flight', {
            collectionName,
            ids: mergedIds,
        })
        return [
            ...items,
            ...mergedIds.map(id => collection._state.syncedData.get(id) as RecordType),
        ]
    }

    async function fetchRecords(
        request: PbRequest,
        queryKey: readonly unknown[]
    ): Promise<RecordType[]> {
        const confirmedMidFlight = new Set<string>()
        inFlightConfirmedIds.add(confirmedMidFlight)
        try {
            let items: RecordType[]
            try {
                items = await fetchItems(request)
            } catch (error) {
                if (
                    ignoreAutoCancellation &&
                    error instanceof Error &&
                    error.message.includes('autocancelled')
                ) {
                    // PocketBase auto-cancelled this in-flight read because a newer
                    // request superseded it. Resolve to THIS subset's own cached rows
                    // (keyed by the full query key) so the reconcile is a no-op for the
                    // subset. The base key ([collectionName]) holds the full-collection
                    // snapshot — returning that here would let applySuccessfulResult
                    // reconcile foreign rows into a filtered subset (re-introducing rows
                    // the subset's filter excludes). Re-throwing instead would error the
                    // subset and empty/retry it.
                    return withRowsConfirmedMidFlight(
                        queryClient.getQueryData<RecordType[]>(queryKey) ?? [],
                        confirmedMidFlight
                    )
                }
                throw error
            }

            await upsertExpanded(items, relationTargets)
            if (request.expand) writeExpandedRows(items)

            return withRowsConfirmedMidFlight(items, confirmedMidFlight)
        } finally {
            inFlightConfirmedIds.delete(confirmedMidFlight)
        }
    }

    // query-db-collection only calls its synced `write` for a row a query newly
    // "owns" in the synced store — a query whose result includes a row another
    // query already put there is treated as a no-op, even though this fetch may
    // be the only one carrying `expand` data for that row (e.g. a base and a view
    // of the same collection joined in one live query). Write such rows directly
    // so the view's `expand` field always reaches the shared store.
    function writeExpandedRows(items: RecordType[]): void {
        // On a collection's first fetch the store is empty, so
        // applySuccessfulResult inserts the rows itself; nothing to do here yet.
        if (!collection.utils || !collection.isReady()) return
        // Not writeOwn: writeOwn's optimistic-pending exemption is reserved for
        // writes already staleness-filtered upstream (writeBackAfterPersisted,
        // isStaleEcho). A view fetch is an unfiltered server read — exactly what
        // the optimistic-pending arm of shouldDropSyncedWrite must still catch,
        // since isStaleServerRecord alone compares against the synced store,
        // which a pending optimistic overlay does not update.
        collection.utils.writeUpsert(items)
    }

    const queryCollectionConfig = queryCollectionOptions({
        ...options?.collectionOptions,
        queryClient,
        queryKey: queryKeyFor,
        syncMode,
        queryFn: async (ctx): Promise<RecordType[]> => {
            const request = (ctx.queryKey[1] as PbRequest | undefined) ?? {}
            return fetchRecords(request, ctx.queryKey)
        },
        getKey: (item: RecordType) => {
            const record = item as unknown as Record<string, unknown>
            if (!record || typeof record !== 'object' || !('id' in record)) {
                throw new Error(
                    `Record in collection '${collectionName}' is missing required 'id' field. Received: ${JSON.stringify(item)}`
                )
            }
            return record.id as string
        },
        onInsert:
            options?.onInsert === false
                ? undefined
                : (options?.onInsert ??
                  (async ({ transaction }) => {
                      const created = await Promise.all(
                          transaction.mutations.map(async mutation => {
                              const {
                                  created: _created,
                                  updated: _updated,
                                  collectionId: _collectionId,
                                  collectionName: _collectionName,
                                  ...data
                              } = mutation.modified as unknown as Record<string, unknown>
                              return pb.collection(collectionName).create(data)
                          })
                      )
                      writeBackAfterPersisted(transaction, created)
                      return { refetch: refetchOnMutation }
                  })),
        onUpdate:
            options?.onUpdate === false
                ? undefined
                : (options?.onUpdate ??
                  (async ({ transaction }) => {
                      const updated = await Promise.all(
                          transaction.mutations.map(async mutation => {
                              const recordWithId = mutation.original as { id: string }
                              return pb
                                  .collection(collectionName)
                                  .update(recordWithId.id, mutation.changes)
                          })
                      )
                      writeBackAfterPersisted(transaction, updated)
                      return { refetch: refetchOnMutation }
                  })),
        onDelete:
            options?.onDelete === false
                ? undefined
                : (options?.onDelete ??
                  (async ({ transaction }) => {
                      await Promise.all(
                          transaction.mutations.map(async mutation => {
                              const recordWithId = mutation.original as { id: string }
                              await pb.collection(collectionName).delete(recordWithId.id)
                          })
                      )
                      return { refetch: refetchOnMutation }
                  })),
    })

    // queryCollectionOptions consumes `gcTime` for the underlying react-query
    // observer and never forwards it to the collection options it returns, so
    // the DB collection's own lifecycle GC (what controls when an idle
    // collection reaches 'cleaned-up') would silently fall back to its
    // 5-minute default. Re-apply it explicitly so a caller-supplied value
    // reaches both layers.
    const collectionOptions =
        options?.collectionOptions?.gcTime === undefined
            ? queryCollectionConfig
            : { ...queryCollectionConfig, gcTime: options.collectionOptions.gcTime }

    // Write the server's copy of a mutation's rows back AFTER the transaction
    // has persisted — never from inside its handler.
    //
    // TanStack DB keeps a completed transaction's optimistic draft visible
    // until a synced write for the key arrives, so a record the server
    // fills in (a number, a timestamp) reaches the screen only through that
    // later synced write. A write-back issued from inside the handler lands
    // while the transaction is still `persisting`; TanStack applies it,
    // then on completion re-adds the draft as a "confirmed but unsynced"
    // overlay and waits for a synced write that already happened. If the
    // realtime echo has ALSO already been consumed (it arrives before the
    // create resolves under load, and an echo carrying the same `updated`
    // as the write-back is dropped as stale), nothing ever clears the
    // overlay: the row shows the draft — minus every server-assigned field
    // — until a reload. Deferring the write-back to after persistence makes
    // it the synced write TanStack is waiting for.
    //
    // `markConfirmedPresent` still runs immediately: the in-flight fetch
    // bookkeeping needs to know the rows are confirmed the moment the
    // server said so, not a tick later.
    //
    // The deferred write itself: a no-op until the collection is ready
    // (writing into the synced store before sync has initialized throws,
    // and with no live query there is nothing to keep in sync — the next
    // query fetches the already-persisted state; the transaction can
    // outlive the last subscriber), and it drops any row the store already
    // supersedes — a realtime echo may have landed a newer copy while the
    // transaction was settling, and writing the response over it would
    // revert the row.
    function writeBackAfterPersisted(
        transaction: { isPersisted: { promise: Promise<unknown> } },
        records: RecordType[]
    ): void {
        markConfirmedPresent(records)
        void transaction.isPersisted.promise.then(
            () => {
                if (!collection.utils || !collection.isReady()) return
                const fresh = records.filter(record => !isStaleServerRecord(record))
                if (fresh.length === 0) return
                writeOwn(() => collection.utils.writeUpsert(fresh))
            },
            // A rejected transaction rolled its draft back; there is
            // nothing to write and nothing to report here.
            () => undefined
        )
    }

    // Set while pbtsdb performs its own authoritative writes (mutation-response
    // write-backs and realtime echoes) through collection.utils.*. Those writes
    // share the same sync `write` primitive as the query-result reconcile path
    // (see the sync.sync wrapper below), so the guard uses this flag to tell them
    // apart: pbtsdb's own writes are exempt from the optimistic-pending arm of the
    // guard (the mutation-response write-back intentionally lands the confirmed
    // value while that very mutation's optimistic overlay is still in flight).
    let applyingOwnWrite = false
    function writeOwn(fn: () => void): void {
        applyingOwnWrite = true
        try {
            fn()
        } finally {
            applyingOwnWrite = false
        }
    }

    // The record id a synced insert/update targets, or null when the op is a delete
    // (terminal — never guarded) or carries no usable key.
    function syncedWriteKey(op: { type: string; value?: unknown; key?: unknown }): string | null {
        if (op.type !== 'insert' && op.type !== 'update') return null
        if (typeof op.key === 'string') return op.key
        const id = (op.value as { id?: unknown } | undefined)?.id
        return typeof id === 'string' ? id : null
    }

    // Guard the synced write path that pbtsdb does not otherwise control:
    // @tanstack/query-db-collection's applySuccessfulResult reconciles every query
    // result into the synced store via this same `write`, with no recency or
    // optimistic check. Under on-demand contention a single-row/subset read can
    // resolve with a pre-mutation row and land here after the row already moved on,
    // reverting it. We drop such a synced insert/update when either it targets a key
    // with a pending optimistic mutation (see the arm below) or it is strictly older
    // than the synced row (an out-of-order read). pbtsdb's own writes
    // (applyingOwnWrite) skip the optimistic arm; they are staleness-filtered
    // upstream by writeBackAfterPersisted/isStaleEcho.
    function shouldDropSyncedWrite(op: { type: string; value?: unknown; key?: unknown }): boolean {
        const key = syncedWriteKey(op)
        if (key === null) return false
        // Optimistic arm: only guard a key already present in the synced store. A
        // write to a key the synced store doesn't yet hold is populating it (e.g. the
        // initial fetch landing a row the user just optimistically inserted) and must
        // pass — dropping it would leave the row absent once the overlay clears. A
        // write to a key already synced, while an optimistic mutation is pending, is a
        // racing read that would revert the in-flight value, so drop it.
        if (
            !applyingOwnWrite &&
            hasPendingOptimisticMutation(key) &&
            collection._state.syncedData.has(key)
        ) {
            logger.debug('Dropping synced write for optimistically-pending row', {
                collectionName,
                id: key,
            })
            return true
        }
        if (isStaleServerRecord(op.value)) {
            logger.debug('Dropping stale synced write', { collectionName, id: key })
            return true
        }
        return false
    }

    // A view's subscription is tagged in viewPaths (see createView below); this
    // adds the view's expand paths to load options for a tagged subscription so
    // loadSubset/unloadSubset fetch (and later untrack) with the right `expand`.
    // A subscription's initial snapshot loads synchronously inside
    // collection.subscribeChanges, before that call returns the subscription
    // object a view tags in viewPaths — so that first loadSubset cannot yet be
    // looked up by identity. While a view's subscribeChanges call is on the
    // stack, its paths are used for load options with no tagged subscription;
    // every later call (untracked demand growth, unloadSubset) is tagged by then.
    let subscribingViewPaths: string[] | undefined

    function withViewExpand(opts: LoadSubsetOptions): LoadOptions {
        const paths =
            (opts.subscription && viewPaths.get(opts.subscription)) ?? subscribingViewPaths
        return paths ? { ...opts, expand: paths } : opts
    }

    // Merge a synced insert/update's value with any `expand` already stored for its
    // key, so a later write that omits `expand` (e.g. a plain fetch of the same row)
    // does not wipe an entry another query's view put there. Called only for an
    // insert/update carrying an object value; returns the value unchanged (by
    // identity) when there is nothing to carry.
    function mergedWriteValue(op: { type: string; value?: unknown; key?: unknown }): RecordType {
        const key = syncedWriteKey(op)
        const existing =
            key === null
                ? undefined
                : (collection._state.syncedData.get(key) as RecordType | undefined)
        return mergeExpand(op.value as RecordType, existing)
    }

    // Wrap the sync factory so every synced `write` flows through the guard above,
    // and every loadSubset/unloadSubset call is tagged with a view's expand paths.
    // @tanstack/db invokes sync.sync with the write primitives; we hand back the
    // same params with a filtered `write`. begin/commit/markReady/etc. pass through.
    const innerSync = collectionOptions.sync.sync
    collectionOptions.sync = {
        ...collectionOptions.sync,
        sync: (params: Parameters<typeof innerSync>[0]) => {
            const guardedWrite: typeof params.write = message => {
                const op = message as { type: string; value?: unknown; key?: unknown }
                if (shouldDropSyncedWrite(op)) return
                if (
                    (op.type === 'insert' || op.type === 'update') &&
                    op.value &&
                    typeof op.value === 'object'
                ) {
                    const merged = mergedWriteValue(op)
                    if (merged !== op.value) return params.write({ ...message, value: merged })
                }
                return params.write(message)
            }
            const res = innerSync({ ...params, write: guardedWrite })
            if (!res || typeof res === 'function') return res
            const { loadSubset, unloadSubset } = res
            return {
                ...res,
                loadSubset: loadSubset
                    ? (opts: LoadSubsetOptions) => loadSubset(withViewExpand(opts))
                    : undefined,
                unloadSubset: unloadSubset
                    ? (opts: LoadSubsetOptions) => unloadSubset(withViewExpand(opts))
                    : undefined,
            }
        },
    }

    const collection = createTanStackCollection(collectionOptions)

    const views = new Map<string, object>()

    function createView(paths: string[]): object {
        const view = Object.create(collection)
        Object.defineProperties(view, {
            id: { value: `${collectionName}?expand=${paths.join(',')}` },
            subscribeChanges: {
                value: (...args: Parameters<typeof collection.subscribeChanges>) => {
                    noteViewSubscribed(paths)
                    subscribingViewPaths = paths
                    try {
                        const subscription = collection.subscribeChanges(...args)
                        viewPaths.set(subscription, paths)
                        return subscription
                    } finally {
                        subscribingViewPaths = undefined
                    }
                },
            },
            expand: {
                value: () => {
                    throw new Error(`A view of "${collectionName}" cannot be expanded further`)
                },
            },
        })
        return view
    }

    function expand(...paths: string[]): object {
        for (const path of paths) validateExpandPath(collectionName, relationTargets, path)
        const all = normalizePaths([...alwaysExpand, ...paths])
        if (all.every(path => alwaysExpand.includes(path))) return collection
        const key = all.join(',')
        let view = views.get(key)
        if (!view) {
            view = createView(all)
            views.set(key, view)
        }
        return view
    }

    // True when the key has an in-flight (not yet settled) optimistic mutation.
    // While pending, the optimistic overlay — not syncedData — is the visible value,
    // so any synced write would only take effect once the overlay collapses, and an
    // older/racing read landing here is exactly what reverts a just-applied move.
    function hasPendingOptimisticMutation(key: string): boolean {
        const state = collection._state as unknown as {
            optimisticUpserts: { has: (k: string) => boolean }
            optimisticDeletes: { has: (k: string) => boolean }
        }
        return state.optimisticUpserts.has(key) || state.optimisticDeletes.has(key)
    }

    // Read the PocketBase `updated` autodate from a record, if present.
    // Collections without an `updated` field opt out of staleness checks.
    function recordUpdatedAt(record: unknown): string | undefined {
        const updated = (record as { updated?: unknown } | null | undefined)?.updated
        return typeof updated === 'string' && updated !== '' ? updated : undefined
    }

    // A server record is stale relative to the synced store when an entry for
    // the same key already holds a newer `updated` timestamp. PocketBase can
    // redeliver or reorder realtime echoes (and a slow mutation response can
    // resolve after a newer echo), so applying an older write would revert the
    // row. ISO 8601 timestamps sort lexicographically, so string comparison is
    // chronological. When either side lacks a comparable timestamp we cannot
    // tell, so we treat the write as fresh and let it through.
    //
    // Strictly older, never equal. PocketBase stamps `updated` to the
    // millisecond and bumps it on every write, so an equal timestamp is the
    // same version of the row: re-landing it changes nothing, and it is what
    // lets a confirmed value clear a lingering optimistic overlay. (An earlier
    // `<=` variant on the query-result path guarded against a read carrying
    // old content under a new timestamp, which a real server cannot produce;
    // the revert it chased was the write-back racing its own transaction,
    // fixed in writeBackAfterPersisted.)
    function isStaleServerRecord(record: unknown): boolean {
        const id = (record as { id?: unknown } | null | undefined)?.id
        if (typeof id !== 'string') return false
        const incoming = recordUpdatedAt(record)
        if (!incoming) return false
        const current = recordUpdatedAt(
            collection._state.syncedData.get(id) as RecordType | undefined
        )
        if (current === undefined) return false
        return incoming < current
    }

    // Decide whether a realtime echo should be dropped as stale. Under realtime
    // contention PocketBase can redeliver or reorder events, so an echo carrying
    // a pre-mutation value can arrive after the row already moved on (e.g. the
    // local mutation that just wrote the fresh value back). Applying a
    // strictly-older create/update echo would revert the row, so it is ignored.
    // Deletes are terminal and not timestamp-guarded.
    function isStaleEcho(event: RecordSubscription<RecordType>): boolean {
        if (event.action !== 'create' && event.action !== 'update') return false
        if (!isStaleServerRecord(event.record)) return false
        logger.debug('Ignoring stale realtime echo', {
            collectionName,
            id: (event.record as { id?: string } | undefined)?.id,
        })
        return true
    }

    // Real-time subscription state
    let unsubscribeFn: (() => Promise<void>) | null = null
    let isSubscribed = false
    let subscriptionPromise: Promise<void> | null = null
    let subscriptionResolve: (() => void) | null = null
    // The `expand` string sent with the currently live subscription, so a
    // caller that widened requestedExpand mid-flight can tell whether the
    // subscription that just landed already covers it.
    let subscribedExpand: string | undefined

    // All start/stop/restart work is serialized onto this promise tail so
    // overlapping callers (two views created back-to-back, a reconnect
    // racing a widened expand) never run startSubscription/stopSubscription
    // concurrently — the tail is what lets a later caller's restart observe
    // the outcome of an earlier caller's in-flight start. Errors are caught
    // and logged so a failed step never poisons the tail for later work.
    let subscriptionWork: Promise<void> = Promise.resolve()
    function enqueueSubscriptionWork(fn: () => Promise<void>): Promise<void> {
        const run = subscriptionWork.then(fn, fn).catch(error => {
            logger.error('Subscription work failed', { collectionName, error })
        })
        subscriptionWork = run
        return run
    }

    // Handle real-time events from PocketBase.
    //
    // The write primitives differ in how they treat a key that is absent from
    // the *synced* store (collection._state.syncedData, which is what they
    // validate against — not the optimistic view exposed by collection.has()):
    //   - writeInsert / writeUpsert: idempotent, never throw on an absent key.
    //   - writeDelete: throws DeleteOperationItemNotFoundError on an absent key.
    // So only the delete branch can throw, and we make it idempotent below.
    // Runs BEFORE the stale-echo filter: even a stale create/update echo
    // proves the server holds the row. Delete echoes need no marking — the
    // merge checks the synced store, which the delete's writeDelete empties.
    function markEchoPresence(event: RecordSubscription<RecordType>): void {
        if (event.action !== 'delete') markConfirmedPresent([event.record])
    }

    const handleRealtimeEvent = (event: RecordSubscription<RecordType>) => {
        if (!collection.utils) return
        markEchoPresence(event)
        if (isStaleEcho(event)) return

        try {
            writeOwn(() =>
                collection.utils.writeBatch(() => {
                    switch (event.action) {
                        case 'create':
                            collection.utils.writeInsert(event.record)
                            break
                        case 'update':
                            collection.utils.writeUpsert(event.record)
                            break
                        case 'delete':
                            if (event.record && 'id' in event.record) {
                                // Throws DeleteOperationItemNotFoundError if the key
                                // is no longer in the synced store (see catch below).
                                collection.utils.writeDelete((event.record as { id: string }).id)
                            }
                            break
                    }
                })
            )
        } catch (error) {
            // How a delete echo throws: writeDelete fails when its key is already
            // gone from the synced store. That happens when something removed it
            // before the echo arrived:
            //   1. on-demand sync — each useLiveQuery refetches with a server
            //      filter, and query-db-collection prunes rows no longer owned by
            //      any active query out of the synced store. If that prune (or a
            //      concurrent query's reconcile) runs before this client's own
            //      delete echo lands, the key is already gone -> throw. This is
            //      the on-demand-only race; eager collections have no such second
            //      writer to the synced store, so they cannot hit it.
            //   2. a re-delivered SSE delete (e.g. after a reconnect) for a key
            //      that was already deleted -> throw on the second echo.
            // In both cases the record is already in its intended end state
            // (gone), so the echo is a no-op and the error is safe to ignore.
            // Anything that is NOT a missing-key delete is a real error: rethrow.
            if (error instanceof DeleteOperationItemNotFoundError) {
                logger.debug('Ignoring delete echo for already-removed record', {
                    collectionName,
                    id: (event.record as { id?: string } | undefined)?.id,
                })
            } else {
                throw error
            }
        }

        if (event.action !== 'delete') {
            upsertExpanded([event.record], relationTargets).catch(error =>
                logger.error('Failed to upsert expanded records from realtime echo', {
                    collectionName,
                    error,
                })
            )
        }
    }

    // The union of expand paths the next (re)subscribe should carry:
    // alwaysExpand plus every path a view has requested. Pure and
    // side-effect-free (unlike realtimeSubscribeOptions below), so it is
    // safe to call more than once per subscribe attempt to detect drift.
    function pendingSubscribeExpand(): string | undefined {
        return joinPaths([...alwaysExpand, ...requestedExpand])
    }

    // Options for the next (re)subscribe: the expand union above, merged
    // with whatever the factory's own subscribeOptions() supplies rather
    // than overridden by it. Calls the factory callback, so it is invoked
    // exactly once per subscribe attempt (never re-derived afterward).
    function realtimeSubscribeOptions(): RecordSubscribeOptions | undefined {
        const base = factoryOptions?.subscribeOptions?.()
        const expand = joinPaths([
            ...splitPaths(pendingSubscribeExpand()),
            ...splitPaths(base?.expand),
        ])
        return expand ? { ...base, expand } : base
    }

    // Start PocketBase real-time subscription. Only ever run through
    // enqueueSubscriptionWork so it never overlaps a stop/restart.
    const doStartSubscription = async () => {
        if (isSubscribed) return

        // Create promise before starting so waiters can await it
        if (!subscriptionPromise) {
            subscriptionPromise = new Promise<void>(resolve => {
                subscriptionResolve = resolve
            })
        }

        const pendingExpand = pendingSubscribeExpand()
        try {
            unsubscribeFn = await pb
                .collection(collectionName)
                .subscribe('*', handleRealtimeEvent, realtimeSubscribeOptions())
            isSubscribed = true
            subscribedExpand = pendingExpand
            logger.debug('Subscription started', { collectionName })
            // Resolve the promise to notify waiters
            if (subscriptionResolve) {
                subscriptionResolve()
            }
        } catch (error) {
            logger.error('Failed to start subscription', { collectionName, error })
        }

        // requestedExpand can grow while the subscribe() call above was in
        // flight (a view mounted mid-round-trip sees no live subscription
        // yet, and would otherwise never schedule a restart). Comparing
        // against the pure expand union (not realtimeSubscribeOptions,
        // which would re-invoke the factory's own subscribeOptions()
        // callback) lets this check run after every start with no
        // observable side effect.
        if (pendingSubscribeExpand() !== subscribedExpand) {
            enqueueSubscriptionWork(doRestartSubscription).catch(() => {})
        }
    }

    // Stop PocketBase real-time subscription. Only ever run through
    // enqueueSubscriptionWork so it never overlaps a start/restart.
    const doStopSubscription = async () => {
        if (!isSubscribed || !unsubscribeFn) return

        try {
            await unsubscribeFn()
            unsubscribeFn = null
            isSubscribed = false
            subscribedExpand = undefined
            // Reset promise for next subscription cycle
            subscriptionPromise = null
            subscriptionResolve = null
            logger.debug('Subscription stopped', { collectionName })
        } catch (error) {
            logger.debug('Unsubscribe failed (expected if connection closed)', {
                collectionName,
                error,
            })
        }
    }

    // Restart the live subscription, e.g. after the requested expand union
    // grows. A no-op when there is no live subscription to restart — the
    // next first-subscriber start already picks up the current union.
    const doRestartSubscription = async () => {
        if (!isSubscribed) return
        await doStopSubscription()
        await doStartSubscription()
    }

    const startSubscription = () => enqueueSubscriptionWork(doStartSubscription)
    const stopSubscription = () => enqueueSubscriptionWork(doStopSubscription)
    const restartSubscription = () => enqueueSubscriptionWork(doRestartSubscription)

    // Record which expand paths a view has subscribed with at least once.
    // Eager collections cannot request per-subset options, so a wider union
    // needs a refetch to pick up the new expand; a live realtime subscription
    // needs restarting so its own expand union grows too.
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
            void collection.utils.refetch().catch(error =>
                logger.error('Failed to refetch after widening expand', {
                    collectionName,
                    error,
                })
            )
        }
        // Enqueued unconditionally (not gated on isSubscribed): the tail
        // guarantees this runs after any in-flight start/stop, and
        // doRestartSubscription itself no-ops when nothing is live.
        restartSubscription().catch(error =>
            logger.error('Failed to restart subscription with wider expand', {
                collectionName,
                error,
            })
        )
    }

    // Wait for subscription to be established (for testing)
    const waitForSubscription = async (timeout = 5000): Promise<void> => {
        if (isSubscribed) return

        if (!subscriptionPromise) {
            // No subscription in progress, wait for one to start
            await new Promise<void>(resolve => {
                const checkInterval = setInterval(() => {
                    if (subscriptionPromise) {
                        clearInterval(checkInterval)
                        resolve()
                    }
                }, 10)
                setTimeout(() => {
                    clearInterval(checkInterval)
                    resolve()
                }, timeout)
            })
        }

        if (subscriptionPromise) {
            await Promise.race([
                subscriptionPromise,
                new Promise<void>((_, reject) =>
                    setTimeout(() => reject(new Error('Subscription timeout')), timeout)
                ),
            ])
        }
    }

    // Manage subscription based on collection subscriber count
    collection.on(
        'subscribers:change',
        (event: { subscriberCount: number; previousSubscriberCount: number }) => {
            const newCount = event.subscriberCount
            const previousCount = event.previousSubscriberCount

            if (newCount > 0 && previousCount === 0) {
                // First subscriber - start real-time subscription
                startSubscription().catch(() => {})
            } else if (newCount === 0 && previousCount > 0) {
                // Last subscriber removed - stop real-time subscription
                stopSubscription().catch(() => {})
            }
        }
    )

    // Add collectionName and subscription helpers
    Object.assign(collection, {
        collectionName,
        relationTargets,
        waitForSubscription,
        isSubscribed: () => isSubscribed,
        expand,
    })

    return collection as unknown as BuiltCollection<RecordType>
}
