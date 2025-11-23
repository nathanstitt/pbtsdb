import PocketBase from 'pocketbase';
import type { UnsubscribeFunc } from 'pocketbase';
import { createCollection, type Collection } from "@tanstack/db"
import { queryCollectionOptions } from "@tanstack/query-db-collection"
import { QueryClient } from '@tanstack/react-query'
import { convertToPocketBaseFilter, convertToPocketBaseSort } from './query-converter';

export interface SchemaDeclaration {
    [collectionName: string]: {
        type: any;
        relations?: any;
    };
}

// PocketBase real-time event structure (matches RecordSubscription from pocketbase SDK)
interface RealtimeEvent<T = Record<string, any>> {
    action: string;
    record: T;
}

// Subscription state tracking
interface SubscriptionState {
    unsubscribe: UnsubscribeFunc;
    recordId?: string;
    reconnectAttempts: number;
    isReconnecting: boolean;
}

// Enhanced collection with subscription management
export interface SubscribableCollection<T = any> {
    subscribe: (recordId?: string) => void;
    unsubscribe: (recordId?: string) => void;
    unsubscribeAll: () => void;
    isSubscribed: (recordId?: string) => boolean;
}

// Type utility to extract the record type from a schema collection
type ExtractRecordType<Schema extends SchemaDeclaration, CollectionName extends keyof Schema> = Schema[CollectionName]['type'];

// Type utility to extract relations from schema
type ExtractRelations<Schema extends SchemaDeclaration, CollectionName extends keyof Schema> =
    Schema[CollectionName] extends { relations: infer R } ? R : never;

// Configuration for relations - maps field names to their collections
export type RelationsConfig<Schema extends SchemaDeclaration, CollectionName extends keyof Schema> = {
    [K in keyof ExtractRelations<Schema, CollectionName>]?: Collection<any>;
};

// Options for creating a collection
export interface CreateCollectionOptions<Schema extends SchemaDeclaration, CollectionName extends keyof Schema> {
    relations?: RelationsConfig<Schema, CollectionName>;
    /**
     * Comma-separated list of relation fields to auto-expand.
     * Example: "customer,location" or "user.org"
     */
    expand?: string;
}


// export declare class PocketBaseTS<TSchema extends SchemaDeclaration, TMaxDepth extends 0 | 1 | 2 | 3 | 4 | 5 | 6 = 2> extends PocketBase {
//     #private;
//     constructor(baseUrl?: string, authStore?: BaseAuthStore | null, lang?: string);
//     collection<TName extends (keyof TSchema & string) | (string & {})>(idOrName: TName): RecordServiceTS<TSchema, TName, TMaxDepth>;
//     createBatch(): BatchServiceTS<TSchema>;
// }


export class CollectionFactory<Schema extends SchemaDeclaration, TMaxDepth extends 0 | 1 | 2 | 3 | 4 | 5 | 6 = 2> {
    private subscriptions: Map<string, Map<string, SubscriptionState>> = new Map();
    private readonly MAX_RECONNECT_ATTEMPTS = 5;
    private readonly BASE_RECONNECT_DELAY = 1000; // 1 second

    constructor(public pocketbase: PocketBase, public queryClient: QueryClient){ }

    /**
     * Setup real-time subscription for a collection
     */
    private async setupSubscription<T extends object = any>(
        collectionName: string,
        collection: Collection<T>,
        recordId?: string
    ): Promise<UnsubscribeFunc> {
        const subscriptionKey = recordId || '*';

        const eventHandler = (event: RealtimeEvent<T>) => {
            // Use direct writes to sync changes to TanStack DB
            collection.utils.writeBatch(() => {
                switch (event.action) {
                    case 'create':
                        collection.utils.writeInsert(event.record);
                        break;
                    case 'update':
                        collection.utils.writeUpdate(event.record);
                        break;
                    case 'delete':
                        collection.utils.writeDelete((event.record as any).id);
                        break;
                }
            });
        };

        // Subscribe to PocketBase real-time updates
        return await this.pocketbase
            .collection(collectionName)
            .subscribe(subscriptionKey, eventHandler);
    }

