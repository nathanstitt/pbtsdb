# Internals

Design notes for the parts of the collection runtime whose reason is not visible in the code. Each section names the module and functions that hold the behavior.

## Write-back timing

`src/synced-write-guard.ts`: `writeBackAfterPersisted`

TanStack DB keeps a completed transaction's optimistic draft visible until a synced write for the key arrives. A record the server fills in (a number, a timestamp) reaches the screen only through that later synced write.

A write-back issued from inside the mutation handler lands while the transaction is still `persisting`. TanStack applies it, then on completion re-adds the draft as a "confirmed but unsynced" overlay and waits for a synced write that already happened. If the realtime echo was also already consumed (it can arrive before the create resolves, and an echo with the same `updated` as the write-back is dropped as stale), nothing clears the overlay. The row shows the draft, minus every server-assigned field, until a reload.

Deferring the write-back to after persistence makes it the synced write TanStack waits for. `markConfirmedPresent` still runs immediately, because the in-flight fetch bookkeeping must know the rows are confirmed the moment the server said so.

The deferred write is a no-op when the collection is not ready. Writing into the synced store before sync has initialized throws, and with no live query the next query fetches the persisted state anyway. It also drops any row the store already supersedes, because a realtime echo may have landed a newer copy while the transaction settled.

## Confirmed rows and in-flight fetches

`src/synced-write-guard.ts`: `trackFetch`, `markConfirmedPresent`, `withRowsConfirmedMidFlight`

`@tanstack/query-db-collection`'s `applySuccessfulResult` deletes every row a query owns that its result omits, and the synced-write guard exempts deletes. A subset read issued before a row existed can resolve late and delete the just-confirmed row. Rows a query owns include rows pushed into its cache by the manual-write path that runs on every write-back.

Each in-flight fetch registers a set before its request goes out. Confirmed local writes (write-backs and realtime echoes) add their ids to every registered set. An id added after a fetch was issued is newer than that fetch's view of the server, so the result cannot speak to its absence.

The fix is applied to the result, not the delete. `fetchRecords` merges such rows back in, which prevents the delete and keeps the row owned by the query. Dropping the delete alone would strip ownership and leave the row to a later GC pass. The merge ignores the fetch's filter on purpose: the manual-write cache push grants every active query ownership of every synced row, so a row outside the subset's filter must also be shielded from its reconcile.

## Staleness

`src/synced-write-guard.ts`: `isStaleServerRecord`, `shouldDrop`; `src/build-collection.ts`: `isStaleEcho`

A server record is stale when the synced store holds a newer `updated` for the same key. PocketBase can redeliver or reorder realtime echoes, and a slow mutation response can resolve after a newer echo. Strictly older, never equal: PocketBase bumps `updated` on every write, so an equal timestamp is the same version of the row, and re-landing it is what clears a lingering optimistic overlay.

An earlier `<=` variant on the query-result path guarded against a read carrying old content under a new timestamp, which a real server cannot produce. The revert it chased was the write-back racing its own transaction, fixed by the write-back timing above.

`shouldDrop` guards the synced write path pbtsdb does not control. `applySuccessfulResult` reconciles every query result into the synced store with no recency or optimistic check, so under on-demand contention a subset read can resolve with a pre-mutation row after the row moved on. A synced insert or update is dropped when it targets a key with a pending optimistic mutation, or when it is strictly older than the synced row. Only a key already in the synced store is guarded by the optimistic arm: a write to a key the store lacks is populating it, and dropping it would leave the row absent once the overlay clears. pbtsdb's own writes skip the optimistic arm; they are filtered for staleness upstream.

## Delete echoes

`src/build-collection.ts`: `handleRealtimeEvent`

`writeInsert` and `writeUpsert` never throw on an absent key. `writeDelete` throws `DeleteOperationItemNotFoundError` when the key is already gone from the synced store. That happens in two cases:

1. On-demand sync. Each live query refetches with a server filter, and `query-db-collection` prunes rows no longer owned by any active query. If that prune runs before this client's own delete echo lands, the key is gone. Eager collections have no second writer to the synced store, so they cannot hit this.
2. A redelivered SSE delete after a reconnect, for a key already deleted.

In both cases the row is already in its intended end state, so the echo is a no-op. Any other error is rethrown.

## Pending filings

`src/fetch-records.ts`: `expectFiling`, `awaitPendingFiling`, `fetchItems`

