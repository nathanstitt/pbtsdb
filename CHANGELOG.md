# Changelog

All notable changes to this project will be documented in this file.

> Releases 0.1.0 through 0.6.3 were reconstructed from git history after the
> fact, so they summarise each release rather than record it contemporaneously.

## [Unreleased]

## [1.0.0] - 2026-10-07

### Breaking

- pbtsdb now builds on `@tanstack/db`'s core sync API. `@tanstack/query-db-collection`
  and `@tanstack/react-query` are no longer dependencies.
- `createCollection(pb, queryClient, factoryOptions?)` is now `createCollection(pb, factoryOptions?)`.
- `collection.utils.writeInsert/writeUpdate/writeUpsert/writeDelete/writeBatch` and
  `collection.utils.refetch` are removed. Use `collection.accept(rows)` for rows the
  server returned, `collection.evict(ids)` for rows the server deleted, and
  `collection.reload()` to refetch every live subset. All three are also on
  `collection.utils`.
- `queryClient.invalidateQueries([collectionName])` no longer reaches pbtsdb. Call
  `collection.reload()`.
- The `ignoreAutoCancellation` option is removed. Every request carries its own key,
  so the SDK's auto-cancellation never aborts a pbtsdb load.
- `collectionOptions` no longer accepts `utils`, which pbtsdb manages.
- Requires `@tanstack/db` >=0.12.1 and `@tanstack/react-db` >=0.5.5.

### Changed

- Row membership is owned by pbtsdb's ledger (see `docs/internals.md`, "Ledger"). A
  realtime event or a mutation write-back never refetches a query.
- A realtime delete on a filtered subscription releases only that subscription's
  rows, so a row that leaves one filter stays while another live query holds it.
- pbtsdb writes realtime echoes, mutation write-backs, and filed relation rows
  through the collection's sync session instead of direct writes to the cache.
- The built-in insert and update handlers write the server response, and the
  built-in delete handler removes the row, before they return. TanStack DB
  0.12 drops the optimistic state when the handler settles; the settled row is
  now the server's row with no gap in which the previous row shows.
- `refetchOnMutation: true` calls `collection.reload()` before the handler settles.
  The built-in handlers return `void`. Concurrent `reload()` calls share one
  follow-up reload instead of each fetching every live subset.
- An unloaded on-demand subset stays held for `subsetGcTime` (default 5 s). A query
  with an equal request that mounts within the window reuses the rows with no
  request, and realtime keeps them fresh meanwhile. After the window, or on
  `reload()`, the rows leave unless another holder has them. The react-query cache
  served a remount for its `gcTime` before; the window is now explicit and realtime
  covered. Only a subset whose rows landed waits; an auth record change releases every
  waiting subset at once.
- Two live queries with equal requests send two requests. react-query deduplicated
  them.
- No refetch on window focus or on network reconnect; react-query did both by
  default. Call `collection.reload()` for the same effect. A realtime reconnect the
  server did not resume still reloads every live subset.
- Rows a parent files into a relation target are tracked per parent row. A filed row
  leaves the target when the last parent row filing it leaves the parent's store, when a
  parent fetch or echo no longer expands it (lost access, changed relation), or when a
  delete arrives on the hold's realtime topic. Hold filters follow the current filings,
  so they no longer grow for the life of the parent.
- A realtime echo that changes a relation files the new related row before it lands
  the parent, and releases the old one after, the same order a fetch uses. A join
  never sees the parent without its relation, so a joined row is not unmounted and
  remounted across the echo.
- A mutation write-back or `accept()` adds the accepted holder only to a row nothing
  holds yet. A row a query or topic already holds is refreshed in place, so a saved
  row leaves with its query instead of staying for the session. When `subsetGcTime`
  ends, the row is handed to every live query whose filter matches it and the
  accepted holder is dropped, so a written row no live query covers leaves and a row
  the user still sees stays even if no realtime echo came.
- pbtsdb resets its realtime session itself when `pb.authStore` changes to another
  auth record. `disconnectRealtime(pb)` closes the connection and keeps it closed
  until `resetRealtime(pb)`.
- In on-demand mode with `realtime: 'collection'`, a row that arrives as a realtime
  echo stays in memory until `reload()` runs or the collection goes idle. Live
  queries apply their own `where`, so this costs memory, not correctness.

### Fixed

- A row pruned by a query refetch (a delete by key alone) now forgets the
  loaded-subset marks it belonged to. Only a prune that carried the row did
  before, so a subset could stay marked complete without the row.
- pbtsdb stores a copy of each row it writes. A caller that changes an event
  record in place can no longer change the stored row, and TanStack DB's
  development check `SyncRowReusedWithoutPreviousValueError` cannot fire on
  pbtsdb's writes.

## [0.12.0] - 2026-10-07

### Changed

- pbtsdb opens its own realtime connection instead of the PocketBase SDK's. Topic changes made in one tick go out in one request, a topic over the server's cap is rejected client-side instead of poisoning the connection, and a subscription resolves once the server has it.

### Fixed

- After a reconnect the server did not resume, every live query refetches. Before, events missed during the gap were silently lost.

### Added

- Resume protocol for servers that support it: `?resume=<clientId>&after=<seq>`, `resumed` in `PB_CONNECT`, `seq` on events.
- `resetRealtime(pb)`: call after an auth change (login, logout, switching users) so the shared connection re-subscribes every topic under the new auth instead of silently keeping the previous session.

## [0.11.0] - 2026-10-05

### Added

- `loadSubset` paging: the cursor TanStack DB passes for a sorted, limited
  query is conjoined to the fetch filter, so load-more and `setWindow` fetch
  the delta instead of the prefix; an offset without a cursor becomes a
  PocketBase page. Realtime stays on the base `where`.
