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
import type { RecordSubscription } from 'pocketbase'
import { logger } from './logger'
import { convertToPocketBaseFilter, convertToPocketBaseSort } from './pocketbase-query-converter'
import type {
    CreateCollectionOptions,
    ExpandTargetCollection,
    ExtractRecordType,
    SchemaDeclaration,
} from './types'

export type { BaseRecord, CreateCollectionOptions, SchemaDeclaration } from './types'

/**
 * Extended LoadSubsetOptions that includes PocketBase-specific expand parameter.
 * @internal
 */
type ExtendedLoadSubsetOptions = LoadSubsetOptions & {
    pbExpand?: string
}

/**
 * Compute the record type with expand property when expand option is configured.
 * @internal
 */
type WithExpandFromConfig<
    Schema extends SchemaDeclaration,
    C extends keyof Schema,
    Opts,
> = Opts extends {
    expand: infer E
}
    ? ExtractRecordType<Schema, C> & {
          expand?: {
              [K in keyof E]: K extends keyof import('./types').ExtractRelations<Schema, C>
                  ? import('./types').ExtractRelations<Schema, C>[K] extends Array<infer U>
                      ? U[]
                      : import('./types').ExtractRelations<Schema, C>[K]
                  : never
          }
      }
    : ExtractRecordType<Schema, C>

/**
 * Subscription helpers added to collection instances.
 * @internal
 */
interface CollectionSubscriptionHelpers {
    /** The PocketBase collection name */
    collectionName: string
    /** Wait for subscription to be established (useful in tests) */
    waitForSubscription: (timeout?: number) => Promise<void>
    /** Check if collection has an active subscription */
    isSubscribed: () => boolean
}

/**
 * Inferred collection type from config options.
 * @internal
 */
type InferCollectionType<
    Schema extends SchemaDeclaration,
    C extends keyof Schema,
    Opts extends CreateCollectionOptions<Schema, C>,
> = Collection<
    WithExpandFromConfig<Schema, C, Opts>,
    string | number,
    // TUtils - QueryCollectionUtils from TanStack Query DB Collection
    QueryCollectionUtils<
        WithExpandFromConfig<Schema, C, Opts>,
        string | number,
        WithExpandFromConfig<Schema, C, Opts>
    >,
    // TSchema - we don't use StandardSchema validation
    never,
    Opts extends {
        omitOnInsert: infer O extends readonly import('./types').OmittableFields<
            ExtractRecordType<Schema, C>
        >[]
    }
        ? import('./types').ComputeInsertType<ExtractRecordType<Schema, C>, O>
        : ExtractRecordType<Schema, C>
> &
    CollectionSubscriptionHelpers

/**
 * Creates a type-safe TanStack DB collection backed by PocketBase.
 * Use this when you need fine-grained control or need to create collections with dependencies.
 *
 * @param pb - PocketBase client instance
 * @param queryClient - TanStack Query client
 * @returns A curried function that takes collection name and options
 *
 * @example
 * Basic usage:
 * ```ts
 * const booksCollection = createCollection<Schema>(pb, queryClient)('books', {});
 *
 * // Use directly
 * const books = await booksCollection.getFullList();
 * ```
 *
 * @example
 * With auto-expand relations:
 * ```ts
 * const authorsCollection = createCollection<Schema>(pb, queryClient)('authors', {});
 * const booksCollection = createCollection<Schema>(pb, queryClient)('books', {
 *     expand: {
 *         author: authorsCollection  // Always expand, auto-upsert into authorsCollection
 *     }
 * });
 *
 * // Expand is automatic - no .expand() call needed
 * const { data } = useLiveQuery((q) => q.from({ books: booksCollection }));
 * // data[0].expand.author is typed and populated
 * ```
 */