    /**
     * Handle reconnection with exponential backoff
     */
    private async handleReconnection<T extends object = any>(
        collectionName: string,
        collection: Collection<T>,
        recordId?: string
    ): Promise<void> {
        const collectionSubs = this.subscriptions.get(collectionName);
        if (!collectionSubs) return;

        const subscriptionKey = recordId || '*';
        const state = collectionSubs.get(subscriptionKey);
        if (!state || state.isReconnecting) return;

        state.isReconnecting = true;

        while (state.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
            const delay = this.BASE_RECONNECT_DELAY * Math.pow(2, state.reconnectAttempts);
            await new Promise(resolve => setTimeout(resolve, delay));

            try {
                // Attempt to resubscribe
                const newUnsubscribe = await this.setupSubscription(
                    collectionName,
                    collection,
                    recordId
                );

                state.unsubscribe = newUnsubscribe;
                state.reconnectAttempts = 0;
                state.isReconnecting = false;
                return;
            } catch (error) {
                state.reconnectAttempts++;
            }
        }

        // Max attempts reached, give up
        state.isReconnecting = false;
        collectionSubs.delete(subscriptionKey);
    }

    /**
     * Subscribe to real-time updates for a collection
     */
    private subscribeToCollection<T extends object = any>(
        collectionName: string,
        collection: Collection<T>,
        recordId?: string
    ): void {
        if (!this.subscriptions.has(collectionName)) {
            this.subscriptions.set(collectionName, new Map());
        }

        const collectionSubs = this.subscriptions.get(collectionName)!;
        const subscriptionKey = recordId || '*';

        // Don't subscribe if already subscribed
        if (collectionSubs.has(subscriptionKey)) {
            return;
        }

        // Create a placeholder subscription state immediately (synchronous)
        // This ensures isSubscribed() returns true right away
        const placeholderUnsubscribe = async () => { /* will be replaced */ };
        collectionSubs.set(subscriptionKey, {
            unsubscribe: placeholderUnsubscribe,
            recordId,
            reconnectAttempts: 0,
            isReconnecting: false,
        });

        // Setup subscription asynchronously
        this.setupSubscription(collectionName, collection, recordId).then((unsubscribe) => {
            // Replace placeholder with actual unsubscribe function
            const state = collectionSubs.get(subscriptionKey);
            if (state) {
                state.unsubscribe = unsubscribe;
            }
        }).catch((error) => {
            // Remove placeholder on error
            collectionSubs.delete(subscriptionKey);
            // Handle subscription error - try to reconnect
            this.handleReconnection(collectionName, collection, recordId);
        });

        // Setup auto-reconnect on SSE disconnect (5-minute timeout)
        // Note: PocketBase doesn't expose disconnect events, so we monitor via
        // periodic health checks or rely on error handling in subscription
        const checkInterval = setInterval(() => {
            const state = collectionSubs.get(subscriptionKey);
            if (!state) {
                clearInterval(checkInterval);
                return;
            }

            // If subscription is still active, no action needed
            // In production, you might want to implement a heartbeat check
        }, 60000); // Check every minute
    }

    /**
     * Unsubscribe from real-time updates
     */
    private unsubscribeFromCollection(collectionName: string, recordId?: string): void {
        const collectionSubs = this.subscriptions.get(collectionName);
        if (!collectionSubs) return;

        const subscriptionKey = recordId || '*';
        const state = collectionSubs.get(subscriptionKey);

        if (state) {
            state.unsubscribe();
            collectionSubs.delete(subscriptionKey);
        }

        // Clean up collection map if empty
        if (collectionSubs.size === 0) {
            this.subscriptions.delete(collectionName);
        }
    }

