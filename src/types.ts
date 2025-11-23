import type { Collection } from "@tanstack/db"
import type { UnsubscribeFunc } from 'pocketbase';

// ============================================================================
// Schema Type Definitions
// ============================================================================

/**
 * Schema declaration for type-safe collection management.
 * Define your PocketBase collections with their record types and relations.
 *
 * @example
 * ```ts
 * interface MySchema extends SchemaDeclaration {
 *     users: {
 *         type: UserRecord;
 *         relations: {
 *             org: OrgRecord;
 *         };
 *     };
 * }
 * ```
 */
export interface SchemaDeclaration {
    [collectionName: string]: {
        type: object;
        relations?: {
            [fieldName: string]: object | object[];
        };
    };
}

// ============================================================================
// Subscription Types
// ============================================================================

/**
 * PocketBase real-time event structure.
 * Matches RecordSubscription from the PocketBase SDK.
 */
export interface RealtimeEvent<T extends object = object> {
    action: string;
    record: T;
}

/**
 * Internal state tracking for subscription management.
 * Includes reconnection logic and record-specific subscriptions.
 */
export interface SubscriptionState {
    unsubscribe: UnsubscribeFunc;
    recordId?: string;
    reconnectAttempts: number;
    isReconnecting: boolean;
}

/**
 * Enhanced collection interface with subscription management capabilities.
 * Provides methods to control real-time updates from PocketBase.
 */
export interface SubscribableCollection<T extends object = object> {
    /**
     * Subscribe to real-time updates for this collection.
     * @param recordId - Optional: Subscribe to a specific record, or omit for collection-wide updates
     */
    subscribe: (recordId?: string) => Promise<void>;

    /**
     * Unsubscribe from real-time updates.
     * @param recordId - Optional: Unsubscribe from a specific record, or omit for collection-wide
     */
    unsubscribe: (recordId?: string) => void;

    /**
     * Unsubscribe from all subscriptions for this collection.
     */
    unsubscribeAll: () => void;

    /**
     * Check if currently subscribed to updates.
     * @param recordId - Optional: Check a specific record subscription, or omit for collection-wide
     */
    isSubscribed: (recordId?: string) => boolean;

    /**
     * Wait for a subscription to be fully established (useful for testing).
     * @param recordId - Optional record ID
     * @param timeoutMs - Timeout in milliseconds (default: 5000)
     */
    waitForSubscription: (recordId?: string, timeoutMs?: number) => Promise<void>;
}

// ============================================================================
// Collection Enhancement Types
// ============================================================================

/**
 * Join helper for type-safe TanStack DB joins.
 * Provides access to pre-configured relation collections.
 */
export interface JoinHelper<
    Schema extends SchemaDeclaration,
    CollectionName extends keyof Schema,
    RecordType extends object
> {
    /**
     * Get a pre-configured collection for joining a relation field.
     * This returns the related collection that can be used with TanStack DB's .join() method.
     *
     * @param fieldName - The relation field name to join
     * @returns The collection for the related entity, or undefined if not configured
     *
     * @example
     * ```ts
     * const jobsCollection = factory.create('jobs', {
     *     relations: {
     *         customer: customersCollection,
     *         address: addressesCollection
     *     }
     * });
     *
     * // Use with TanStack DB joins
     * const query = q.from({ job: jobsCollection })
     *     .join(
     *         { customer: jobsCollection.relations.customer },
     *         ({ job, customer }) => eq(job.customer, customer.id),
     *         'left'
     *     );
     * ```
     */
    relations: RelationsConfig<Schema, CollectionName>;
}

// ============================================================================
// Schema Extraction Utilities
// ============================================================================

/**
 * Extracts the record type from a schema collection.
 * @internal
 */
export type ExtractRecordType<
    Schema extends SchemaDeclaration,
    CollectionName extends keyof Schema
> = Schema[CollectionName]['type'];

/**
 * Extracts the relations object from a schema collection.
 * Returns never if the collection has no relations defined.
 * @internal
 */
export type ExtractRelations<
    Schema extends SchemaDeclaration,
    CollectionName extends keyof Schema
> = Schema[CollectionName] extends { relations: infer R } ? R : never;

/**
 * Extracts expandable field names from a schema collection.
 * Returns the union of all relation field names that can be expanded.
 * @internal
 */
export type ExpandableFields<
    Schema extends SchemaDeclaration,
    CollectionName extends keyof Schema
