import type { Collection, InsertMutationFn, UpdateMutationFn, DeleteMutationFn } from "@tanstack/db"

// ============================================================================
// Schema Type Definitions
// ============================================================================

/**
 * Base record type required by PocketBase collections.
 * All records must have an 'id' field.
 */
export interface BaseRecord {
    id: string;
}

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
        type: BaseRecord;
        relations?: {
            [fieldName: string]: BaseRecord | BaseRecord[];
        };
    };
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
 * Valid field names that can be omitted during insert operations.
 * Excludes 'id' which is always required for TanStack DB record tracking.
 * @internal
 */
export type OmittableFields<T extends object> = Exclude<keyof T, 'id'>;

/**
 * Computes the insert input type by making specified fields optional.
 * Used to support omitting server-generated fields (created, updated) during insertion.
 *
 * IMPORTANT: The 'id' field can NEVER be omitted as TanStack DB requires it for record tracking.
 *
 * @example
 * ```ts
 * type BookInsert = ComputeInsertType<Books, ['created', 'updated']>
 * // Result: Omit<Books, 'created' | 'updated'> & Partial<Pick<Books, 'created' | 'updated'>>
 * ```
 * @internal
 */
export type ComputeInsertType<
    T extends object,
    OmitFields extends readonly OmittableFields<T>[]
> = Omit<T, OmitFields[number]> & Partial<Pick<T, OmitFields[number]>>;

/**
 * Extracts the relations object from a schema collection.
 * Returns never if the collection has no relations defined.
 * @internal
 */
export type ExtractRelations<
    Schema extends SchemaDeclaration,
    CollectionName extends keyof Schema
> = Schema[CollectionName] extends { relations: infer R } ? R : never;

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
 * ExcludeUndefined<Customer | undefined> => Customer
 * @internal
 */
export type ExcludeUndefined<T> = T extends (infer U) | undefined ? U : T;

/**
 * Converts a schema relation type to its corresponding Collection constraint.
 * Handles both single relations (T) and array relations (T[]).
 * Accepts collections with any insert type to support omitOnInsert configurations.
 *
 * Uses constraint (extends Collection<T, ...>) rather than exact type to allow
 * collections with different TInput types (from omitOnInsert) to be compatible.
 *
 * @example
 * RelationAsCollection<Customer> => Collection<Customer, string | number, any, any, any>
 * RelationAsCollection<Customer[]> => Collection<Customer, string | number, any, any, any>
 * @internal
 */
export type RelationAsCollection<T> =
    T extends Array<infer U>
        ? U extends object ? Collection<U, string | number, any, any, any> : Collection<object, string | number, any, any, any>
        : T extends object ? Collection<T, string | number, any, any, any> : Collection<object, string | number, any, any, any>;


/**
 * Configuration for per-collection expand - maps relation field names to their target collections.
 * Relations configured here are automatically expanded on every fetch and auto-upserted into target collections.
 *
 * @example
 * ```ts
 * const authorsCollection = createCollection<Schema>(pb, queryClient)('authors');
 * const booksCollection = createCollection<Schema>(pb, queryClient)('books', {
 *     expand: {
 *         author: authorsCollection  // Always expand 'author', upsert into authorsCollection
 *     }
 * });
 * ```
 */
export type ExpandConfig<
    Schema extends SchemaDeclaration,
    CollectionName extends keyof Schema
> = ExtractRelations<Schema, CollectionName> extends never
    ? Record<string, never>
    : Partial<{
        [K in keyof ExtractRelations<Schema, CollectionName>]: RelationAsCollection<
            ExcludeUndefined<ExtractRelations<Schema, CollectionName>[K]>
        >;
    }>;

/**
 * Runtime representation of a collection that can receive upserted expand data.
 * This is the minimal interface needed for the LoaderHost to insert expanded records.
 * @internal
 */
export interface ExpandTargetCollection {
    utils?: {
        writeUpsert: (records: object[]) => void;
    };
    isReady: () => boolean;
    _sync: {
        startSync: () => Promise<void>;
    };
    config?: {
        syncMode?: 'eager' | 'on-demand';
    };
}

/**
 * Maps expandable field names to their target collections for runtime use.
 * Used by LoaderHost to insert expanded records into their respective collections.
 * @internal
 */
export type ExpandableStoresConfig<
    Schema extends SchemaDeclaration,
    CollectionName extends keyof Schema
> = ExtractRelations<Schema, CollectionName> extends never
    ? Record<string, never>
    : Partial<{
        [K in keyof ExtractRelations<Schema, CollectionName>]: ExpandTargetCollection;
    }>;

// ============================================================================
// Configuration Options
// ============================================================================

/**
 * Options for creating a collection.
 */
export interface CreateCollectionOptions<
    Schema extends SchemaDeclaration,
    CollectionName extends keyof Schema
