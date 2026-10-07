import type {
    BaseCollectionConfig,
    Collection,
    DeleteMutationFn,
    InsertMutationFn,
    UpdateMutationFn,
} from '@tanstack/db'

/** Which rows a collection's realtime subscription covers. */
export type RealtimeMode = 'collection' | 'query'

// ============================================================================
// Schema Type Definitions
// ============================================================================

/**
 * Base record type required by PocketBase collections.
 * All records must have an 'id' field.
 */
export interface BaseRecord {
    id: string
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
        type: BaseRecord
        relations?: {
            [fieldName: string]: BaseRecord | BaseRecord[]
        }
    }
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
    CollectionName extends keyof Schema,
> = Schema[CollectionName]['type']

/**
 * Valid field names that can be omitted during insert operations.
 * Excludes 'id' which is always required for TanStack DB record tracking.
 * @internal
 */
export type OmittableFields<T extends object> = Exclude<keyof T, 'id'>

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
    OmitFields extends readonly OmittableFields<T>[],
> = Omit<T, OmitFields[number]> & Partial<Pick<T, OmitFields[number]>>

/**
 * Extracts the relations object from a schema collection.
 * Returns never if the collection has no relations defined.
 * @internal
 */
export type ExtractRelations<
    Schema extends SchemaDeclaration,
    CollectionName extends keyof Schema,
> = Schema[CollectionName] extends { relations: infer R } ? R : never

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
export type ExcludeUndefined<T> = T extends infer U | undefined ? U : T

/**
 * Converts a schema relation type to its corresponding Collection constraint.
 * Handles both single relations (T) and array relations (T[]).
 * Accepts collections with any insert type to support omitOnInsert configurations.
 *
 * Uses constraint (extends Collection<T, ...>) rather than exact type to allow
 * collections with different TInput types (from omitOnInsert) to be compatible.
 *
 * @example
 * RelationAsCollection<Customer> => Collection<Customer, string | number, ...>
 * RelationAsCollection<Customer[]> => Collection<Customer, string | number, ...>
 * @internal
 */
// biome-ignore-start lint/suspicious/noExplicitAny: wildcards absorb TUtils/TSchema/TInsertInput variance so relations with differing omitOnInsert insert types stay structurally compatible
export type RelationAsCollection<T> =
    T extends Array<infer U>
        ? U extends object
            ? Collection<U, string | number, any, any, any> & RelationTarget
            : Collection<object, string | number, any, any, any> & RelationTarget
        : T extends object
          ? Collection<T, string | number, any, any, any> & RelationTarget
          : Collection<object, string | number, any, any, any> & RelationTarget
// biome-ignore-end lint/suspicious/noExplicitAny: see above

/**
 * What a pbtsdb collection exposes to a parent that files expanded rows into
 * it. Every value in `relations` implements it; `createCollection` builds one.
 * @internal
 */
export interface RelationTarget {
    /** Relation targets of this collection, for nested expand paths. */
    readonly relationTargets: Record<string, RelationTarget> | undefined
    /** Upsert filed rows into the store for `holder`, a parent's token. False when the store cannot take them yet. */
    writeFiled: (records: object[], holder: object) => Promise<boolean>
    /**
     * A parent's fetch may file and mark `field` once `settles` resolves; the
     * target's own fetch for that subset waits for it (see docs/internals.md,
     * "Pending filings"). Returns the unregister function.
     */
    expectFiling: (field: string, settles: Promise<void>) => () => void
    /** Record that every row with `field === value` is now in this collection's store. */
    markSubsetLoaded: (field: string, value: string) => void
    /** Release rows `holder` filed that no parent row files any more. */
    releaseFiled: (ids: readonly string[], holder: object) => void
    /**
     * Hold this collection live for a parent identified by `holder`, with the
     * filters covering the rows the parent filed here (query mode only).
     * Releasing the hold releases every row filed under `holder`.
     */
    holdLive: (holder: object) => HeldTarget
}

/**
 * A parent's hold on a relation target, returned by `holdLive`.
 * @internal
 */
export type HeldTarget = { setFilters: (filters: readonly string[]) => void; release: () => void }

/**
 * Maps relation field names to the collections that receive their expanded records.
 */