A correlated subquery over a relation target (a `materialize` include keyed off the parent row's id) can have its own `loadSubset` dispatched by TanStack DB's query planner before the parent's fetch, the one that would file and mark that exact subset, has resolved.

A parent fetch calls `expectFiling` on each back-relation target to say it may mark a field once its `upsertExpanded` settles. The target's own `fetchItems` awaits those registrations before requesting a not-yet-loaded subset on that field. The registration resolves once filing settles either way, including on the error and autocancel paths, so a waiter is never left hanging.

Invariant: a fetch that registers pending filings never waits on them. A fetch's own active expand can register filings on other targets; if it also waited, two mutually back-related collections would each register before either awaits and then wait on each other forever.

## Loaded-subset marks

`src/loaded-subsets.ts`: `forgetRow`, `invalidateAll`

A mark records that every row with `field === value` is in the store, so a subset query on that field is served without a request. A subset query that resolved once is served from `query-db-collection`'s observer cache on the next mount regardless of marks, so forgetting a mark must also invalidate that cached query. Releasing every mark on a real subscription stop invalidates them all for the same reason.

`forgetRow` defers its invalidation with `queueMicrotask`. It runs inside the guarded sync write, which is inside TanStack's write batch, and `invalidateQueries` can start a `queryFn` synchronously up to its first await. That must not re-enter `fetchRecords` mid-batch.

## Realtime client

`src/realtime-client.ts`: `createRealtimeClient`; `src/transport.ts`: `transportFor`, `realtimeClientFor`

pbtsdb opens its own SSE connection to `/api/realtime`, one per `PocketBase` instance, instead of the SDK's. The SDK's client could not do three things pbtsdb needs: carry query parameters on the connection URL (resume), drop a topic the server rejects (it re-sends it with every later request, which then fails), and tell a caller when the server has a topic.

Topic changes made in one tick go out in one `POST /api/realtime` with the whole list, which is what the server expects; an unchanged list sends nothing. `subscribe` resolves after that POST, so `realtime-subscription.ts` opens every wanted entry with `Promise.all` and a load can order itself after the topic. A topic over `REALTIME_TOPIC_MAX_LENGTH` rejects before any request, with `RealtimeTopicTooLongError`. `disconnect()` run before a pending `subscribe` is confirmed rejects it with `RealtimeDisconnectedError`.

The connection carries no auth; the POST does, through `pb.send`. The client id comes from `lastEventId` on `PB_CONNECT`, as in the SDK. Every event may carry a `seq`; the client keeps the last one and reconnects with `?resume=<clientId>&after=<seq>`. A server that replays the gap answers `PB_CONNECT` with the same id and `resumed: true`; the client then neither re-POSTs nor reloads, and the server-confirmed topic list survives the close. Stock PocketBase ignores the parameters, answers with a new id, and the client re-POSTs the topic list and tells each collection to refetch, because every event of the gap is lost. PocketBase closes every SSE connection after 30 minutes and after 5 idle minutes, so this happens on a schedule, not only on failures.

The refetch listener in `build-collection.ts` is registered when the collection starts syncing (`loading` or `ready`) and removed when it reaches `cleaned-up`, so a long-lived `pb` does not accumulate one listener per `buildCollection` call.

React Native has no `EventSource`; the client reads `globalThis.EventSource` at connect time, so a polyfill installed before the first subscription (tinycld uses `react-native-sse`) is picked up.

## Sync-session refs and holds

`src/realtime-subscription.ts`: `retainQueryFilters`, `resetQueryFilters`, `swapHoldFilters`; `src/build-collection.ts`: `holdLive`

TanStack drops a discarded sync session's demands without calling `unloadSubset` and reloads them on the next session, so sync cleanup zeroes the query filter refs. Held-target refs live apart because a hold outlives the sync session.

The realtime topic and filter caps live in `src/pocketbase-limits.ts`. A filter over the cap is recorded in `oversizedFilters` and the collection widens to `'*'`, because a topic over the cap is never sent: the client rejects it client-side (`RealtimeTopicTooLongError`).

## Realtime filter per chunk

`src/realtime-where.ts`: `realtimeWhereFor`

TanStack composes a boundary tie-check as `and(subscription.where, extra)` and loads it through the same subscription; it sends a cursor page with `where === subscription.where`. pbtsdb reads the subscription's base where through its private `options.whereExpression`, and retains that base where for both, so every chunk of one query shares one realtime entry. A join or include loads its lazy side as `inArray(joinKey, keys)`, and the key is a foreign key as often as `id`, so the operator, not the field, marks a batch: an `in` extra keeps its own filter, or realtime would never cover the batch. A tie-check is never a top-level `in` (`eq`, `and(gte, lt)` for a Date, or `or(isNull, isUndefined)`). If `options` or its `whereExpression` key is absent, the shape has changed under pbtsdb and it degrades to the per-chunk where rather than widening to `'*'`.