> {
    /**
     * Configure relations to automatically expand on every fetch.
     * Maps relation field names to their target collections for auto-upsert.
     *
     * Expanded records are automatically inserted into their target collections.
     *
     * @example
     * ```ts
     * const authorsCollection = createCollection<Schema>(pb, queryClient)('authors');
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
    expand?: ExpandConfig<Schema, CollectionName>;

    /**
     * Fields that can be omitted during insert operations.
     * Useful for server-generated fields like 'created', 'updated'.
     *
     * When specified, the insert() method will accept records without these fields,
     * and the omitted fields become optional in the insert input type.
     *
     * **Type safety:** Only valid field names from the record type are accepted.
     * **IMPORTANT:** The 'id' field can NEVER be omitted as TanStack DB requires it.
     *
     * @example
     * ```ts
     * // Allow inserting without created, updated (server-generated timestamps)
     * const booksCollection = createCollection<Schema>(pb, queryClient)('books', {
     *     omitOnInsert: ['created', 'updated'] as const
     * });
     *
     * // Now insert() accepts records without those fields
     * booksCollection.insert({
     *     id: newRecordId(),  // id is always required
     *     title: 'New Book',
     *     isbn: '1234567890',
     *     genre: 'Fiction',
     *     author: authorId
     *     // created, updated are optional
     * });
     * ```
     */
    omitOnInsert?: readonly OmittableFields<ExtractRecordType<Schema, CollectionName>>[];

    /**
     * Custom handler for insert mutations.
     *
     * **Default behavior (not provided):** Automatically creates records in PocketBase,
     * excluding auto-generated fields (id, created, updated, collectionId, collectionName).
     *
     * **Custom handler:** Provide your own handler to customize insert behavior.
     *
     * **Disable:** Set to `false` to disable insert mutations entirely (will throw error if insert is called).
     *
     * @example
     * ```ts
     * // Use default automatic handler (recommended)
     * const collection = createCollection<Schema>(pb, queryClient)('books');
     *
     * // Custom handler
     * const collection = createCollection<Schema>(pb, queryClient)('books', {
     *     onInsert: async ({ transaction }) => {
     *         for (const mutation of transaction.mutations) {
     *             await customInsertLogic(mutation.modified);
     *         }
     *         await queryClient.invalidateQueries({ queryKey: ['books'] });
     *     }
     * });
     *
     * // Disable inserts (read-only collection)
     * const collection = createCollection<Schema>(pb, queryClient)('books', {
     *     onInsert: false
     * });
     * ```
     */
    onInsert?: InsertMutationFn<ExtractRecordType<Schema, CollectionName>> | false;

    /**
     * Custom handler for update mutations.
     *
     * **Default behavior (not provided):** Automatically updates records in PocketBase
     * with the changed fields.
     *
     * **Custom handler:** Provide your own handler to customize update behavior.
     *
     * **Disable:** Set to `false` to disable update mutations entirely (will throw error if update is called).
     *
     * @example
     * ```ts
     * // Use default automatic handler (recommended)
     * const collection = createCollection<Schema>(pb, queryClient)('books');
     *
     * // Custom handler
     * const collection = createCollection<Schema>(pb, queryClient)('books', {
     *     onUpdate: async ({ transaction }) => {
     *         for (const mutation of transaction.mutations) {
     *             await customUpdateLogic(mutation.original.id, mutation.changes);
     *         }
     *         await queryClient.invalidateQueries({ queryKey: ['books'] });
     *     }
     * });
     *
     * // Disable updates (read-only collection)
     * const collection = createCollection<Schema>(pb, queryClient)('books', {
     *     onUpdate: false
     * });
     * ```
     */
    onUpdate?: UpdateMutationFn<ExtractRecordType<Schema, CollectionName>> | false;

    /**
     * Custom handler for delete mutations.
     *
     * **Default behavior (not provided):** Automatically deletes records from PocketBase.
     *
     * **Custom handler:** Provide your own handler to customize delete behavior.
     *
     * **Disable:** Set to `false` to disable delete mutations entirely (will throw error if delete is called).
     *
     * @example
     * ```ts
     * // Use default automatic handler (recommended)
     * const collection = createCollection<Schema>(pb, queryClient)('books');
     *
     * // Custom handler
     * const collection = createCollection<Schema>(pb, queryClient)('books', {
     *     onDelete: async ({ transaction }) => {
     *         for (const mutation of transaction.mutations) {
     *             await customDeleteLogic(mutation.original.id);
     *         }
     *         await queryClient.invalidateQueries({ queryKey: ['books'] });
     *     }
     * });
     *
     * // Disable deletes (read-only collection)
     * const collection = createCollection<Schema>(pb, queryClient)('books', {
     *     onDelete: false
     * });
     * ```
     */
    onDelete?: DeleteMutationFn<ExtractRecordType<Schema, CollectionName>> | false;

    /**
     * Sync mode for the collection. Controls when and how data is fetched from PocketBase.
     *
     * - `'eager'` (default): Fetches all data immediately when collection is created.
     *   Queries are evaluated client-side against the cached data. Fast for small datasets
     *   but loads entire collection into memory. Matches TanStack DB default.
     *
     * - `'on-demand'`: Fetches data only when queries execute. Each query with different
     *   filters/sorting triggers a new fetch from PocketBase. Enables true server-side
     *   filtering and is better for large datasets.
     *
     * @default 'eager'
     *
     * @example
     * ```ts
     * // Default: eager mode - client-side filtering
     * const collection = createCollection<Schema>(pb, queryClient)('books');
     *
     * // On-demand mode - server-side filtering
     * const collection = createCollection<Schema>(pb, queryClient)('books', {
     *     syncMode: 'on-demand'
     * });
     * ```
     */
    syncMode?: 'eager' | 'on-demand';

    /**
     * Whether to ignore PocketBase auto-cancellation errors.
     *
     * PocketBase automatically cancels pending requests when a new request is made
     * to the same endpoint. This can throw ClientResponseError with a message
     * containing "autocancelled". When this option is true, such errors are
     * silently ignored and the existing cached data is returned for the cancelled request.
     *
     * @default true
     *
     * @example
     * ```ts
     * // Default: auto-cancellation errors are ignored
     * const collection = createCollection<Schema>(pb, queryClient)('books');
     *
     * // Explicitly handle auto-cancellation errors
     * const collection = createCollection<Schema>(pb, queryClient)('books', {
     *     ignoreAutoCancellation: false
     * });
     * ```
     */
    ignoreAutoCancellation?: boolean;
}
