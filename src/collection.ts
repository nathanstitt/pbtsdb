import PocketBase from "pocketbase";
import type { RecordSubscription } from "pocketbase";
import {
    createCollection as createTanStackCollection,
    type Collection,
    type LoadSubsetOptions,
} from "@tanstack/react-db";
import { queryCollectionOptions, type QueryCollectionUtils } from "@tanstack/query-db-collection";
import { QueryClient } from "@tanstack/react-query";
import { convertToPocketBaseFilter, convertToPocketBaseSort } from "./pocketbase-query-converter";
import type {
    SchemaDeclaration,
    CreateCollectionOptions,
    ExtractRecordType,
    ExpandTargetCollection,
    BaseRecord,
} from "./types";
import { logger } from "./logger";

export type { SchemaDeclaration, CreateCollectionOptions, BaseRecord } from "./types";

/**
 * Extended LoadSubsetOptions that includes PocketBase-specific expand parameter.
 * @internal
 */
type ExtendedLoadSubsetOptions = LoadSubsetOptions & {
    pbExpand?: string;
};

/**
 * Compute the record type with expand property when expand option is configured.
 * @internal
 */
type WithExpandFromConfig<Schema extends SchemaDeclaration, C extends keyof Schema, Opts> = Opts extends {
    expand: infer E;
}
    ? ExtractRecordType<Schema, C> & {
          expand?: {
              [K in keyof E]: K extends keyof import("./types").ExtractRelations<Schema, C>
                  ? import("./types").ExtractRelations<Schema, C>[K] extends Array<infer U>
                      ? U[]
                      : import("./types").ExtractRelations<Schema, C>[K]
                  : never;
          };
      }
    : ExtractRecordType<Schema, C>;

/**
 * Subscription helpers added to collection instances.
 * @internal
 */
