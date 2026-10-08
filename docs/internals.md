# Internals

Design notes for the parts of the collection runtime whose reason is not visible in the code. Each section names the module and functions that hold the behavior.

## Ledger

`src/ledger.ts`: `createLedger`, `retain`, `release`, `replace`, `releaseAll`; `src/membership.ts`: `land`, `reconcile`, `confirm`, `drop`, `dropAll`

pbtsdb is the only writer to the collection's synced store, through the sync session's `begin`, `write` and `commit`. The ledger holds a copy of every row in the store together with the holders that reference it. A holder is one of: a loaded subset (the `LoadSubsetOptions` object core passes to `loadSubset` and `unloadSubset`), a realtime topic (`'*'` or a filter string), a parent's hold (the parent's holder token), or the `ACCEPTED` sentinel for rows a mutation write-back or `accept()` landed. In eager mode the whole collection is one holder, `EAGER`.

Rules:

1. A row enters the store the first time any holder references it.
2. A row leaves the store when its last holder releases it. Nothing else deletes a row.
3. A reload of a subset replaces that holder's set: rows absent from the new result lose that holder only.
4. A row strictly older by `updated` than the stored row is not stored; its holder is still added. Equal or newer replaces the row. PocketBase bumps `updated` on every write, so equal is the same version, and landing it again is what clears a lingering optimistic overlay.
5. A delete event on a filter topic releases that topic, every subset whose base `where` is that topic, and `ACCEPTED`. A delete on `'*'` and a delete mutation release every holder. The tinycld fork sends a `delete` carrying only the id to a subscription a row stops matching, so a row that leaves one filter stays while another holder references it.
6. The ledger evaluates no predicates. The server decides membership, through a load result or a realtime topic. One exception: after a fresh, complete load result (no `limit`, `cursor` or `offset`), `load` in `src/sync-adapter.ts` evaluates the demand's `where` on the client with `compileSingleRowExpression`. A row that `ACCEPTED` or one of the demand's filter topics held before the fetch, that did not change during the fetch, that matches `where`, and that the result omits, loses its `ACCEPTED` and filter-topic holders. The `'*'` topic is never released this way. Subset, parent and `EAGER` holders stay. A row accepted with no realtime coverage, then deleted by another client, would otherwise stay until `reload()`.

In on-demand mode, `ACCEPTED` is released in full when realtime goes idle (`releaseAll`, the `onIdle` path in `src/build-collection.ts`), because no realtime topic is left to correct its rows.

A topic holder is released when its realtime entry is closed and the topic is no longer wanted (`onEntryClosed`, on-demand mode only; an eager store keeps it until `reload()` or cleanup). A restart reopens the same topic and keeps the holder.

A row can stay in the store after it stops matching a filter until the subset reloads or a holder releases it. Live queries apply their own `where`, so this costs memory, not correctness.

With `rowUpdateMode: 'full'`, TanStack DB keeps the written object as the stored row. The ledger writes a new object for every insert and update (an update merges the incoming row into the stored one, so a partial realtime payload from a `fields` option drops no field), and the ledger row is that object. So the ledger row equals core's stored row, a caller's later in-place change cannot reach the store, and pbtsdb stays clear of the development-only `SyncRowReusedWithoutPreviousValueError`.

