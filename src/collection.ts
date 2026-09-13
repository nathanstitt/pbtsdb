import type { Collection } from '@tanstack/db'
import type { QueryCollectionUtils } from '@tanstack/query-db-collection'
import type { QueryClient } from '@tanstack/react-query'
import type PocketBase from 'pocketbase'
import { buildCollection, type CreateCollectionFactoryOptions } from './build-collection'
import type {
    CreateCollectionOptions,
    ExpandPath,
    ExtractRecordType,
    InsertInputOf,
    PbMeta,
    RelationsOf,
    SchemaDeclaration,
} from './types'

export type { CreateCollectionFactoryOptions } from './build-collection'
export type { BaseRecord, CreateCollectionOptions, SchemaDeclaration } from './types'

/**
 * A pbtsdb collection or view: a TanStack DB collection over
 * `ExtractRecordType<Schema, C>` rows, plus pbtsdb's subscription helpers.
 */
export type PbCollectionView<
    Schema extends SchemaDeclaration,
    C extends keyof Schema & string,
    Opts,
> = Collection<
    ExtractRecordType<Schema, C>,
    string | number,
    QueryCollectionUtils<
        ExtractRecordType<Schema, C>,
        string | number,
        ExtractRecordType<Schema, C>
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
    /** @internal phantom; never present at runtime */
    readonly __pbtsdb: PbMeta<Schema, C, RelationsOf<Opts>>
}

/**
 * The collection returned by {@link createCollection}: a {@link PbCollectionView}
 * plus `fetchRelations()` for per-query views.
 */
export type PbCollection<
    Schema extends SchemaDeclaration,
    C extends keyof Schema & string,
    Opts,
> = PbCollectionView<Schema, C, Opts> & {
    /**
     * A view of this collection whose queries also fetch `paths` and file the
     * expanded records into their target collections. Rows are unchanged; read
     * related records through `materialize()`, a join, or the target's `get()`.
     */
    fetchRelations<const P extends readonly ExpandPath<RelationsOf<Opts>>[]>(
        ...paths: P
    ): PbCollectionView<Schema, C, Opts>
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
 * // The expanded author is filed into authorsCollection, not kept on the row.
 * authorsCollection.get(data[0].author)?.name
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
 * // Same target collection as above; the view only affects what gets fetched.
 * authorsCollection.get(data[0].author)?.name
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
