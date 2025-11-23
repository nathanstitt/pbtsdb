import PocketBase from 'pocketbase';
import { createCollection, type Collection } from "@tanstack/db"
import { queryCollectionOptions } from "@tanstack/query-db-collection"
import { QueryClient } from '@tanstack/react-query'
import { SubscriptionManager } from './subscription-manager';
import type {
    SchemaDeclaration,
    SubscribableCollection,
    JoinHelper,
    CreateCollectionOptions,
    RelationsConfig,
    WithExpand,
} from './types';

export type {
    SchemaDeclaration,
    SubscribableCollection,
    JoinHelper,
    CreateCollectionOptions,
    RelationsConfig,
} from './types';

export {
    CollectionsProvider,
    useStore,
    useStores,
    type CollectionsMap,
    type CollectionsProviderProps,
} from './provider';

/**
 * Factory for creating type-safe TanStack DB collections backed by PocketBase.
 * Integrates real-time subscriptions with automatic synchronization.
 */
export class CollectionFactory<Schema extends SchemaDeclaration, TMaxDepth extends 0 | 1 | 2 | 3 | 4 | 5 | 6 = 2> {
    private subscriptionManager: SubscriptionManager;

    constructor(public pocketbase: PocketBase, public queryClient: QueryClient) {
        this.subscriptionManager = new SubscriptionManager(pocketbase);
    }

    /**
     * Setup automatic subscription lifecycle management.
     * Hooks into TanStack DB's subscriber events to manage real-time subscriptions.
     */
    private setupSubscriptionLifecycle<T extends object>(
        collectionName: string,
        baseCollection: Collection<T>
    ): void {
        baseCollection.on('subscribers:change', (event) => {
            const newCount = event.subscriberCount;
            const previousCount = event.previousSubscriberCount;

            if (newCount > previousCount) {
                // Fire and forget - subscription handled asynchronously
                this.subscriptionManager.addSubscriber(collectionName, baseCollection).catch(() => {
                    // Silently handle subscription errors - reconnection will be attempted
                });
            } else if (newCount < previousCount) {
                this.subscriptionManager.removeSubscriber(collectionName);
            }
        });
    }