export type RelationsConfig<Schema extends SchemaDeclaration, CollectionName extends keyof Schema> =
    ExtractRelations<Schema, CollectionName> extends never
        ? Record<string, never>
        : Partial<{
              [K in keyof ExtractRelations<Schema, CollectionName>]: RelationAsCollection<
                  ExcludeUndefined<ExtractRelations<Schema, CollectionName>[K]>
              >
          }>

/**
 * Phantom metadata carried on the type of every pbtsdb collection so that nested
 * expand paths resolve through the target collection's own relations.
 * @internal
 */
export interface PbMeta<Schema extends SchemaDeclaration, C extends keyof Schema, Relations> {
    schema: Schema
    name: C
    relations: Relations
}

/** @internal */
export type MetaOf<T> = T extends { readonly __pbtsdb: infer M } ? M : never

/** @internal */
export type RelationsOf<Opts> = Opts extends { relations: infer R } ? R : never

type RelationsOfMeta<M> = M extends { relations: infer R } ? R : never

type Prev = [never, 0, 1, 2, 3, 4, 5]

/**
 * Every valid PocketBase expand path for a relations map: each declared relation,
 * and each relation of a pbtsdb target joined with a dot, to six levels.
 */
export type ExpandPath<Relations, Depth extends number = 6> = [Depth] extends [0]
    ? never
    : Relations extends object
      ? {
            [K in keyof Relations & string]:
                | K
                | `${K}.${ExpandPath<RelationsOfMeta<MetaOf<Relations[K]>>, Prev[Depth]>}`
        }[keyof Relations & string]
      : never

/** @internal */
export type InsertInputOf<
    Schema extends SchemaDeclaration,
    C extends keyof Schema,
    Opts,
> = Opts extends {
    omitOnInsert: infer O extends readonly OmittableFields<ExtractRecordType<Schema, C>>[]
}
    ? ComputeInsertType<ExtractRecordType<Schema, C>, O>
    : ExtractRecordType<Schema, C>

// ============================================================================
// Configuration Options
// ============================================================================

/**
 * Options for creating a collection.
 */
export interface CreateCollectionOptions<
    Schema extends SchemaDeclaration,
    CollectionName extends keyof Schema,
