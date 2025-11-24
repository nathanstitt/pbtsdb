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
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CollectionsRegistry {}

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
 * Wrap your app with this provider to use the useStore hook.
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
 * Hook to access one or more collections from the provider.
 * Returns a single Collection when given one key, or an array of Collections for multiple keys.
 *
 * Type inference is automatic when you augment the CollectionsRegistry interface.
 *
 * @param keys - One or more collection keys as defined in the provider
 * @returns Single Collection instance or array of Collection instances with inferred types
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
 * // Single collection
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
 *
 * // Multiple collections
 * function JobsWithCustomers() {
 *     const [jobs, customers] = useStore('jobs', 'customers');
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
export function useStore<K extends keyof CollectionsRegistry>(
    key: K
): CollectionsRegistry[K];
export function useStore<K extends readonly (keyof CollectionsRegistry)[]>(
    ...keys: K
): { [I in keyof K]: K[I] extends keyof CollectionsRegistry ? CollectionsRegistry[K[I]] : never };
export function useStore<K extends string>(
    ...keys: K[]
): any {
    const context = useContext(CollectionsContext);

    if (!context) {
        throw new Error('useStore must be used within a CollectionsProvider');
    }

    if (keys.length === 1) {
        const key = keys[0];
        if (!(key in context)) {
            throw new Error(`Collection "${String(key)}" not found in CollectionsProvider`);
        }
        return context[key];
    }

    return keys.map((key) => {
        if (!(key in context)) {
            throw new Error(`Collection "${String(key)}" not found in CollectionsProvider`);
        }
        return context[key];
    });
}