> = ExtractRelations<Schema, CollectionName> extends never
    ? never
    : keyof ExtractRelations<Schema, CollectionName> & string;

// ============================================================================
// Expand Type Utilities
// ============================================================================

/**
 * Parses comma-separated relation field names into a union type.
 * Recursively processes "field1,field2,field3" into "field1" | "field2" | "field3".
 *
 * @example
 * ParseExpandFields<"customer,address"> => "customer" | "address"
 * @internal
 */
export type ParseExpandFields<T extends string> =
    T extends `${infer Field},${infer Rest}`
        ? Field | ParseExpandFields<Rest>
        : T;

/**
 * Builds the expand object type based on field names.
 * If expand fields are provided, adds an optional `expand` property with properly typed relations.
 *
 * @example
 * ```ts
 * // Without expand
 * WithExpand<Schema, 'jobs', undefined> => JobRecord
 *
 * // With expand
 * WithExpand<Schema, 'jobs', 'customer'> => JobRecord & {
 *     expand?: { customer?: CustomerRecord }
 * }
 * ```
 */
export type WithExpand<
    Schema extends SchemaDeclaration,
    CollectionName extends keyof Schema,
    ExpandFields extends string | undefined
> = ExpandFields extends string
    ? ExtractRecordType<Schema, CollectionName> & {
        expand?: {
            [K in ParseExpandFields<ExpandFields>]?: K extends keyof ExtractRelations<Schema, CollectionName>
                ? ExtractRelations<Schema, CollectionName>[K] extends Array<infer U>
                    ? U[]  // Array relation
                    : ExtractRelations<Schema, CollectionName>[K]  // Single relation
                : never;
        };
    }
    : ExtractRecordType<Schema, CollectionName>;

// ============================================================================
// Relation Type Utilities
// ============================================================================

/**
 * Removes undefined from a union type.
 * Used to unwrap optional relation types.
 *
 * @example
 * NonNullable<Customer | undefined> => Customer
 * @internal
 */
export type NonNullable<T> = T extends (infer U) | undefined ? U : T;

/**
 * Converts a schema relation type to its corresponding Collection type.
 * Handles both single relations (T) and array relations (T[]).
 *
 * @example
 * RelationAsCollection<Customer> => Collection<Customer>
 * RelationAsCollection<Customer[]> => Collection<Customer>
 * @internal
 */
export type RelationAsCollection<T> =
    T extends Array<infer U>
        ? U extends object ? Collection<U> : Collection<object>
        : T extends object ? Collection<T> : Collection<object>;

/**
 * Configuration for relations - maps field names to their TanStack DB collections.
 * Used to provide pre-configured collections for manual joins.
 *
 * @example
 * ```ts
 * const config: RelationsConfig<Schema, 'jobs'> = {
 *     customer: customersCollection,
 *     address: addressesCollection
 * };
 * ```
 */
export type RelationsConfig<
    Schema extends SchemaDeclaration,
    CollectionName extends keyof Schema
> = ExtractRelations<Schema, CollectionName> extends never
    ? Record<string, never>
    : Partial<{
        [K in keyof ExtractRelations<Schema, CollectionName>]: RelationAsCollection<
            NonNullable<ExtractRelations<Schema, CollectionName>[K]>
        >;
    }>;

// ============================================================================
// Configuration Options
// ============================================================================

/**
 * Options for creating a collection with optional expand and relations.
 */
export interface CreateCollectionOptions<
    Schema extends SchemaDeclaration,
    CollectionName extends keyof Schema,
    Expand extends string | undefined = undefined
> {
    /**
     * Pre-configured relation collections for manual TanStack DB joins.
     *
     * @example
     * ```ts
     * const jobsCollection = factory.create('jobs', {
     *     relations: {
     *         customer: customersCollection,
     *         address: addressesCollection
     *     }
     * });
     * ```
     */
    relations?: RelationsConfig<Schema, CollectionName>;

    /**
     * Relation fields to auto-expand from PocketBase.
     * Can be a single field or comma-separated list.
     * For best type inference, use `as const` when providing comma-separated strings.
     *
     * @example
     * ```ts
     * // Single relation
     * const jobsCollection = factory.create('jobs', {
     *     expand: 'customer'  // Type inference works automatically
     * });
     *
     * // Multiple relations with type inference
     * const jobsCollection = factory.create('jobs', {
     *     expand: 'customer,address' as const  // `as const` gives proper typing
     * });
     * ```
     */
    expand?: Expand;
}
