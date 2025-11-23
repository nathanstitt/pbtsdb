import PocketBase from 'pocketbase';
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

    constructor(public pocketbase: PocketBase, public queryClient: QueryClient){ }

    /**
     * Create a TanStack DB collection from a PocketBase collection.
     *
     * @param collection - The name of the collection
     * @param options - Optional configuration including relations and expand
     *
     * @example
     * Basic usage:
     * ```ts
     * const jobsCollection = factory.create('jobs');
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
    ) {
        type RecordType = ExtractRecordType<Schema, C>;

        return createCollection(
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
    }
}
