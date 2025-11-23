/**
 * pocketbase-tanstack-db: Type-safe PocketBase integration with TanStack DB
 *
 * This library bridges PocketBase (backend-as-a-service) with TanStack's
 * reactive database and query management tools, providing type-safe collection
 * management with real-time data synchronization.
 *
 * @packageDocumentation
 */

// Main factory class for creating collections
export { CollectionFactory } from './collection';

// React provider and hooks
export {
    CollectionsProvider,
    useStore,
    useStores,
    type CollectionsMap,
    type CollectionsProviderProps,
} from './provider';

// Real-time subscription manager
export { SubscriptionManager, SUBSCRIPTION_CONFIG } from './subscription-manager';

// Logger configuration
export { setLogger, resetLogger, type Logger } from './logger';

// Type definitions
export type {
    SchemaDeclaration,
    SubscribableCollection,
    JoinHelper,
    CreateCollectionOptions,
    RelationsConfig,
    RealtimeEvent,
    SubscriptionState,
    WithExpand,
    ExtractRecordType,
    ExtractRelations,
    ExpandableFields,
    ParseExpandFields,
    NonNullable,
    RelationAsCollection,
} from './types';
