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
            loadOptions?: ExtendedLoadSubsetOptions
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
                    return queryClient.getQueryData<RecordType[]>([collectionName]) ?? []
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
                    ctx.meta?.loadSubsetOptions as ExtendedLoadSubsetOptions | undefined
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
                          await Promise.all(
                              transaction.mutations.map(async mutation => {
                                  const {
                                      created,
                                      updated,
                                      collectionId,
                                      collectionName: _,
                                      ...data
                                  } = mutation.modified as unknown as Record<string, unknown>
                                  await pb.collection(collectionName).create(data)
                              })
                          )
                          return { refetch: refetchOnMutation }
                      })),
            onUpdate:
                options?.onUpdate === false
                    ? undefined
                    : (options?.onUpdate ??
                      (async ({ transaction }) => {
                          await Promise.all(
                              transaction.mutations.map(async mutation => {
                                  const recordWithId = mutation.original as { id: string }
                                  await pb
                                      .collection(collectionName)
                                      .update(recordWithId.id, mutation.changes)
                              })
                          )
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

        const collection = createTanStackCollection(collectionOptions)

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

            try {
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
