import React, { createContext, useContext, type ReactNode } from 'react';
import type { Collection } from '@tanstack/db';
import type { SchemaDeclaration } from './types';

/**
 * Map of collection names to TanStack DB Collection instances.
 * Keys are user-defined strings, values are Collection instances.
 *
 * @example
 * ```ts
 * const stores = {
 *     jobs: jobsCollection,
 *     customers: customersCollection,
 *     addresses: addressesCollection
 * };
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CollectionsMap = Record<string, Collection<any>>;

/**
 * Registry interface for declaring your application's collections.
 * Augment this interface in your app to enable automatic type inference in hooks.
 *
 * @example
 * ```ts
 * // In your app (e.g., hooks.ts or collections.ts)
 * declare module 'pbtsdb' {
 *     interface CollectionsRegistry {
 *         books: Collection<Books>;
 *         authors: Collection<Authors>;
 *         customers: Collection<Customers>;
 *     }
 * }
 *
 * // Now hooks have automatic type inference
 * function MyComponent() {
 *     const books = useStore('books'); // Type is Collection<Books>
 * }
 * ```
 */
export interface CollectionsRegistry extends CollectionsMap {}

/**
 * Context for providing collections to React components.
 * @internal
 */
const CollectionsContext = createContext<CollectionsMap | null>(null);

/**
 * Props for the CollectionsProvider component.
 */
export interface CollectionsProviderProps {
    /** Map of collection name to Collection instance */
    collections: CollectionsMap;
    /** React children to render */
    children: ReactNode;
}

/**
 * Provider component that makes collections available to all child components.
 * Wrap your app with this provider to use the useStore and useStores hooks.
 *
 * @example
 * ```tsx
 * const factory = new CollectionFactory<Schema>(pb, queryClient);
 * const collections = {
 *     jobs: factory.create('jobs'),
 *     customers: factory.create('customers'),
 *     addresses: factory.create('addresses')
 * };
 *
 * function App() {
 *     return (
 *         <CollectionsProvider collections={collections}>
 *             <YourApp />
 *         </CollectionsProvider>
 *     );
 * }
 * ```
 */
export function CollectionsProvider({ collections, children }: CollectionsProviderProps) {
    return (
        <CollectionsContext.Provider value={collections}>
            {children}
        </CollectionsContext.Provider>
    );
}

/**
 * Hook to access a single collection from the provider.
 * Returns the Collection instance for the specified key.
 *
 * Type inference is automatic when you augment the CollectionsRegistry interface.
 *
 * @param key - The collection key as defined in the provider
 * @returns The Collection instance with inferred type
 * @throws Error if used outside of CollectionsProvider or if key doesn't exist
 *
 * @example
 * ```tsx
 * // Augment the registry first (in hooks.ts or collections.ts)
 * declare module 'pbtsdb' {
 *     interface CollectionsRegistry {
 *         jobs: Collection<Jobs>;
 *     }
 * }
 *
 * // Then use with automatic type inference
 * function JobsList() {
 *     const jobs = useStore('jobs'); // ✅ Type is Collection<Jobs>
 *
 *     const { data } = useLiveQuery((q) => q.from({ jobs }));
 *
 *     return (
 *         <ul>
 *             {data?.map(job => <li key={job.id}>{job.name}</li>)}
 *         </ul>
 *     );
 * }
 * ```
 */
export function useStore<K extends keyof CollectionsRegistry>(
    key: K
): CollectionsRegistry[K] {
    const context = useContext(CollectionsContext);

    if (!context) {
        throw new Error('useStore must be used within a CollectionsProvider');
    }

    if (!(key in context)) {
        throw new Error(`Collection "${String(key)}" not found in CollectionsProvider`);
    }

    return context[key as string] as CollectionsRegistry[K];
}

/**
 * Hook to access multiple collections from the provider.
 * Returns an array of Collection instances matching the order of the keys array.
 *
 * Type inference is automatic when you augment the CollectionsRegistry interface.
 *
 * @param keys - Array of collection keys as defined in the provider
 * @returns Array of Collection instances in the same order as keys with inferred types
 * @throws Error if used outside of CollectionsProvider or if any key doesn't exist
 *
 * @example
 * ```tsx
 * // Augment the registry first (in hooks.ts or collections.ts)
 * declare module 'pbtsdb' {
 *     interface CollectionsRegistry {
 *         jobs: Collection<Jobs>;
 *         customers: Collection<Customers>;
 *     }
 * }
 *
 * // Then use with automatic type inference
 * function JobsWithCustomers() {
 *     const [jobs, customers] = useStores(['jobs', 'customers']);
 *     // ✅ Types are [Collection<Jobs>, Collection<Customers>]
 *
 *     const { data } = useLiveQuery((q) =>
 *         q.from({ job: jobs })
 *          .join(
 *              { customer: customers },
 *              ({ job, customer }) => eq(job.customer, customer.id),
 *              'left'
 *          )
 *     );
 *
 *     return <div>...</div>;
 * }
 * ```
 */
export function useStores<K extends readonly (keyof CollectionsRegistry)[]>(
    keys: K
): { [I in keyof K]: K[I] extends keyof CollectionsRegistry ? CollectionsRegistry[K[I]] : never } {
    const context = useContext(CollectionsContext);

    if (!context) {
        throw new Error('useStores must be used within a CollectionsProvider');
    }

    const collections = keys.map((key) => {
        if (!(key in context)) {
            throw new Error(`Collection "${String(key)}" not found in CollectionsProvider`);
        }
        return context[key as string];
    });

    return collections as {
        [I in keyof K]: K[I] extends keyof CollectionsRegistry ? CollectionsRegistry[K[I]] : never;
    };
}