interface CollectionSubscriptionHelpers {
    /** The PocketBase collection name */
    collectionName: string;
    /** Wait for subscription to be established (useful in tests) */
    waitForSubscription: (timeout?: number) => Promise<void>;
    /** Check if collection has an active subscription */
    isSubscribed: () => boolean;
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
    QueryCollectionUtils<WithExpandFromConfig<Schema, C, Opts>, string | number, WithExpandFromConfig<Schema, C, Opts>>,
    // TSchema - we don't use StandardSchema validation
    never,
    Opts extends {
        omitOnInsert: infer O extends readonly import("./types").OmittableFields<ExtractRecordType<Schema, C>>[];
    }
        ? import("./types").ComputeInsertType<ExtractRecordType<Schema, C>, O>
        : ExtractRecordType<Schema, C>
> &
    CollectionSubscriptionHelpers;

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
export function createCollection<Schema extends SchemaDeclaration>(pb: PocketBase, queryClient: QueryClient) {
    return <
        C extends keyof Schema & string,
        Opts extends CreateCollectionOptions<Schema, C> = CreateCollectionOptions<Schema, C>,
    >(
        collectionName: C,
        options?: Opts,
    ): InferCollectionType<Schema, C, Opts> => {
        type RecordType = ExtractRecordType<Schema, C>;
        const expandStores = options?.expand as Record<string, ExpandTargetCollection> | undefined;
        const expandString = expandStores ? Object.keys(expandStores).sort().join(",") : undefined;

        const ignoreAutoCancellation = options?.ignoreAutoCancellation ?? true;

        async function fetchRecords(loadOptions?: ExtendedLoadSubsetOptions): Promise<RecordType[]> {
            const filter = convertToPocketBaseFilter(loadOptions?.where);
            const sort = convertToPocketBaseSort(loadOptions?.orderBy);
            const limit = loadOptions?.limit;

            let items: RecordType[];
            try {
                if (limit) {
                    // Use getList when limit is specified to avoid fetching all records
                    const result = await pb.collection(collectionName).getList(1, limit, {
                        filter,
                        sort,
                        skipTotal: true, // Optimize by skipping total count
                        expand: expandString,
                    });
                    items = result.items as unknown as RecordType[];
                } else {
                    // Use getFullList to fetch all records with automatic pagination
                    items = (await pb.collection(collectionName).getFullList({
                        filter,
                        sort,
                        expand: expandString,
                    })) as unknown as RecordType[];
                }
            } catch (error) {
                if (ignoreAutoCancellation && error instanceof Error && error.message.includes("autocancelled")) {
                    return queryClient.getQueryData<RecordType[]>([collectionName]) ?? [];
                }
                throw error;
            }

            if (expandStores) {
                for (const record of items) {
                    const expandData = (record as RecordType & { expand?: Record<string, object | object[]> }).expand;
                    if (!expandData) continue;

                    for (const [key, value] of Object.entries(expandData)) {
                        const targetStore = expandStores[key];
                        if (!targetStore.utils) continue;
                        if (!targetStore.isReady()) {
                            if (targetStore.config?.syncMode === "on-demand") {
                                await targetStore._sync.startSync();
                            } else {
                                logger.warn(`not syncing ${key} on ${collectionName} because store is not yet ready`);
                                continue;
                            }
                        }
                        const values = Array.isArray(value) ? value : [value];
                        targetStore.utils.writeUpsert(values);
                    }
                }
            }

            return items;
        }

        const collectionOptions = queryCollectionOptions({
            queryClient,
            queryKey: [collectionName],
            syncMode: options?.syncMode ?? "eager",
            queryFn: async (ctx): Promise<RecordType[]> => {
                return fetchRecords(ctx.meta?.loadSubsetOptions as ExtendedLoadSubsetOptions | undefined);
            },
            getKey: (item: RecordType) => {
                const record = item as any;
                if (!record || typeof record !== "object" || !("id" in record)) {
                    throw new Error(
                        `Record in collection '${collectionName}' is missing required 'id' field. Received: ${JSON.stringify(item)}`,
                    );
                }
                return record.id;
            },
            onInsert:
                options?.onInsert === false
                    ? undefined
                    : (options?.onInsert ??
                      (async ({ transaction }) => {
                          await Promise.all(
                              transaction.mutations.map(async (mutation) => {
                                  const {
                                      created,
                                      updated,
                                      collectionId,
                                      collectionName: _,
                                      ...data
                                  } = mutation.modified as unknown as Record<string, unknown>;
                                  await pb.collection(collectionName).create(data);
                              }),
                          );
                      })),
            onUpdate:
                options?.onUpdate === false
                    ? undefined
                    : (options?.onUpdate ??
                      (async ({ transaction }) => {
                          await Promise.all(
                              transaction.mutations.map(async (mutation) => {
                                  const recordWithId = mutation.original as { id: string };
                                  await pb.collection(collectionName).update(recordWithId.id, mutation.changes);
                              }),
                          );
                      })),
            onDelete:
                options?.onDelete === false
                    ? undefined
                    : (options?.onDelete ??
                      (async ({ transaction }) => {
                          await Promise.all(
                              transaction.mutations.map(async (mutation) => {
                                  const recordWithId = mutation.original as { id: string };
                                  await pb.collection(collectionName).delete(recordWithId.id);
                              }),
                          );
                      })),
        });

        const collection = createTanStackCollection(collectionOptions);

        // Real-time subscription state
        let unsubscribeFn: (() => Promise<void>) | null = null;
        let isSubscribed = false;
        let subscriptionPromise: Promise<void> | null = null;
        let subscriptionResolve: (() => void) | null = null;

        // Handle real-time events from PocketBase
        const handleRealtimeEvent = (event: RecordSubscription<RecordType>) => {
            if (!collection.utils) return;

            collection.utils.writeBatch(() => {
                switch (event.action) {
                    case "create":
                        collection.utils.writeInsert(event.record);
                        break;
                    case "update":
                        collection.utils.writeUpsert(event.record);
                        break;
                    case "delete":
                        if (event.record && "id" in event.record) {
                            collection.utils.writeDelete((event.record as { id: string }).id);
                        }
                        break;
                }
            });
        };

        // Start PocketBase real-time subscription
        const startSubscription = async () => {
            if (isSubscribed) return;

            // Create promise before starting so waiters can await it
            if (!subscriptionPromise) {
                subscriptionPromise = new Promise<void>((resolve) => {
                    subscriptionResolve = resolve;
                });
            }

            try {
                unsubscribeFn = await pb.collection(collectionName).subscribe("*", handleRealtimeEvent);
                isSubscribed = true;
                logger.debug("Subscription started", { collectionName });
                // Resolve the promise to notify waiters
                if (subscriptionResolve) {
                    subscriptionResolve();
                }
            } catch (error) {
                logger.error("Failed to start subscription", { collectionName, error });
            }
        };

        // Stop PocketBase real-time subscription
        const stopSubscription = async () => {
            if (!isSubscribed || !unsubscribeFn) return;

            try {
                await unsubscribeFn();
                unsubscribeFn = null;
                isSubscribed = false;
                // Reset promise for next subscription cycle
                subscriptionPromise = null;
                subscriptionResolve = null;
                logger.debug("Subscription stopped", { collectionName });
            } catch (error) {
                logger.debug("Unsubscribe failed (expected if connection closed)", { collectionName, error });
            }
        };

        // Wait for subscription to be established (for testing)
        const waitForSubscription = async (timeout = 5000): Promise<void> => {
            if (isSubscribed) return;

            if (!subscriptionPromise) {
                // No subscription in progress, wait for one to start
                await new Promise<void>((resolve) => {
                    const checkInterval = setInterval(() => {
                        if (subscriptionPromise) {
                            clearInterval(checkInterval);
                            resolve();
                        }
                    }, 10);
                    setTimeout(() => {
                        clearInterval(checkInterval);
                        resolve();
                    }, timeout);
                });
            }

            if (subscriptionPromise) {
                await Promise.race([
                    subscriptionPromise,
                    new Promise<void>((_, reject) =>
                        setTimeout(() => reject(new Error("Subscription timeout")), timeout),
                    ),
                ]);
            }
        };

        // Manage subscription based on collection subscriber count
        collection.on("subscribers:change", (event: { subscriberCount: number; previousSubscriberCount: number }) => {
            const newCount = event.subscriberCount;
            const previousCount = event.previousSubscriberCount;

            if (newCount > 0 && previousCount === 0) {
                // First subscriber - start real-time subscription
                startSubscription().catch(() => {});
            } else if (newCount === 0 && previousCount > 0) {
                // Last subscriber removed - stop real-time subscription
                stopSubscription().catch(() => {});
            }
        });

        // Add collectionName and subscription helpers
        Object.assign(collection, {
            collectionName,
            waitForSubscription,
            isSubscribed: () => isSubscribed,
        });

        return collection as any;
    };
}
