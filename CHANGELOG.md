# Changelog

All notable changes to this project will be documented in this file.

## [0.0.1] - 2025-01-22

### Added

- Initial release of pocketbase-tanstack-db
- `CollectionFactory` class for creating type-safe TanStack DB collections from PocketBase
- Full TypeScript support with strict type checking
- Real-time subscription management with automatic reconnection
- `SubscriptionManager` for handling PocketBase real-time updates
- React integration with `CollectionsProvider`, `useStore` hook
- Type-safe relation expansion with `expand` option
- Manual join support with `relations` configuration
- Comprehensive type definitions for schema declarations
- Query operators support (filters, sorting, pagination)
- ESM module format
- MIT license

### Features

- **Type Safety**: Full TypeScript support with generic constraints and schema declarations
- **Real-time Updates**: Automatic synchronization with PocketBase via Server-Sent Events (SSE)
- **React Hooks**: Easy integration with React applications via provider pattern
- **Flexible Queries**: Support for both PocketBase expand and TanStack DB joins
- **Reconnection Logic**: Automatic reconnection with exponential backoff
- **Subscription Control**: Fine-grained control over collection and record-level subscriptions

[1.0.0]: https://github.com/nathanstitt/pbtsdb/releases/tag/v1.0.0