- `convertToPocketBaseFilter` and `convertToPocketBaseSort` are exported from
  `pbtsdb/core`, so a consumer's tests can pin the filter a predicate
  compiles to.

### Changed

- The peer dependency floors are raised to `@tanstack/db` >=0.9.0,
  `@tanstack/query-db-collection` >=1.2.13, and `@tanstack/react-db` >=0.3.8.
  The realtime filter reads the subscription's base `where`, which these
  versions provide.

### Fixed

- A sorted, limited query's boundary tie-check and cursor pages opened one
  realtime entry per chunk. The realtime filter now follows the triggering
  subscription's base `where`, so every chunk of one query shares one entry.
  A join's or include's key batch (an `in` on the join key, which is often a
  foreign key) keeps its own filter.

## [0.10.2] - 2026-09-28

### Fixed

- An empty `inArray` / `notIn` compiles to a constant PocketBase filter
  (`1 = 2` / `1 = 1`). It previously compiled to no condition at all, so an
  empty `inArray` dropped out of the filter and matched every row.

## [0.10.1] - 2026-09-28

### Fixed

- `not(...)` compiles to PocketBase's negated operators (`!=`, `!~`, flipped
  comparisons, De Morgan for `and` / `or`). PocketBase has no prefix `!`, so
  an on-demand query with `not()` previously sent an invalid filter.

## [0.10.0] - 2026-09-26

### Added

- Child subsets filed by a back-relation expand (`comments_via_card`) are
  served from the store: a child query filtered by that foreign key makes no
  request while the subset is marked complete.
- `realtime: 'query'` on an on-demand collection subscribes to realtime per
  active query filter instead of the whole collection, and
  `collection.withRealtime(mode)` overrides the mode for one query.

### Fixed

- A response's expanded relations are filed with one write per relation
  target instead of one per parent record. Each write pushes the target's
  whole row set into every cached query for it, so a 300-row roster whose
  every row expands the same board cost 300 full writes where one will do.
- An id subset too long for one PocketBase filter (about 130 ids — the server
  refuses a filter over 3500 bytes with a generic 400) is fetched in several
  requests instead of failing.
- A parent with no children is marked complete too: PocketBase omits the
  expand key for an empty back-relation, which previously left every child
  query for a fresh parent fetching.

## [0.9.0] - 2026-09-13

### Changed

- **Breaking:** rows never carry `expand`. PocketBase `expand` now only files
  related records into the collections named in `relations`; read them with
  `materialize()`, a join, or the target's `get()`.
- **Breaking:** `alwaysExpand` is `alwaysFetchRelations`, and
  `collection.expand()` is `collection.fetchRelations()`. Both keep their path
  validation.
- **Breaking:** the row-shape types `ExpandShape`, `WithExpandPaths`,
  `WithExpand`, `ParseExpandFields`, and `PbView` are removed; `PbCollection`
  and `PbCollectionView` rows are the schema record type.

### Added

- `materialize` is re-exported from `pbtsdb`.
- Id-only loads (`eq(id, x)`, `inArray(id, [...])`, or an `or` of those) are
  served from the synced store when every id is present, so includes and joins
  on filed rows make no request.
- `PbCollectionView` is exported: a collection or view without
  `fetchRelations()` (views are leaves). `PbCollection` is `PbCollectionView`
  plus `fetchRelations()`.

### Removed

- Embedded-copy patching from relation echoes, the `expand` merge rules, and
  the dependents registry; they existed only to keep copies fresh.

## [0.8.0] - 2026-09-11

### Changed

- Collections default to `autoIndex: 'eager'` with `defaultIndexType:
  BTreeIndex`, restoring lazy paging for `orderBy` + `limit` queries after
  TanStack DB 0.6 turned auto-indexing off. Override per collection through
  `collectionOptions`.
- **Breaking:** the `expand` collection option is replaced by `relations` and
  `alwaysExpand`. `expand: { author }` becomes
  `relations: { author }, alwaysExpand: ['author']`.
- Upgraded to `@tanstack/db` 0.9, `@tanstack/react-db` 0.3, and
  `@tanstack/query-db-collection` 1.2. Peer ranges are unchanged.

### Added

- Per-query expand: `collection.expand('tags')` returns a view whose live
  queries fetch with that `expand`, typed on the rows, sharing the base
  collection's store, realtime subscription, and mutations. Dot paths such as
  `'book.author'` resolve through the target collection's own `relations`.
- Expand data on a row survives later writes that lack it, as long as the
  relation field is unchanged.
- Relation targets stay subscribed while a query expands into them, and
  their realtime changes patch the embedded `expand` copies on parent rows
  in place (nested paths included). Delete echoes clear the reference and
  the copy. Unchanged echoes never write.

### Fixed

- The realtime subscription now requests every expand path in use, so an echo
  no longer wipes `expand` from an always-expanded row.
- `collectionOptions.gcTime` now reaches the TanStack collection;
  `queryCollectionOptions` consumed it for the query observer only, so
  collection garbage collection always used the five-minute default.

## [0.7.3] - 2026-09-05

### Fixed

- A mutation's server response is written back into the synced store after
  the transaction persists, not inside the mutation handler. When the
  realtime echo of a create arrived before the HTTP response, the earlier
  write-back left TanStack DB holding the draft as a confirmed-but-unsynced
  overlay that nothing cleared, so server-assigned fields read as missing
  until a reload.

### Removed

- The equal-`updated` drop on the query-result write path (0.6.3). PocketBase
  stamps `updated` to the millisecond and bumps it on every write, so a read
  cannot carry old content under an equal timestamp; the revert it guarded was
  the write-back race above. Staleness is strictly-older everywhere, and the
  optimistic-pending arm alone holds a move against a read racing it.

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
