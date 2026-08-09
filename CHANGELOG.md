# Changelog

All notable changes to this project will be documented in this file.

> Releases 0.1.0 through 0.6.3 were reconstructed from git history after the
> fact, so they summarise each release rather than record it contemporaneously.

## [0.7.0] - 2026-08-09

### Added

- `createCollection` accepts a third `factoryOptions` argument. Its
  `subscribeOptions` getter supplies extra options — `headers`, `filter`,
  `expand`, `fields` — to every real-time subscription the factory creates.
  The getter is invoked at subscribe time rather than read once, so the value
  can change across reconnects. This allows a share-link token to authorize an
  anonymous real-time subscription: PocketBase snakecases header names
  identically for real-time and REST, so one collection rule
  (`@request.headers.x_share_token`) serves both transports.
- `CreateCollectionFactoryOptions` and `RecordSubscribeOptions` are now exported.

### Changed

- **Raised the `pocketbase` peer dependency floor from `>=0.21.0` to `>=0.22.0`.**
  Subscription headers work at runtime from 0.21.0, but `RecordSubscribeOptions`
  is not exported as a type until 0.22.0. Omitting `subscribeOptions` behaves
  exactly as before, so this is otherwise a non-breaking release.

## [0.6.3] - 2026-06-14

### Fixed

- Drop query results whose `updated` timestamp equals the local record's on the
  synced-write guard, so a post-settle refetch cannot revert a newer local edit.
- Support TypeScript 5.9 and 6.0; regenerate the lockfile for CI.

## [0.6.2] - 2026-06-14

### Fixed

- Guard the query-result write path against reverting an optimistic move. The
  residual snap-back left by 0.6.1 lived in `applySuccessfulResult`.

## [0.6.1] - 2026-06-14

### Fixed

- Prevent an optimistic move from snapping back when a stale realtime echo
  arrives after the mutation has already settled.

## [0.6.0] - 2026-06-14

### Fixed

- Ignore realtime delete echoes for records already removed locally, which threw
  `DeleteOperationItemNotFoundError` under `syncMode: 'on-demand'`.
- Repair installation: swap to `@biomejs/biome` and clear all audit
  vulnerabilities.
- Regenerate the lockfile with cross-platform optional dependencies for CI.

### Changed

- Split `fetchRecords` to clear a complexity warning.
- Exclude the generated `test/schema.ts` from Biome.

## [0.5.0] - 2026-05-04

### Added

- `refetchOnMutation` option on `CreateCollectionOptions`.

### Changed

- **Post-mutation refetches are now skipped by default.** Insert, update and
  delete no longer trigger a refetch unless `refetchOnMutation: true` is set.
  Previously every mutation refetched.

## [0.4.0] - 2026-04-16

### Added

- `pbtsdb/core` entry point for non-React environments.

### Changed

- Decoupled `collection.ts` from `@tanstack/react-db`, so core usage no longer
  pulls in React.

## [0.3.0] - 2026-03-27

### Added

- `collectionOptions` passthrough for options forwarded directly to TanStack DB.
- Re-exported new TanStack DB utilities (`BasicIndex`, `BTreeIndex`,
  `createEffect`, `ReverseIndex`, `toArray`).

### Changed

- Upgraded TanStack DB to 0.6.0 and adapted to its breaking changes.
- Test infrastructure: disabled file parallelism and added localStorage support.

## [0.2.0] - 2026-01-27

### Added

- `ignoreAutoCancellation` option on `CreateCollectionOptions` (default `true`).

## [0.1.3] - 2026-01-05

Version bump only; no functional changes.

## [0.1.2] - 2026-01-04

### Fixed

- Use `getFullList` to fetch all matching records rather than a single page.
- Add `skipTotal` since `page` is ignored on those requests.
- Use `writeUpsert` for the update case.

## [0.1.1] - 2025-12-09

### Fixed

- De-duplicate values before fetching.

## [0.1.0] - 2025-12-01

### Changed

- **Breaking:** `createCollection` moved to a curried API
  (`createCollection<Schema>(pb, queryClient)(name, options)`) for better type
  inference.
- **Breaking:** removed `SubscriptionManager`. Subscriptions now follow the
  TanStack DB collection lifecycle, starting and stopping with subscriber count.
- **Breaking:** `useStore` and `useStores` merged into a single variadic
  `useStore`; `expand` also became variadic.
- Removed the per-collection `.expand()` call in favour of the `expand` option.

### Added

- Mutation support (`onInsert`, `onUpdate`, `onDelete`).
- Typed `useStore` and `Provider` via `createReactCollections`.
- `omitOnInsert` configuration for optional insert fields.
- Query operator support.
- `info()` on the logger.

## [0.0.1] - 2025-11-23

### Added

- Initial release of pbtsdb
- `createCollection` curried function for creating type-safe TanStack DB collections from PocketBase
- Full TypeScript support with strict type checking
- Real-time subscription management with automatic reconnection
- `SubscriptionManager` for handling PocketBase real-time updates
- React integration with `createReactProvider`, `useStore` hook
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

[0.7.0]: https://github.com/nathanstitt/pbtsdb/releases/tag/v0.7.0
[0.6.3]: https://github.com/nathanstitt/pbtsdb/releases/tag/v0.6.3
[0.6.2]: https://github.com/nathanstitt/pbtsdb/releases/tag/v0.6.2
[0.6.1]: https://github.com/nathanstitt/pbtsdb/releases/tag/v0.6.1
[0.6.0]: https://github.com/nathanstitt/pbtsdb/releases/tag/v0.6.0
[0.5.0]: https://github.com/nathanstitt/pbtsdb/releases/tag/v0.5.0
[0.4.0]: https://github.com/nathanstitt/pbtsdb/releases/tag/v0.4.0
[0.3.0]: https://github.com/nathanstitt/pbtsdb/releases/tag/v0.3.0
[0.2.0]: https://github.com/nathanstitt/pbtsdb/releases/tag/v0.2.0
[0.1.3]: https://github.com/nathanstitt/pbtsdb/releases/tag/v0.1.3
[0.1.2]: https://github.com/nathanstitt/pbtsdb/releases/tag/v0.1.2
[0.1.1]: https://github.com/nathanstitt/pbtsdb/releases/tag/v0.1.1
[0.1.0]: https://github.com/nathanstitt/pbtsdb/releases/tag/v0.1.0
[0.0.1]: https://github.com/nathanstitt/pbtsdb/releases/tag/v0.0.1