Membership changes the ledger and writes the sync transaction as one unit. If a write throws, the ledger rolls back (`track`, `rollback`), so the two never disagree. A release of `ACCEPTED` from rows a subset or `EAGER` just retained goes through membership too (`reconcile`'s `releaseAlso`, `confirm`); it can remove no row, and membership throws if it does. `load` does that release only after its last abort check, so an aborted load keeps a freshly accepted row's holder.

Persistence wrappers (a TanStack DB collection that persists the synced store and restores it on start) are not supported: a restored row has no holder in the ledger.

## Sync adapter

`src/sync-adapter.ts`: `loadSubset`, `unloadSubset`, `reload`, `cleanup`

`loadSubset` translates the options with `toRequest` and retains the subset's realtime filters. If the store serves the subset and nothing changes, it returns `true` synchronously. Otherwise it fetches, `reconcile`s the subset holder and awaits the visibility receipt. `options.refetch` skips the store. An aborted load rejects with `LoadSubsetOperationAbortedError`, also when its rows were already accepted. A load whose demand was unloaded installs nothing. A load superseded by a newer load of the same demand (`seq`) installs nothing and resolves with the newer load, so it never resolves before the newer rows land. `unloadSubset` parks the demand for `subsetGcTime`: its holder and realtime filters stay, so an equal demand (same request and same filters, `keyOf`) that loads within the window adopts the rows in one transaction (`reconcile` onto the new holder, releasing the parked one and `ACCEPTED`) and returns `true` with no request; a load with `refetch` adopts and then fetches. The timer, a second unload, a reload or cleanup expires the parked demand: holder dropped, filters released. A parked demand stays in `run.demands`, so a delete on its topic still reaches its rows. Only a demand whose rows landed parks: an aborted or still-running load expires at once, so a remount fetches instead of adopting an empty subset. An auth record change (`transport.onAuthChange`) runs before the realtime session resets: it expires every parked demand, drops `ACCEPTED` and its timers, and reloads every syncing collection under the new auth whether or not realtime is connected, so the order of a logout's calls does not matter and a load in flight across the change is superseded. The reconnect that follows reloads once more, coalesced. A load that fails retries after each delay in `loadRetryDelays`, the last delay repeating (`fetchWithRetry`), because a live query that has entered the error state never leaves it, not even when the rows arrive later; keeping the promise pending keeps it loading instead. Every `reload()` call wakes the sleeping retries at once, also when it only queues behind a reload in flight, and a newer load of the demand supersedes the woken retry, which resolves with it; a reconnect on a collection still loading wakes its eager retry. A 4xx the server meant, other than 401, 408 or 429, is not retried and rejects at once; a 401 waits with no timer until a wake, which the auth change's reload gives it. Delays carry up to a quarter of jitter either way. An unload or cleanup wakes and ends the retry. A parked demand adopted while a reload is in flight is fetched again, since its rows predate the reload. `unloadSubset` is idempotent and never throws.

Each `sync()` call is a run with its own `AbortController`. Every fetch carries the run's signal, and every async path checks it before it writes, so a late result from a discarded run never writes into the next one. `cleanup` aborts the run first. It runs only inside the collection's own cleanup, which also clears the synced store, so it clears the ledger and marks and writes nothing. Core calls `unloadSubset` before it emits `unsubscribed`, so only `unloadSubset` releases.

A delete event, or a delete mutation, is recorded against the fetches in flight it can speak for (`noteDeleted`): a delete on `'*'` or a delete mutation against every fetch, a delete on a filter topic only against fetches for demands that hold that filter, since a row that left one filter may still belong to another subset. The fetch drops those ids from its result before the reconcile, because the server may have run the query before the delete.

`reload` refetches every live demand from the server (the whole collection in eager mode). It then releases the topic and `ACCEPTED` holders it saw before the fetch, for the rows the results did not confirm. Rows the results confirmed have a subset holder and stay; the others leave. It is the recovery path after a lost event, after a reconnect the server did not resume, and after losing access to rows, which PocketBase reports with no event. Calls made while a reload is in flight share one follow-up reload that starts when the current one settles, so a burst of mutations under `refetchOnMutation` costs two reloads, not one per mutation.

`reload()` and `accept()` resolve when their rows are accepted, through `whenSyncAccepted(receipt)`, not when they are visible. Core holds every sync transaction while a mutation on the collection persists, so a handler that awaited visibility would wait for itself.

In on-demand mode `markReady` runs when sync starts. In eager mode it runs when the first full load is accepted; a failed first load calls `markError`, unless the run was aborted.

## Write-back timing

`src/build-collection.ts`: `landServerRows`

TanStack DB drops a transaction's optimistic state when its handler settles. A row the server fills in (a number, a timestamp) must be in the synced store by then, so the built-in handlers land the server's rows from inside the handler under the `ACCEPTED` holder. The receipt is not awaited: the transaction is accepted at `commit()`, and it becomes visible when the handler's transaction settles. The ledger drops a row the store already supersedes, because a realtime echo may have landed a newer copy while the request was in flight.

`ACCEPTED` is a bridge: the echo gives the row a topic, the next load a subset. When `subsetGcTime` ends, `settleAccepted` hands the row to every live, landed demand whose `where` matches it on the client (`adapter.holdersFor`; `EAGER` in eager mode) and then drops `ACCEPTED`. A `where` the client cannot compile or evaluate counts as a match here, the opposite of the rule 6 release, because the safe answer when unsure is to keep the row. The hand-off checks `where` only: a row outside a demand's `limit` or `orderBy` window is held by that demand for its life, never shown, and released when the demand unloads. A row no live query matches leaves; a row the user still sees stays even when no echo came, because realtime was down or the event was lost. This is the second place a client predicate decides a holder, and it is safe in the same direction as rule 6: the row is one the server wrote, so no row the server lacks can enter through it, and a client predicate laxer than PocketBase's only keeps a row the live query would show anyway. `accept(rows)` is the same path made public, for rows a custom endpoint returns. `evict(ids)` is the delete handler's path made public: it tombstones the ids for every fetch in flight (`noteDeleted`) and releases every holder. Both await acceptance only, so a custom handler can await them.

## Pending filings

`src/fetch-records.ts`: `expectFiling`, `awaitPendingFiling`, `fetchItems`

A correlated subquery over a relation target (a `materialize` include keyed off the parent row's id) can have its own `loadSubset` dispatched by TanStack DB's query planner before the parent's fetch, the one that would file and mark that exact subset, has resolved.

A parent fetch calls `expectFiling` on each back-relation target to say it may mark a field once its `upsertExpanded` settles. The target's own `fetchItems` awaits those registrations before requesting a not-yet-loaded subset on that field. The registration resolves once filing settles either way, so a waiter is never left hanging.

Invariant: a fetch that registers pending filings never waits on them. Two mutually back-related collections would otherwise wait on each other forever.

## Filed rows and holds

`src/expand-filing.ts`: `upsertExpanded`; `src/held-targets.ts`: `setFiled`, `forgetParentRow`; `src/build-collection.ts`: `writeFiled`, `releaseFiled`, `holdLive`

A parent files expanded rows into a target under the parent's holder token. The parent's hold on the target carries the same token, and releasing the hold releases every row filed under it. A target's own live query that the marks serve from the store takes its own subset holder on those rows, so they outlive the parent's hold while the target still shows them.

Filings are tracked per root row of the parent collection, per target, per expand path (`setFiled`; `author`, `author.publisher`). A nested level is keyed by the root row too, so a root leaving releases its whole subtree, and every level writes its children before itself. A filed row stays in the target while at least one parent row in the parent's store files it, and the hold's realtime filters cover exactly the current filings: the filed ids for a forward relation, the parent id for a back-relation (kept while the parent is filed, even with no children, so new children arrive). Three things end a filing:

1. The parent row leaves the parent's store (`forgetParentRow`, from the parent membership's `onRemoved`): a subset unload, a delete, a reload that omits it.
2. A parent fetch or echo that requested the expand key no longer carries it, or carries different rows (`upsertExpanded` reconciles against the paths the request asked for; a key the request did not ask for is left alone). PocketBase omits an unreadable or empty relation, so lost access to the related row ends the filing on the parent's next fetch or echo.
3. A delete event on the hold's filter topic in the target (`holdersByFilter` in `build-collection.ts`): the row is gone or no longer matches, so every parent whose hold covers that topic releases it.

Order: relations first, then the parent, then the release of relations the parent stopped referencing (`fileExpanded` returns a `FilingChange`; `install`, `loadEagerRows` and the echo handler `commit` it after the parent lands). A result that is discarded (aborted, unloaded, superseded, or landed in a run that ended) `undo`es it instead: the previous filings are restored and the rows the result wrote are released, so a thrown-away result changes nothing, and the old parent still in the store keeps the relation it points at. An undo is skipped when a later change already replaced the filing. Each intermediate state is one a screen could show, the old relation then the new one, so a reader never sees a parent without its relation and React never unmounts the joined row. The order is by sync write, not by visibility: while a mutation is persisting on the target collection, core holds the target's sync transactions until it settles, so the filed row becomes visible after the parent for that long. A filing that throws part-way undoes what it filed. The echo handler waits for the filing only when there is something to file and every target is already syncing (`canFileFirst`); with nothing to file the parent lands synchronously, and a target that would have to start first would hold the parent back for a load, so the parent lands first in that case too.

A parent record the ledger would drop as stale (an `updated` older than the stored row), or one deleted while its fetch was in flight (`adapter.isDeleted`), reconciles no filings (`isStale` in `createExpandFiler`). Otherwise a slow result would re-file the relation an echo already replaced, or file rows under a parent that never enters the store.

Rows whose last filing ends are released from the target through `releaseFiled`, which drops the parent's holder only; a subset or topic that still holds the row keeps it. The `'*'` exclusion in the target's reload is unchanged: a target `reload()` never releases parent holders, because the parent owns its filings and reconciles them on its own reload.

## Loaded-subset marks

`src/loaded-subsets.ts`

A mark records that every row with `field === value` is in the store, so a subset query on that field is served without a request. A row that leaves the store forgets the marks it belonged to. Every mark is cleared when the collection cleans up, because without a live subscription back-relation children can appear server-side unseen.

## Sync-session refs and holds

`src/realtime-subscription.ts`: `retainQueryFilters`, `resetQueryFilters`, `swapHoldFilters`; `src/build-collection.ts`: `holdLive`

TanStack drops a discarded sync session's demands without calling `unloadSubset` and reloads them on the next session, so sync cleanup zeroes the query filter refs. Held-target refs live apart because a hold outlives the sync session.

The realtime topic and filter caps live in `src/pocketbase-limits.ts`. A filter over the cap is recorded in `oversizedFilters` and the collection widens to `'*'`, because a topic over the cap is never sent: the client rejects it client-side (`RealtimeTopicTooLongError`).

## Realtime filter per chunk

`src/realtime-where.ts`: `realtimeWhereFor`

TanStack composes a boundary tie-check as `and(subscription.where, extra)` and loads it through the same subscription; it sends a cursor page with `where === subscription.where`. pbtsdb reads the subscription's base where through its private `options.whereExpression`, and retains that base where for both, so every chunk of one query shares one realtime entry. A join or include loads its lazy side as `inArray(joinKey, keys)`, and the key is a foreign key as often as `id`, so the operator, not the field, marks a batch: an `in` extra keeps its own filter, or realtime would never cover the batch. A tie-check is never a top-level `in` (`eq`, `and(gte, lt)` for a Date, or `or(isNull, isUndefined)`). If `options` or its `whereExpression` key is absent, the shape has changed under pbtsdb and it degrades to the per-chunk where rather than widening to `'*'`.

## Realtime client

`src/realtime-client.ts`: `createRealtimeClient`; `src/transport.ts`: `transportFor`, `realtimeClientFor`, `resetRealtime`, `getSyncStatus`; `src/sync-status.ts`: `createSyncStatusStore`

pbtsdb opens its own SSE connection to `/api/realtime`, one per `PocketBase` instance, instead of the SDK's. The SDK's client could not do three things pbtsdb needs: carry query parameters on the connection URL (resume), drop a topic the server rejects (it re-sends it with every later request, which then fails), and tell a caller when the server has a topic.

Topic changes made in one tick go out in one `POST /api/realtime` with the whole list, which is what the server expects; an unchanged list sends nothing. `subscribe` resolves after that POST, so `realtime-subscription.ts` opens every wanted entry with `Promise.all` and a load can order itself after the topic. A topic over `REALTIME_TOPIC_MAX_LENGTH` rejects before any request, with `RealtimeTopicTooLongError`. `disconnect()` run before a pending `subscribe` is confirmed rejects it with `RealtimeDisconnectedError`.

The connection carries no auth; the POST does, through `pb.send`. The client id comes from `lastEventId` on `PB_CONNECT`, as in the SDK. Every event may carry a `seq`; the client keeps the last one and reconnects with `?resume=<clientId>&after=<seq>`. A server that replays the gap answers `PB_CONNECT` with the same id and `resumed: true`; the client then neither re-POSTs nor reloads, and the server-confirmed topic list survives the close. Stock PocketBase ignores the parameters, answers with a new id, and the client re-POSTs the topic list and tells each collection to refetch, because every event of the gap is lost. PocketBase closes every SSE connection after 30 minutes and after 5 idle minutes, so this happens on a schedule, not only on failures.

The refetch listener in `build-collection.ts` is registered when the collection starts syncing (`loading` or `ready`) and removed when it reaches `cleaned-up`, so a long-lived `pb` does not accumulate one listener per `buildCollection` call.

React Native has no `EventSource`; the client reads `globalThis.EventSource` at connect time, so a polyfill installed before the first subscription (tinycld uses `react-native-sse`) is picked up. The client observes connection errors through `addEventListener('error')`, not the `onerror` property, because `react-native-sse` dispatches to listeners only.

`reset()` (`resetRealtime(pb)` at the `transport.ts` level) exists because the connection carries no auth of its own and an unchanged topic list sends no POST: a `pb.authStore` change (login, logout, switching users) is otherwise invisible to it, and the server would keep serving the previous session's subscriptions, or reject the next POST with a 403 because the auth record differs from the connection's. `transport.ts` watches `pb.authStore.onChange` and calls `reset()` when the auth record id changes; a token refresh for the same record does nothing. `disable()` (`disconnectRealtime(pb)`) forgets the session the same way and keeps the client closed: `connect()` is a no-op until `enable()`, which `resetRealtime(pb)` calls. Registrations stay, so a re-enable resumes every topic as a reconnect. A `subscribe` made while disabled registers and resolves at once, since nothing can confirm it; the subscription module then opens and closes entries as usual, so topics leave when their queries do and idle cleanup runs offline. `reset()` keeps every `listeners` registration — unlike `disconnect()`, which also rejects pending waiters and clears them — and forgets only the server-side session (`confirmed`, `clientId`, `lastSeq`, any pending reconnect timer), then connects again at once if any topic is registered. The new connection has no client id, so it is a first connect for the server; pbtsdb still treats it as a reconnect for its own purposes (`everConnected` is set when any connection opens and is left `true` by `reset()`), so `onReconnect(false)` fires once that POST succeeds and every ready collection refetches, the same as a non-resumed reconnect after a dropped connection.

## Sync status

`src/sync-status.ts` holds one `SyncStatusStore` per PocketBase client, created in `transport.ts` next to the realtime client. The store pulls, never pushes: `refresh()` reads `client.status()` and every registered load source, diffs the result against the last snapshot by value, and only then replaces the snapshot and notifies. Sources may call `refresh()` freely, including when nothing changed, which keeps the transitions in the realtime client and the sync adapter simple; the diff is what makes `useSyncExternalStore` safe. A nested object (`realtime`, `loads`) is reused when its values did not change.

The realtime client derives `status()` from its existing state: `disabled` while `disable()` is in effect or no connection and no reconnect timer exists (no topics yet, or the last topic left), `connected` once `PB_CONNECT` arrived, `reconnecting` while `lostAt` is set, else `connecting`. `lostAt` is set by the first `scheduleReconnect` of an episode and cleared only when a connection's POST succeeds, so a connect whose re-POST fails keeps the episode's `since`; `nextRetryAt` is written in `scheduleReconnect` alone, so it holds while a retry attempt is in flight. `reset()` and `disable()` clear it: the connection they open is a first connect for the status, since no retry is scheduled.

Each collection registers `adapter.loadStatus` with `transport.addLoadSource`, which returns the `refresh` the adapter calls as `onLoadStatusChange`. The adapter derives `loadStatus()` from per-demand fields: `retryingSince`, set when `retryAllowed` starts a sleep and kept across the demand's further retries, and `failed`, set when the error is not retried. Both clear when a newer load of the demand starts; `retryingSince` also clears in a `finally` once the loading sequence ends, so a woken retry that loads is uncounted the moment it resolves. A parked demand is skipped, and `expire`, `unpark` and `cleanup` refresh so an unloaded demand leaves the count. The eager load keeps the same two fields on the run.
