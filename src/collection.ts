import type { Collection } from '@tanstack/db'
import type { QueryCollectionUtils } from '@tanstack/query-db-collection'
import type { QueryClient } from '@tanstack/react-query'
import type PocketBase from 'pocketbase'
import {
    buildCollection,
    type CollectionSubscriptionHelpers,
    type CreateCollectionFactoryOptions,
} from './build-collection'
import type { CreateCollectionOptions, ExtractRecordType, SchemaDeclaration } from './types'

export type { CreateCollectionFactoryOptions } from './build-collection'
export type { BaseRecord, CreateCollectionOptions, SchemaDeclaration } from './types'

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
    queryClient: QueryClient,
    factoryOptions?: CreateCollectionFactoryOptions
) {
    return <
        C extends keyof Schema & string,
        Opts extends CreateCollectionOptions<Schema, C> = CreateCollectionOptions<Schema, C>,
    >(
        collectionName: C,
        options?: Opts
    ): InferCollectionType<Schema, C, Opts> => {
        return buildCollection<Schema, C>({
            pb,
            queryClient,
            factoryOptions,
            collectionName,
            options,
        }) as unknown as InferCollectionType<Schema, C, Opts>
    }
}