export function createCollection<Schema extends SchemaDeclaration>(
    pb: PocketBase,
    queryClient: QueryClient
) {
    return <
        C extends keyof Schema & string,
        Opts extends CreateCollectionOptions<Schema, C> = CreateCollectionOptions<Schema, C>,
    >(
        collectionName: C,
        options?: Opts
    ): InferCollectionType<Schema, C, Opts> => {
        type RecordType = ExtractRecordType<Schema, C>
        const expandStores = options?.expand as Record<string, ExpandTargetCollection> | undefined
        const expandString = expandStores ? Object.keys(expandStores).sort().join(',') : undefined

        const ignoreAutoCancellation = options?.ignoreAutoCancellation ?? true
        const refetchOnMutation = options?.refetchOnMutation ?? false

        async function upsertExpandedRelation(
            key: string,
            value: object | object[],
            stores: Record<string, ExpandTargetCollection>
        ): Promise<void> {
            const targetStore = stores[key]
            if (!targetStore.utils) return
            if (!targetStore.isReady()) {
                if (targetStore.config?.syncMode === 'on-demand') {
                    await targetStore._sync.startSync()
                } else {
                    logger.warn(
                        `not syncing ${key} on ${collectionName} because store is not yet ready`
                    )
                    return
                }
            }
            const values = Array.isArray(value) ? value : [value]
            targetStore.utils.writeUpsert(values)
        }

        async function upsertExpandedRelations(items: RecordType[]): Promise<void> {
            if (!expandStores) return
            for (const record of items) {
                const expandData = (
                    record as RecordType & { expand?: Record<string, object | object[]> }
                ).expand
                if (!expandData) continue
                for (const [key, value] of Object.entries(expandData)) {
                    await upsertExpandedRelation(key, value, expandStores)
                }
            }
        }

        async function fetchItems(loadOptions?: ExtendedLoadSubsetOptions): Promise<RecordType[]> {
            const filter = convertToPocketBaseFilter(loadOptions?.where)
            const sort = convertToPocketBaseSort(loadOptions?.orderBy)
            const limit = loadOptions?.limit

            if (limit) {
                // Use getList when limit is specified to avoid fetching all records
                const result = await pb.collection(collectionName).getList(1, limit, {
                    filter,
                    sort,
                    skipTotal: true, // Optimize by skipping total count
                    expand: expandString,
                })
                return result.items as unknown as RecordType[]
            }
            // Use getFullList to fetch all records with automatic pagination
            return (await pb.collection(collectionName).getFullList({
                filter,
                sort,
                expand: expandString,
            })) as unknown as RecordType[]
        }

        async function fetchRecords(
            loadOptions?: ExtendedLoadSubsetOptions,
            queryKey?: readonly unknown[]
        ): Promise<RecordType[]> {
            let items: RecordType[]
            try {
                items = await fetchItems(loadOptions)
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
                    return (
                        queryClient.getQueryData<RecordType[]>(queryKey ?? [collectionName]) ?? []
                    )
                }
                throw error
            }

            await upsertExpandedRelations(items)

            return items
        }

        const collectionOptions = queryCollectionOptions({
            ...options?.collectionOptions,
            queryClient,
            queryKey: [collectionName],
            syncMode: options?.syncMode ?? 'eager',
            queryFn: async (ctx): Promise<RecordType[]> => {
                return fetchRecords(
                    ctx.meta?.loadSubsetOptions as ExtendedLoadSubsetOptions | undefined,
                    ctx.queryKey
                )
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
                          writeServerRecords(created)
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
                          writeServerRecords(updated)
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
        function syncedWriteKey(op: {
            type: string
            value?: unknown
            key?: unknown
        }): string | null {
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
        // with a pending optimistic mutation (see the arm below) or it is no newer than
        // the synced row (out-of-order or post-settle read — equal `updated` included,
        // since the read can only carry a same-or-older value than the move's write-back
        // already in synced). pbtsdb's own writes (applyingOwnWrite) skip the optimistic
        // arm; they are still staleness-filtered upstream by writeServerRecords/isStaleEcho
        // (which keep the strict `<` so a confirmed same-second value can re-land).
        function shouldDropSyncedWrite(op: {
            type: string
            value?: unknown
            key?: unknown
        }): boolean {
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
            if (isStaleServerRecord(op.value, !applyingOwnWrite)) {
                logger.debug('Dropping stale synced write', { collectionName, id: key })
                return true
            }
            return false
        }

        // Wrap the sync factory so every synced `write` flows through the guard above.
        // @tanstack/db invokes sync.sync with the write primitives; we hand back the
        // same params with a filtered `write`. begin/commit/markReady/etc. pass through.
        const innerSync = collectionOptions.sync.sync
        collectionOptions.sync = {
            ...collectionOptions.sync,
            sync: (params: Parameters<typeof innerSync>[0]) => {
                const guardedWrite: typeof params.write = message => {
                    if (
                        shouldDropSyncedWrite(
                            message as { type: string; value?: unknown; key?: unknown }
                        )
                    ) {
                        return
                    }
                    return params.write(message)
                }
                return innerSync({ ...params, write: guardedWrite })
            },
        }

        const collection = createTanStackCollection(collectionOptions)

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
        // `treatEqualAsStale` controls the equal-timestamp case. PocketBase bumps
        // `updated` on every mutation, so a record carrying the SAME `updated` second
        // as the synced row holds the same content — it cannot be newer. The default
        // (strict `<`) lets an own write-back/realtime echo re-land that confirmed
        // value harmlessly. The query-result path passes `true` (`<=`): a server read
        // resolving with the same-second value is the post-settle revert race — once
        // an optimistic move settles, the only thing that put a *fresher* value in
        // synced is that move's own write-back, and a same-second read would overwrite
        // it back to the pre-move row. There is nothing newer for an equal-timestamp
        // query result to legitimately deliver, so dropping it is safe.
        function isStaleServerRecord(record: unknown, treatEqualAsStale = false): boolean {
            const id = (record as { id?: unknown } | null | undefined)?.id
            if (typeof id !== 'string') return false
            const incoming = recordUpdatedAt(record)
            if (!incoming) return false
            const current = recordUpdatedAt(
                collection._state.syncedData.get(id) as RecordType | undefined
            )
            if (current === undefined) return false
            return treatEqualAsStale ? incoming <= current : incoming < current
        }

        // Write authoritative server records (mutation responses or realtime echoes)
        // into the synced store, dropping any that the store already supersedes.
        // No-op until the collection is ready: writing into the synced store before
        // sync has initialized throws, and with no live query there is nothing to
        // keep in sync — the next query fetches the already-persisted state.
        function writeServerRecords(records: RecordType[]): void {
            if (!collection.utils || !collection.isReady()) return
            const fresh = records.filter(record => !isStaleServerRecord(record))
            if (fresh.length === 0) return
            writeOwn(() => collection.utils.writeUpsert(fresh))
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

        // Handle real-time events from PocketBase.
        //
        // The write primitives differ in how they treat a key that is absent from
        // the *synced* store (collection._state.syncedData, which is what they
        // validate against — not the optimistic view exposed by collection.has()):
        //   - writeInsert / writeUpsert: idempotent, never throw on an absent key.
        //   - writeDelete: throws DeleteOperationItemNotFoundError on an absent key.
        // So only the delete branch can throw, and we make it idempotent below.
        const handleRealtimeEvent = (event: RecordSubscription<RecordType>) => {
            if (!collection.utils) return
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
                                    collection.utils.writeDelete(
                                        (event.record as { id: string }).id
                                    )
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
        }

        // Start PocketBase real-time subscription
        const startSubscription = async () => {
            if (isSubscribed) return

            // Create promise before starting so waiters can await it
            if (!subscriptionPromise) {
                subscriptionPromise = new Promise<void>(resolve => {
                    subscriptionResolve = resolve
                })
            }

            try {
                unsubscribeFn = await pb
                    .collection(collectionName)
                    .subscribe('*', handleRealtimeEvent)
                isSubscribed = true
                logger.debug('Subscription started', { collectionName })
                // Resolve the promise to notify waiters
                if (subscriptionResolve) {
                    subscriptionResolve()
                }
            } catch (error) {
                logger.error('Failed to start subscription', { collectionName, error })
            }
        }

        // Stop PocketBase real-time subscription
        const stopSubscription = async () => {
            if (!isSubscribed || !unsubscribeFn) return

            try {
                await unsubscribeFn()
                unsubscribeFn = null
                isSubscribed = false
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
            waitForSubscription,
            isSubscribed: () => isSubscribed,
        })

        return collection as unknown as InferCollectionType<Schema, C, Opts>
    }
}