> {
    /**
     * Collections that receive the records PocketBase expands for each relation.
     * Declaring a relation here makes it available to `alwaysFetchRelations` and to
     * `collection.fetchRelations()`.
     *
     * @example
     * ```ts
     * const authors = c('authors', {})
     * const books = c('books', { relations: { author: authors } })
     * ```
     */
    relations?: RelationsConfig<Schema, CollectionName>

    /**
     * Expand paths fetched with every request. The expanded records are filed
     * into the collections named in `relations`; they are not kept on the row.
     *
     * @example
     * ```ts
     * const books = c('books', { relations: { author: authors }, alwaysFetchRelations: ['author'] })
     * // Every fetch files the author into `authors`; read it with authors.get(data[0].author)
     * ```
     */
    alwaysFetchRelations?: readonly string[]

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
     * const booksCollection = createCollection<Schema>(pb)('books', {
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
    omitOnInsert?: readonly OmittableFields<ExtractRecordType<Schema, CollectionName>>[]

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
     * const collection = createCollection<Schema>(pb)('books');
     *
     * // Custom handler
     * const collection = createCollection<Schema>(pb)('books', {
     *     onInsert: async ({ transaction }) => {
     *         const created = await Promise.all(
     *             transaction.mutations.map(mutation => customInsertLogic(mutation.modified))
     *         );
     *         // Land the server rows before the optimistic state drops
     *         await collection.accept(created);
     *     }
     * });
     *
     * // Disable inserts (read-only collection)
     * const collection = createCollection<Schema>(pb)('books', {
     *     onInsert: false
     * });
     * ```
     */
    onInsert?: InsertMutationFn<ExtractRecordType<Schema, CollectionName>> | false

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
     * const collection = createCollection<Schema>(pb)('books');
     *
     * // Custom handler
     * const collection = createCollection<Schema>(pb)('books', {
     *     onUpdate: async ({ transaction }) => {
     *         const updated = await Promise.all(
     *             transaction.mutations.map(mutation =>
     *                 customUpdateLogic(mutation.original.id, mutation.changes)
     *             )
     *         );
     *         // Land the server rows before the optimistic state drops
     *         await collection.accept(updated);
     *     }
     * });
     *
     * // Disable updates (read-only collection)
     * const collection = createCollection<Schema>(pb)('books', {
     *     onUpdate: false
     * });
     * ```
     */
    onUpdate?: UpdateMutationFn<ExtractRecordType<Schema, CollectionName>> | false

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
     * const collection = createCollection<Schema>(pb)('books');
     *
     * // Custom handler
     * const collection = createCollection<Schema>(pb)('books', {
     *     onDelete: async ({ transaction }) => {
     *         const ids = transaction.mutations.map(mutation => mutation.original.id);
     *         await Promise.all(ids.map(id => customDeleteLogic(id)));
     *         // Remove the rows before the optimistic state drops
     *         await collection.evict(ids);
     *     }
     * });
     *
     * // Disable deletes (read-only collection)
     * const collection = createCollection<Schema>(pb)('books', {
     *     onDelete: false
     * });
     * ```
     */
    onDelete?: DeleteMutationFn<ExtractRecordType<Schema, CollectionName>> | false

    /**
     * If true, the built-in handlers reload the collection's live subsets
     * after a successful insert, update, or delete, before the mutation
     * settles. Defaults to false: the built-in handlers write the server
     * response into the synced layer before they settle, and the realtime
     * subscription reconciles everything else. Set true when a server-side
     * hook changes rows you must read right after the mutation.
     *
     * Only affects the built-in default handlers. A custom
     * onInsert/onUpdate should land the server response with
     * `await collection.accept(rows)` before it returns, and a custom
     * onDelete should `await collection.evict(ids)`. A custom handler that
     * needs a refetch can call `await collection.reload()` instead.
     *
     * @default false
     *
     * @example
     * ```ts
     * const collection = createCollection<Schema>(pb)('books', {
     *     refetchOnMutation: true,
     * });
     * ```
     */
    refetchOnMutation?: boolean

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
     * const collection = createCollection<Schema>(pb)('books');
     *
     * // On-demand mode - server-side filtering
     * const collection = createCollection<Schema>(pb)('books', {
     *     syncMode: 'on-demand'
     * });
     * ```
     */
    syncMode?: 'eager' | 'on-demand'

    /**
     * Which rows the realtime subscription covers.
     *
     * - `'collection'` (default): one subscription to every row.
     * - `'query'`: one subscription per active query filter, using the same
     *   filter the query's fetch sends. Requires `syncMode: 'on-demand'`.
     *   An update that moves a row out of every active filter sends no
     *   event; the row stays until its query refetches.
     *
     * A single query overrides this with `collection.withRealtime(mode)`.
     *
     * @default 'collection'
     *
     * @example
     * ```ts
     * const books = createCollection<Schema>(pb)('books', {
     *     syncMode: 'on-demand',
     *     realtime: 'query',
     * });
     * ```
     */
    realtime?: RealtimeMode

    /**
     * How long, in milliseconds, an on-demand subset stays loaded after its
     * last live query unsubscribes. A query with an equal request that mounts
     * within the window reuses the rows with no request; realtime keeps them
     * fresh meanwhile. Rows a parent filed through a relation follow the
     * same window. `0` releases a subset as soon as it unloads. A
     * `reload()` releases every waiting subset.
     *
     * @default 5000
     */
    subsetGcTime?: number

    /**
     * Additional options passed directly to the underlying TanStack DB collection.
     * Use this to configure indexing, garbage collection, comparison functions,
     * and any other TanStack DB collection options not explicitly exposed by pbtsdb.
     *
     * Options set here are spread into the TanStack DB `createCollection()` call.
     * Fields managed by pbtsdb (`getKey`, `syncMode`, `onInsert`, `onUpdate`,
     * `onDelete`, `schema`, `utils`) are excluded from the type.
     *
     * pbtsdb defaults `autoIndex` to `'eager'` with `defaultIndexType: BTreeIndex`
     * so `orderBy` + `limit` queries page lazily; both can be overridden here.
     *
     * @example
     * ```ts
     * import { BasicIndex } from 'pbtsdb'
     * const collection = createCollection<Schema>(pb)('books', {
     *     collectionOptions: {
     *         autoIndex: 'off',
     *         gcTime: 60000,
     *     }
     * });
     * ```
     */
    collectionOptions?: Omit<
        Partial<BaseCollectionConfig<ExtractRecordType<Schema, CollectionName>, string | number>>,
        'getKey' | 'syncMode' | 'onInsert' | 'onUpdate' | 'onDelete' | 'schema' | 'utils'
    >
}