    /**
     * Create a TanStack DB collection from a PocketBase collection.
     *
     * Collections are lazy by default - they don't fetch data or subscribe until queried.
     * Real-time subscriptions automatically start when the first query becomes active
     * and stop when the last query unmounts (with a cleanup delay to prevent thrashing).
     *
     * @param collection - The name of the collection
     * @param options - Optional configuration including relations and expand
     *
     * @example
     * Basic usage with automatic lifecycle management:
     * ```ts
     * const jobsCollection = factory.create('jobs');
     *
     * // In your component - subscription starts automatically
     * const { data } = useLiveQuery((q) =>
     *     q.from({ jobs: jobsCollection })
     * );
     * // Subscription stops automatically when component unmounts
     * ```
     *
     * @example
     * With query operators (filters, sorting):
     * ```ts
     * const jobsCollection = factory.create('jobs');
     *
     * // In your component:
     * const { data } = useLiveQuery((q) =>
     *     q.from({ jobs: jobsCollection })
     *      .where(({ jobs }) => and(
     *          eq(jobs.status, 'ACTIVE'),
     *          gt(jobs.created, new Date('2025-01-01'))
     *      ))
     *      .orderBy(({ jobs }) => jobs.created, 'desc')
     * );
     * ```
     *
     * @example
     * With relation expansion:
     * ```ts
     * const jobsCollection = factory.create('jobs', {
     *     expand: 'customer,location'
     * });
     *
     * // Expanded relations available in record.expand
     * ```
     *
     * @example
     * With relations (for manual joins):
     * ```ts
     * const customersCollection = factory.create('customers');
     * const jobsCollection = factory.create('jobs', {
     *     relations: { customer: customersCollection }
     * });
     *
     * // In your component, manually build joins:
     * const { data } = useLiveQuery((q) =>
     *     q.from({ job: jobsCollection })
     *      .join(
     *          { customer: customersCollection },
     *          ({ job, customer }) => eq(job.customer, customer.id),
     *          "left"
     *      )
     *      .select(({ job, customer }) => ({
     *          ...job,
     *          expand: {
     *              customer: customer ? { ...customer } : undefined
     *          }
     *      }))
     * );
     * ```
     *
     * @example
     * Manual subscription control (advanced):
     * ```ts
     * const jobsCollection = factory.create('jobs');
     *
     * // Manually subscribe to specific record (bypasses automatic lifecycle)
     * await jobsCollection.subscribe('record_id_123');
     *
     * // Check subscription status
     * const isSubbed = jobsCollection.isSubscribed('record_id_123');
     *
     * // Manually unsubscribe
     * jobsCollection.unsubscribe('record_id_123');
     * ```
     */
    create<
        C extends keyof Schema & string,
        E extends string | undefined = undefined
    >(
        collection: C,
        options?: CreateCollectionOptions<Schema, C, E>
    ): Collection<WithExpand<Schema, C, E>> & SubscribableCollection<WithExpand<Schema, C, E>> & JoinHelper<Schema, C, WithExpand<Schema, C, E>> {
        type RecordType = WithExpand<Schema, C, E>;

        const baseCollection = createCollection(
            queryCollectionOptions<RecordType>({
                queryKey: [collection],
                queryFn: async () => {
                    const queryOptions: { expand?: string } = {};
                    if (options?.expand) {
                        queryOptions.expand = options.expand;
                    }

                    const result = await this.pocketbase
                        .collection(collection)
                        .getFullList(queryOptions);

                    return result as unknown as RecordType[];
                },
                queryClient: this.queryClient,
                getKey: (item: RecordType) => (item as { id: string }).id,
                startSync: options?.startSync ?? false,
                onInsert: options?.onInsert === false ? undefined : options?.onInsert ?? (async ({ transaction }) => {
                    await Promise.all(
                        transaction.mutations.map(async (mutation) => {
                            const { id, created, updated, collectionId, collectionName, ...data } = mutation.modified as Record<string, unknown>;
                            await this.pocketbase.collection(collection).create(data);
                        })
                    );
                    await this.queryClient.invalidateQueries({ queryKey: [collection] });
                }),
                onUpdate: options?.onUpdate === false ? undefined : options?.onUpdate ?? (async ({ transaction }) => {
                    await Promise.all(
                        transaction.mutations.map(async (mutation) => {
                            const recordWithId = mutation.original as { id: string };
                            await this.pocketbase.collection(collection).update(recordWithId.id, mutation.changes);
                        })
                    );
                    await this.queryClient.invalidateQueries({ queryKey: [collection] });
                }),
                onDelete: options?.onDelete === false ? undefined : options?.onDelete ?? (async ({ transaction }) => {
                    await Promise.all(
                        transaction.mutations.map(async (mutation) => {
                            const recordWithId = mutation.original as { id: string };
                            await this.pocketbase.collection(collection).delete(recordWithId.id);
                        })
                    );
                    await this.queryClient.invalidateQueries({ queryKey: [collection] });
                }),
            })
        );

        const subscribableCollection = Object.assign(baseCollection, {
            subscribe: async (recordId?: string) => {
                await this.subscriptionManager.subscribe(collection, baseCollection, recordId);
            },
            unsubscribe: (recordId?: string) => {
                this.subscriptionManager.unsubscribe(collection, recordId);
            },
            unsubscribeAll: () => {
                this.subscriptionManager.unsubscribeAll(collection);
            },
            isSubscribed: (recordId?: string) => {
                return this.subscriptionManager.isSubscribed(collection, recordId);
            },
            waitForSubscription: async (recordId?: string, timeoutMs?: number) => {
                await this.subscriptionManager.waitForSubscription(collection, recordId, timeoutMs);
            },
            relations: options?.relations || {} as RelationsConfig<Schema, C>
        });

        this.setupSubscriptionLifecycle(collection, baseCollection);

        return subscribableCollection as Collection<RecordType> & SubscribableCollection<RecordType> & JoinHelper<Schema, C, RecordType>;
    }
}