    /**
     * Unsubscribe from all subscriptions for a collection
     */
    private unsubscribeAll(collectionName: string): void {
        const collectionSubs = this.subscriptions.get(collectionName);
        if (!collectionSubs) return;

        for (const state of collectionSubs.values()) {
            state.unsubscribe();
        }

        this.subscriptions.delete(collectionName);
    }

    /**
     * Check if subscribed to a collection
     */
    private isSubscribed(collectionName: string, recordId?: string): boolean {
        const collectionSubs = this.subscriptions.get(collectionName);
        if (!collectionSubs) return false;

        const subscriptionKey = recordId || '*';
        return collectionSubs.has(subscriptionKey);
    }

    /**
     * Create a TanStack DB collection from a PocketBase collection.
     *
     * @param collection - The name of the collection
     * @param options - Optional configuration including relations and expand
     *
     * @example
     * Basic usage with automatic real-time subscription:
     * ```ts
     * const jobsCollection = factory.create('jobs');
     * // Automatically subscribed to all changes
     * ```
     *
     * @example
     * Manual subscription control:
     * ```ts
     * const jobsCollection = factory.create('jobs');
     *
     * // Subscribe to specific record
     * jobsCollection.subscribe('record_id_123');
     *
     * // Unsubscribe from specific record
     * jobsCollection.unsubscribe('record_id_123');
     *
     * // Unsubscribe from all
     * jobsCollection.unsubscribeAll();
     *
     * // Check subscription status
     * const isSubbed = jobsCollection.isSubscribed(); // collection-wide
     * const isSubbed2 = jobsCollection.isSubscribed('record_id_123'); // specific record
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
     */
    create<C extends keyof Schema & string>(
        collection: C,
        options?: CreateCollectionOptions<Schema, C>
    ): Collection<ExtractRecordType<Schema, C>> & SubscribableCollection<ExtractRecordType<Schema, C>> {
        type RecordType = ExtractRecordType<Schema, C>;

        const baseCollection = createCollection(
            queryCollectionOptions<RecordType>({
                queryKey: [collection],
                syncMode: 'on-demand', // Enable predicate push-down to PocketBase
                queryFn: async (ctx) => {
                    // Extract TanStack DB query parameters
                    const { where, orderBy, limit } = ctx.meta?.loadSubsetOptions || {};

                    // Convert TanStack DB query language to PocketBase syntax
                    const filter = convertToPocketBaseFilter(where);
                    const sort = convertToPocketBaseSort(orderBy);

                    // Build PocketBase query options
                    const queryOptions: Record<string, any> = {};

                    if (filter) {
                        queryOptions.filter = filter;
                    }

                    if (sort) {
                        queryOptions.sort = sort;
                    }

                    if (limit) {
                        queryOptions.perPage = limit;
                    }

                    if (options?.expand) {
                        queryOptions.expand = options.expand;
                    }

                    // Execute query against PocketBase
                    const result = await this.pocketbase
                        .collection(collection)
                        .getFullList(queryOptions);

                    return result as unknown as RecordType[];
                },
                queryClient: this.queryClient,
                getKey: (item: RecordType) => (item as any).id as string,
            })
        );

        // Enhance collection with subscription management methods
        const subscribableCollection = Object.assign(baseCollection, {
            subscribe: (recordId?: string) => {
                this.subscribeToCollection(collection, baseCollection, recordId);
            },
            unsubscribe: (recordId?: string) => {
                this.unsubscribeFromCollection(collection, recordId);
            },
            unsubscribeAll: () => {
                this.unsubscribeAll(collection);
            },
            isSubscribed: (recordId?: string) => {
                return this.isSubscribed(collection, recordId);
            }
        });

        // Automatically subscribe to collection-wide updates on creation
        this.subscribeToCollection(collection, baseCollection);

        return subscribableCollection as Collection<RecordType> & SubscribableCollection<RecordType>;
    }
}
