import type { Collection } from '@tanstack/db'
import type { QueryCollectionUtils } from '@tanstack/query-db-collection'
import type { QueryClient } from '@tanstack/react-query'
import type PocketBase from 'pocketbase'
import { buildCollection, type CreateCollectionFactoryOptions } from './build-collection'
import type {
    AlwaysFetchRelationsOf,
    CreateCollectionOptions,
    ExpandPath,
    InsertInputOf,
    PbMeta,
    RelationsOf,
    SchemaDeclaration,
    WithExpandPaths,
} from './types'

export type { CreateCollectionFactoryOptions } from './build-collection'
export type { BaseRecord, CreateCollectionOptions, SchemaDeclaration } from './types'

/**
 * A pbtsdb collection or view: a TanStack DB collection whose rows carry the
 * expand paths in `Paths`, plus pbtsdb's subscription helpers.
 */
export type PbView<
    Schema extends SchemaDeclaration,
    C extends keyof Schema & string,
    Opts,
    Paths extends string,
> = Collection<
    WithExpandPaths<Schema, C, RelationsOf<Opts>, Paths>,
    string | number,
    QueryCollectionUtils<
        WithExpandPaths<Schema, C, RelationsOf<Opts>, Paths>,
        string | number,
        WithExpandPaths<Schema, C, RelationsOf<Opts>, Paths>
    >,
    never,
    InsertInputOf<Schema, C, Opts>
> & {
    /** The PocketBase collection name */
    readonly collectionName: C
    /** Wait for the real-time subscription to be established (useful in tests) */
    waitForSubscription: (timeout?: number) => Promise<void>
    /** Whether the collection has an active real-time subscription */
    isSubscribed: () => boolean
    /** @internal relation targets declared through `relations` */
    readonly relationTargets: Record<string, unknown> | undefined
    /** @internal number of relation targets currently held live */
    readonly heldRelationTargetCount: () => number
    /** @internal collections that declared this one in their `relations` */
    readonly relationDependents: readonly { field: string; parent: unknown }[]
    /** @internal patch rows for a relation target change; used by the target's realtime handler */
    readonly applyRelatedChange: (
        fields: readonly string[],
        action: 'create' | 'update' | 'delete',
        record: { id: string },
        visited: Set<string>
    ) => void
    /** @internal phantom; never present at runtime */
    readonly __pbtsdb: PbMeta<Schema, C, RelationsOf<Opts>>
}

/**
 * The collection returned by {@link createCollection}: a {@link PbView} over the
 * `alwaysFetchRelations` paths, plus `fetchRelations()` for per-query views.
 */
export type PbCollection<
    Schema extends SchemaDeclaration,
    C extends keyof Schema & string,
    Opts,
> = PbView<Schema, C, Opts, AlwaysFetchRelationsOf<Opts>> & {
    /**
     * A view of this collection whose queries also fetch `paths` and file the
     * expanded records into their target collections. Rows are unchanged; read
     * the related records through `materialize()`, a join, or the target's `get()`.
     *
     * @example
     * ```ts
     * const { data } = useLiveQuery(q => q.from({ books: books.fetchRelations('author') }))
     * data[0].expand?.author?.name
     * ```
     */
    fetchRelations<const P extends readonly ExpandPath<RelationsOf<Opts>>[]>(
        ...paths: P
    ): PbView<Schema, C, Opts, AlwaysFetchRelationsOf<Opts> | P[number]>
}

type AlwaysFetchRelationsCheck<Opts> = {
    alwaysFetchRelations?: readonly ExpandPath<RelationsOf<Opts>>[]
}

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
 * With relations fetched on every request:
 * ```ts
 * const authorsCollection = createCollection<Schema>(pb, queryClient)('authors', {});
 * const booksCollection = createCollection<Schema>(pb, queryClient)('books', {
 *     relations: { author: authorsCollection },
 *     alwaysFetchRelations: ['author'],
 * });
 *
 * const { data } = useLiveQuery((q) => q.from({ books: booksCollection }));
 * // data[0].expand?.author is typed and populated
 * ```
 *
 * @example
 * With a per-query fetchRelations view:
 * ```ts
 * const booksCollection = createCollection<Schema>(pb, queryClient)('books', {
 *     relations: { author: authorsCollection },
 * });
 *
 * const view = booksCollection.fetchRelations('author');
 * const { data } = useLiveQuery((q) => q.from({ books: view }));
 * // data[0].expand?.author is typed and populated for this query only
 * ```
 */
export function createCollection<Schema extends SchemaDeclaration>(
    pb: PocketBase,
    queryClient: QueryClient,
    factoryOptions?: CreateCollectionFactoryOptions
) {
    return <C extends keyof Schema & string, const Opts extends CreateCollectionOptions<Schema, C>>(
        collectionName: C,
        options?: Opts & AlwaysFetchRelationsCheck<Opts>
    ): PbCollection<Schema, C, Opts> => {
        return buildCollection<Schema, C>({
            pb,
            queryClient,
            factoryOptions,
            collectionName,
            options,
        }) as unknown as PbCollection<Schema, C, Opts>
    }
}
