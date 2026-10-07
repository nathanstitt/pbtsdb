# Design: pbtsdb as a core sync adapter

Status: proposal, 2026-10-06. Not started. PR #23 (TanStack DB 0.12 on
query-db-collection) stays open as the bridge while this is built.

## Goal

Build pbtsdb on `@tanstack/db`'s core `SyncConfig` instead of
`@tanstack/query-db-collection`. pbtsdb then owns row membership itself. No
query cache, no refetch on a realtime event, no dependence on TanStack
internals.

The query-side API (`useStore`, `materialize`, `relations`,
`alwaysFetchRelations`, `fetchRelations`, `onDemand`) does not change. The
write-side API changes: see "Public API".

## Why

query-db-collection 1.3 made every direct write on an on-demand collection
refetch every active query. pbtsdb applies every realtime echo, write-back
and filed relation row as a direct write. PR #23 avoids the refetch by
claiming rows into every cached query through `setQueryData`, which is the
pre-1.3 model TanStack removed on purpose, and it reads accepted-row
accessors TanStack does not document.

Most of `docs/internals.md` describes pbtsdb working around
query-db-collection's ownership, not PocketBase. The sections that exist
only because of query-db-collection:

| Section | Cause | Under this design |
|---|---|---|
| Confirmed rows and in-flight fetches | `applySuccessfulResult` deletes rows a result omits | Gone. A result only releases a ref; a row with another ref stays. |
| Staleness: `shouldDrop` | query results reconcile with no recency check | Gone. pbtsdb writes every row and checks `updated` once, in one place. |
| Delete echoes, case 1 | on-demand prune races the echo | Gone. Only pbtsdb deletes rows. |
| Loaded-subset marks: observer-cache invalidation and the microtask | react-query serves a cached query without asking the marks | Gone. No observer cache. |
| Authoritative writes, ownership claim (PR #23) | cache ownership of written rows | Gone. The ledger owns rows. |
| `tanstack-internals.test.ts` | pinned undocumented behaviour | Deleted. |

What stays: write-back timing (a core TanStack rule), pending filings,
sync-session refs and holds, realtime filter per chunk, PocketBase limits,
the query converter, expand filing, views.

## The core sync contract (TanStack DB 0.12)

`sync(params)` receives `begin`, `write`, `commit`, `markReady`,
`markError`, `truncate` and `collection`. It returns `{ cleanup,
loadSubset, unloadSubset }`.

Rules pbtsdb must keep:

- `loadSubset(options)` returns `true` when the subset is already in the
  store, or a promise that settles after every `commit()` that establishes
  the subset is visible. The result describes only the exact `options`
  passed.
- `options.signal` aborts a request that is no longer current. Stop before
  installing more rows. If a request cannot stop, settle after its writes
  are visible.
- `unloadSubset(options)` releases exactly what the matching `loadSubset`
  acquired. It is idempotent and never throws. Core calls it once per
  acquisition and does not retry.
- `options.subscription` identifies the live query. It is undefined for a
  direct call.
- A discarded sync session gets `cleanup()` and no `unloadSubset` calls:
  a release checks that its load session is still current first. The
  store is cleared in the same pass, and the next session reloads every
  demand.
- `subscription.unsubscribe()` releases every active acquisition, which
  calls `unloadSubset`, and only then emits `unsubscribed`. The ledger
  must listen to one of them, not both.
- `commit(signal)` returns `true` or a receipt that resolves when the
  writes are visible. A load must await its receipts.
- `whenSyncAccepted(receipt)` (exported from `@tanstack/db`) resolves when
  the transaction is accepted, at `commit()`. Core holds every sync
  transaction while any transaction on the collection persists, so a
  receipt from inside a mutation handler becomes visible only after that
  handler settles. Every path a handler can reach awaits acceptance, not
  visibility. Readiness also counts accepted rows.
- Mutation handlers: 0.12 drops optimistic state when the handler settles.
  The confirmed row must be in the synced store before then.

## Membership: the ledger

One module, `src/ledger.ts`, replaces the query cache as the owner of rows.

A row is in the collection while at least one holder references it. A
holder is one of:

| Holder | Created by | Released by |
|---|---|---|
| Subset | `loadSubset(options)` | `unloadSubset(options)`, or a reload of the same subset whose result omits the row |
| Realtime topic | a create or update event delivered on that topic's filter | the topic's realtime entry closing while the topic is no longer wanted (on-demand mode), or `reload()` for rows its results do not confirm |
| Hold | a parent's `holdLive()` on a relation target, per filed row | `release()` on the hold |
| Accepted | a write-back after persist, an insert echo for this client's own pending row, or `accept(rows)` from the application | the next subset reload or realtime event that covers the row, a fresh load whose `where` matches the row and whose result omits it (rule 6 exception), realtime going idle (on-demand mode), or `reload()` |

Rules:

1. A row enters the synced store the first time any holder references it,
   through `begin` / `write({ type: 'insert' })` / `commit`.
2. A row leaves the synced store when its last ref is released, through
   `write({ type: 'delete' })`. Nothing else deletes a row.
3. A reload of a subset computes the difference against that subset's
   previous ref set. Rows absent from the new result lose that subset's
   ref only. This replaces `applySuccessfulResult`.
4. A write of a row already present is an `update` if the incoming
   `updated` is strictly newer, or equal. A strictly older row is dropped.
   This is the one staleness check, and it is the same rule for echoes,
   write-backs, filed rows and results (see `docs/internals.md`,
   "Ledger", rule 4).
5. A delete event releases the delivering topic's ref, the refs of every
   subset whose base `where` is that topic, and the accepted ref. It does
   not touch other topics' refs. A real delete reaches every topic that
   saw the row, so every ref goes and the row is deleted. A leave event
   (the tinycld fork sends a `delete` with only the id to a subscription
   that a row stops matching, see `realtime_leave.go`) reaches one topic,
   and the row stays while another topic or hold refs it. A delete
   mutation removes every ref.
6. The ledger does not evaluate predicates. It never decides that a row
   matches a filter. The server decides, through a load result or a
   realtime topic.

   Exception: `load` evaluates a demand's full `where` on the client
   (`compileSingleRowExpression`) after a fresh, complete server result
   (no `limit`, `cursor` or `offset`, not served from the store). A row
   that `ACCEPTED` or one of the demand's filter topics held before the
   fetch, that did not change during the fetch, that matches `where` and
   that the result omits, loses its `ACCEPTED` and filter-topic holders.
   The `'*'` topic is never released this way. Subset, parent
   and `EAGER` holders stay. Without this, a row accepted after a move
   and then deleted by another client stays on screen until `reload()`.
   In on-demand mode, `ACCEPTED` is also released in full when realtime
   goes idle, because no realtime coverage is left to correct its rows.

Rule 6 is why a row can stay in the collection after it stops matching a
filter, until the subset reloads or a holder releases it. This is the same
exposure PR #23 has. It is acceptable because live queries apply their own
`where` on the client, so an extra row in the collection is not an extra
row on the screen. Memory, not correctness, is the cost.

A client-side predicate is available if the cost ever matters:
`@tanstack/db` exports `compileSingleRowExpression` and
`toBooleanPredicate`. A later step may use them to release a subset's ref
from a row that an update event moves out of that subset's `where`. Not in
scope for the first version.

### Subset identity

Core passes the same `options` object to `loadSubset` and `unloadSubset`.
Today `build-collection.ts` keys retained realtime filters on that object
in a `WeakMap`. The ledger keys subsets the same way, and keeps the
`PbRequest` from `toRequest(options)` as the request to send. Two
subscriptions with equal requests are two subsets with two ref sets, and
each sends its own request (see "Request coalescing").

## Flows

### loadSubset

1. Translate `options` with `toRequest`, including the view's expand paths
   (existing `registry.withViewExpand`).
2. Retain the subset's realtime filters (existing `retainQueryFilters`).
3. If the store serves it (existing `servedFromStore`: id subsets present,
   or a marked field subset, with no expand, cursor, or sort-with-limit):
   add refs for the served rows and return `true`.
4. Otherwise fetch (existing chunked `fetchPage` and expand filing). Honour
   `options.signal` between chunks.
5. In one `begin` / `commit`: write each result row by rule 4, then release
   this subset's previous refs that the result does not contain. Delete
   rows that reach zero refs.
6. Await the commit receipt. Mark the subset loaded (existing
   `subsets.mark`) when the request was a complete keyed subset.
7. On-demand: `markReady()` when sync starts. Eager: `markReady()` when
   the first full load is accepted; `markError(error)` if it fails. In
   eager mode the first load is the whole collection, as today.

### unloadSubset

Release the subset's refs and the realtime filters. Delete rows that reach
zero refs in one transaction. Idempotent: a second call finds no refs.

### cleanup

Core calls the session's `cleanup()` only from the collection's own
cleanup (GC after `gcTime` with no subscribers, or an explicit
`collection.cleanup()`), and that same pass clears `syncedData`. There is
no sync restart that keeps the store. So on `cleanup()` the ledger clears
every ref, every mark and every hold's filed state, and writes nothing.
Status becomes `cleaned-up`; the next demand starts a new session and
every live query reloads through `loadSubset`.

### Realtime event

Replaces `handleRealtimeEvent`'s `utils.write*` calls.

- `create` / `update`: `markConfirmedPresent` stays for the mutation hold.
  Apply rule 4. Add a ref for the topic that delivered the event. The
  realtime subscription already keeps one entry per filter; it must pass
  the entry's identity with the event.
- `delete`: remove all refs, write `delete` if the row is present. A delete
  for an absent key is a no-op, as today.
- Expand filing from an echo stays as it is.

### Mutations

`onInsert` / `onUpdate` / `onDelete` are unchanged in flow. The write-back
after persist writes through the sync channel instead of `utils.writeUpsert`
and takes an accepted ref. `refetchOnMutation` calls `reload()` from the
handler; the `{ refetch }` return value is deprecated upstream (#843) and
is dropped.

`reload()` and `accept()` resolve when their rows are accepted
(`whenSyncAccepted(receipt)`), not when they are visible. Core holds every
sync commit while a mutation on the collection persists, and a receipt
from inside a handler becomes visible only when that handler's
transaction settles. A handler that awaited visibility would wait for
itself and never settle. The write-back itself does not await its
receipt.

### Filed relation rows

`writeFiled` writes through the channel and takes a hold ref for the
parent's hold. The parent's `setFilters` and `release` already carry the
rows it filed, so the ledger can release them exactly.

### Application writes: `accept` and `reload`, not `utils.write*`

The `utils.writeInsert/Upsert/Delete/Batch` family is removed from the
public API. A direct write lets the application put a row in the store
with no holder and no staleness check, which is what the ledger exists to
prevent. tinycld boards is the only consumer, and it has two needs; a
custom delete handler adds a third:

1. **A custom endpoint returned the server's row.** `useMoveCardToBoard`
   and `useSprintLifecycle` call `pb.send` on a server endpoint, then
   `writeUpsert` the returned record so the screen updates before the
   realtime echo. A moved card may never get that echo on the source
   board's topic, because the row no longer matches its filter.

   New method: `collection.accept(rows)`. The rows are confirmed server
   state. They go through the staleness rule (rule 4), take an accepted
   ref, and run `markConfirmedPresent`, exactly as a mutation write-back
   does. `accept` is the write-back made public.

2. **The user lost access to rows.** `useMembershipSync` sees a project
   leave the membership query, then scans seven collections for
   `project === id` and `writeDelete`s the keys, because PocketBase sends
   no event for rows the user can no longer read.

   New method: `collection.reload()`. It reloads every live subset. Each
   result omits the revoked rows, their subset refs release, and rows at
   zero refs delete. The server decides what went away; the client does
   not scan. `reload` also releases accepted refs the results do not
   confirm, so it is the recovery path after any lost echo. It replaces
   `utils.refetch()` and `queryClient.invalidateQueries([name])`.

   Revocation is rare, so seven reloads at that moment is acceptable.

3. **A custom delete handler removed rows.** Until the delete echo
   arrives, the row would show again once the optimistic state drops.

   New method: `collection.evict(ids)`. The server deleted these rows.
   Release every ref of the given rows with no request, and tombstone the
   ids for every fetch in flight. The built-in delete handler uses the
   same path. A custom `onDelete` awaits it before it returns, as a
   custom `onInsert` awaits `accept`.

All three methods are on the collection and on `collection.utils` (typed
`PbCollectionUtils<T>`), on the collection's record type. Every upstream
adapter returns its functions in `utils`, which is where TanStack DB
devtools and users look for them.

### Request coalescing

Not in the first version. react-query deduplicated two identical in-flight
requests; under this design each demand sends its own request, so two
equal demands from two live queries cost two requests. Core already shares
one acquisition between the consumers of one live query, so the cost
arises only for distinct live queries with equal requests.

Upstream does not give pbtsdb a ready tool for this. query-db-collection
dedupes equal demands by a ref count on the hashed query key
(`query.ts:3022-3046`); powersync keys demands by the options object, as
pbtsdb does. Core's `DeduplicatedLoadSubset` does not fit: it shares an
in-flight request only when `options.signal` is absent, and core always
sets a signal in on-demand mode (`subscription.ts:936-953`); and its
completed set returns `true` for an equal demand until `reset()`, so after
an unload released the rows a remount would get `true` with no rows held.

Add coalescing after measuring: a map of in-flight `PbRequest` key to
promise, where a second demand awaits the first and then takes its own
refs from the result.

### Remount

react-query served a repeated query from its observer cache for `gcTime`
without a request. Under this design a remount reloads, except where
`servedFromStore` answers. Keyed subsets that are the heavy case
(relations, id lists) are served from the store today and stay so.

If the reload cost shows on a screen, add a small LRU of recent subset
results keyed by `PbRequest`, with a `staleTime`. Not in the first
version; measure first.

## Public API

Kept as is: every option in `CollectionOptions`, `refetchOnMutation`,
`syncMode`, `realtime`, `collectionOptions`, and every view method.

Changes (this is a major version):

1. `createCollection(pb, queryClient)` becomes `createCollection(pb)`.
2. `utils.writeInsert/Upsert/Delete/Batch` and `utils.refetch` are removed.
   `collection.accept(rows)` and `collection.reload()` replace them (see
   "Application writes").
3. `queryClient.invalidateQueries({ queryKey: [collectionName] })` no
   longer reaches pbtsdb. tinycld boards uses it in `useShareLinks.ts`;
   the replacement is `collection.reload()`.
4. `collectionOptions.gcTime` is forwarded to the core collection directly.
   The special case in `build-collection.ts` goes away.
5. Devtools: react-query devtools no longer show pbtsdb queries. The core
   collection is visible in TanStack DB devtools.

tinycld changes, contrary to the handoff's "no code change": the
`createCollection` call in core, three `invalidateQueries` calls in
`useShareLinks.ts`, two `writeUpsert` calls each in `useMoveCardToBoard.ts`
and `useSprintLifecycle.ts` (become `accept`), and the scan-and-delete in
`useMembershipSync.ts` (becomes `reload` on each child collection).

## The PocketBase SDK

pbtsdb uses a small part of `pocketbase` (0.27):

| Call | Where |
|---|---|
| `collection(name).getList` / `getFullList` with `filter`, `sort`, `expand`, `skipTotal`, `requestKey` | `fetch-records.ts` |
| `collection(name).create` / `update` / `delete` | `build-collection.ts` default mutation handlers |
| `collection(name).subscribe('*', handler, { filter, expand, ... })` and the returned unsubscribe | `realtime-subscription.ts` |
| Types `RecordSubscribeOptions`, `RecordSubscription` | public types |

The REST part is five endpoints and gives no trouble. What the SDK's
realtime client (0.27, checked in `pocketbase.es.mjs`) does and does not
do:

- It coalesces every `subscribe` and `unsubscribe` made in one microtask
  into one POST, and skips the POST when the topic list is unchanged.
  pbtsdb defeats this: `realtime-subscription.ts` awaits each open and
  close in sequence, so each one lands in its own microtask and its own
  POST. That is a pbtsdb bug, fixable without a new client.
- It reconnects without limit, with a 200 ms to 2 s backoff, and re-POSTs
  the topic list after `PB_CONNECT`. Events during the gap are lost and
  nothing reloads.
- A topic the server rejects (over 2500 characters) stays in its list and
  is re-sent with every later POST, which then fails. `pocketbase-limits.ts`
  predicts the cap to avoid this.
- The `EventSource` URL is fixed (`buildURL('/api/realtime')`), the client
  id is read from `lastEventId` on `PB_CONNECT`, and there is no hook to
  add query parameters. Resume cannot be done through the SDK.
- `unsubscribe` throws after a connection drop.
- Auto-cancellation aborts a sibling request with the same key, so every
  chunk carries its own `requestKey`.
- On React Native the SDK needs a global `EventSource`; tinycld supplies
  `react-native-sse` through generated bootstrap code.

Decision: **replace the SDK's realtime client with pbtsdb's own, as its
own PR on main, before the ledger.** The reasons, in order: resume needs
query parameters on the `EventSource` URL and a `seq` per event, which
the SDK cannot carry; a rejected topic must be dropped, not re-sent; and
`subscribe` should resolve when the server has the topic, so a load can
order itself after it. The POST coalescing is not a reason: pbtsdb gets
it from the SDK too once `doReconcile` opens and closes in parallel, and
that fix ships with the own client either way.

What stays on the SDK: the REST calls and the auth store. The own client
opens `GET /api/realtime` with no auth (the server does not need it) and
sets topics with `pb.send('/api/realtime', { method: 'POST' })`, which
carries the SDK's token. `createCollection(pb)` keeps taking the SDK
client.

Structure: `src/realtime-client.ts` is the client, one per `pb` instance.
`src/transport.ts` is the one internal interface pbtsdb calls for
realtime; the REST calls stay as direct `pb.collection()` calls until
there is a reason to move them.

## Fork protocol

tinycld runs a forked PocketBase, but pbtsdb is public and must work
against stock. The rule: a fork feature is acceptable only when the client
side is a parameter and a flag, never a second code path. Resume meets
that rule. Snapshot does not, and is not planned.

### Not planned: subscribe with snapshot

The fork could register a topic and return the list result in one
request. It would save one round trip per load. It is not planned,
because it is a second load path: pbtsdb would carry the one-call fork
order and the two-call stock order, both tested, for one round trip.

The race the snapshot would close is closed on stock by order alone:
open the topic, then fetch. A create that is both streamed and in the
result is a duplicate, absorbed by rule 4. A delete that streams before
the result is for a row the result already excludes.

### Resume


Stock PocketBase keeps no realtime history. A reconnect gets a new client
id, the topic list is re-posted, and every event during the gap is lost.

Server:

1. **Keep a detached client.** When the SSE request ends, mark the
   `subscriptions.Client` detached instead of removing it. Keep its auth
   and topic list for a grace period.
2. **Buffer while detached.** The broadcast path already evaluates each
   client's topic filter and API rules per event. For a detached client,
   append the evaluated message to a bounded per-client queue. Rules are
   applied at event time, which is the same semantics as a live stream.
3. **Resume.** `GET /api/realtime?resume=<clientId>&after=<seq>`. If the
   client exists, the auth record matches, and the queue has not
   overflowed: re-attach, send `PB_CONNECT` with the same id and
   `resumed: true`, replay the queue after `seq`. No topic re-POST.
4. **Fallback.** Otherwise send a fresh id with `resumed: false`.
5. Every event carries `id: <seq>`, per client, monotonic.

Client (pbtsdb's own realtime client):

- Remember the client id and the last `seq`. Reconnect with both.
- `resumed: true`: nothing else to do. A replayed duplicate lands under
  rule 4 and is harmless.
- `resumed: false`: re-POST the topic list, then `reload()` every
  subset.

Why not timestamps or tombstones: a per-client queue covers deletes and
needs no `updated` query, no tombstone collection and no scope rule. A
`last-connected-at` parameter only helps a global event log replayed
through filters at reconnect time, which re-evaluates rules late and is
more work.

Limits:

- Query parameters, not headers: the browser `EventSource` cannot set
  headers.
- Bind resume to the auth record, not only the id, so a leaked id cannot
  drain another user's queue.
- PocketBase is one process per org (tinycld runs a tenant process per
  org, evicted when idle), so an in-memory queue is enough, and a tenant
  eviction loses every detached client, which is the `resumed: false`
  path.

Sizing (`apis/realtime.go`, fork at upstream 0.40.4):

- Reconnects are routine, not rare. The server closes every SSE
  connection at `MaxTimeout` (30 min) and after `IdleTimeout` (5 min)
  with no message. Today each of those is a silent gap.
- The SSE `id:` field must stay the client id: the JS SDK reads the
  client id from `lastEventId` on `PB_CONNECT`. The per-client `seq` goes
  in the event payload as a top-level `seq` next to `action` and
  `record`. Stock clients ignore the extra key.
- Grace period: 5 minutes, the same constant as `IdleTimeout`. A gap
  shorter than that is a blip, a rotation or a tab switch, where resume
  pays. A longer gap is a suspended app, where a reload is acceptable
  and the data is stale-heavy anyway.
- Queue bound per detached client: 1000 messages or 1 MiB of payload,
  whichever first. A mail event carries a message row; a board event a
  card. Both are kilobytes. Overflow discards the client at once, so the
  reconnect gets `resumed: false` instead of a partial replay.
- Total bound per process: 64 MiB across detached clients, oldest
  discarded first. `MaxUsers` is per plan and zero means unlimited, so a
  per-client bound alone is not enough.
- The stock client channel is unbuffered and `Send` blocks on it. A
  detached client must swap the channel for the queue, or every
  broadcast stalls on it.
- Visibility loss is not covered, the same as on a live connection.
  `reload()` on revocation stays.

## Modules

| Module | Change |
|---|---|
| `src/ledger.ts` | New. Refs per row per holder, diff on reload, zero-ref deletes. |
| `src/synced-store.ts` (from PR #23) | Keep the channel attach/detach and `transact`. Remove `claim` and the query cache. |
| `src/build-collection.ts` | Replace `queryCollectionOptions` with a `SyncConfig`. Keep view registry, realtime wiring, holds, mutation handlers. |
| `src/fetch-records.ts` | Drop `queryClient` and `withRowsConfirmedMidFlight`. Return rows; the caller writes. |
| `src/loaded-subsets.ts` | Drop `queryClient` and both invalidation paths. Marks only. |
| `src/synced-write-guard.ts` | Drop `shouldDrop`, `trackFetch`, `withRowsConfirmedMidFlight`, `isOwnWrite`. Keep `isStaleServerRecord`, `markConfirmedPresent`, `writeBackAfterPersisted`. |
| `src/realtime-subscription.ts` | Pass the delivering entry with each event. Use `transport.subscribe`. |
| `src/transport.ts` | New. REST on the SDK, realtime on pbtsdb's own SSE client. The one module that imports `pocketbase`. |
| `src/request.ts` | Drop `queryKeyFor` / `requestFromQueryKey`; keep `toRequest`. |
| `test/tanstack-internals.test.ts` | Delete. |
| `docs/internals.md` | Rewrite: remove the four sections above, add "Ledger". |

Dependencies: `@tanstack/query-db-collection` and `@tanstack/react-query`
leave `peerDependencies`. `@tanstack/db` floor becomes 0.12.

## Acceptance

The existing test suite (254 tests on PR #23) is the acceptance bar. It
encodes every invariant pbtsdb learned the hard way. Tests pass unchanged
except where they reach into the react-query cache. Those tests, by file:

```
test/helpers.ts
test/basic.test.ts test/fetch-records.test.ts test/includes.test.ts
test/mutations.test.ts test/pagination.test.ts test/paging.test.ts
test/queries.test.ts test/relations.test.ts test/subscriptions.test.ts
test/subscribe-options.test.ts test/server-side-filtering.test.ts
test/realtime-mode.test.ts test/realtime-delete-echo.test.ts
test/query-result-revert.test.ts test/refetch-on-mutation-revert.test.ts
test/stale-absence-delete.test.ts test/test-collections.test.ts
test/fetch-relations.test.tsx test/react.test.tsx
```

Most of these only pass a `QueryClient` through `helpers.ts`. Audit each
for `getQueryCache`, `setQueryData`, `getQueryData` and `invalidateQueries`
before the swap, and replace those assertions with ledger assertions.

New tests the ledger needs:

- Two subsets share a row; unloading one keeps it; unloading both deletes it.
- A reload that omits a row releases only that subset's ref.
- A realtime create on topic A, then unload of subset B, keeps the row.
- A write-back after persist survives a late subset result that omits it
  (today's "confirmed mid-flight" case, now by ref).
- `unloadSubset` twice is a no-op.
- `cleanup` keeps held rows and clears subset refs.
- Equal concurrent loads send one request (deferred with "Request
  coalescing").
- `reload()` releases accepted refs the results do not confirm.
- `accept` of an older `updated` is dropped; `accept` of a new id inserts.
- Stale echo (older `updated`) is dropped; equal `updated` lands.

## Steps

1. Own realtime client, on main: `src/transport.ts` and the SSE client
   under `realtime-subscription.ts`. Same tests pass. Separate PR.
2. Branch from `main` after PR #23 (`chore/tanstack-db-0.12`) merges. It
   has the channel plumbing, the 0.12 test fixes and the own realtime
   client.
3. Write `src/ledger.ts` with its unit tests, against a fake channel.
4. Swap `build-collection.ts` to a `SyncConfig` behind the same
   `buildCollection` signature. Add `accept` and `reload`.
5. Move realtime, write-back, filing and direct writes onto the ledger.
6. Run the full suite. Fix tests that reached into react-query.
7. Delete the dead guard paths, `tanstack-internals.test.ts`, and the
   `queryClient` plumbing. Update `docs/internals.md`, `README.md`,
   `llms.txt`, `CHANGELOG.md`.
8. Point tinycld at the build (expo-57 workspace), make the boards
   changes listed under "Public API", run its e2e suites.
9. Major version bump.

## Open questions

1. Answered (PocketBase 0.29.3, `apis/realtime.go`): an update is
   checked against each topic's filter and the list rule on the row's
   state after the update. A row that leaves a filter gets no event on
   that topic; neither does a row the user can no longer read. Deletes
   are checked before the delete and sent after it succeeds. So a moved
   row keeps its old topic ref until the topic closes or the subset
   reloads, and the live query hides it on screen. The tinycld fork already
   covers this: `apis/realtime_leave.go` sends a `delete` carrying only
   the id to each subscription that saw the row before the update and not
   after, including rows hidden by a rule that reads a changed field. It
   does not cover a change in another table (membership revoke), which
   stays a `reload()`. Rule 5 is written so a stock delete and a fork
   leave need no distinguishing: both release the delivering topic.
2. Answered (0.12.1, `collection/subscription.js`): `unsubscribe()`
   releases each active acquisition through `unloadSubset` first, then
   emits `unsubscribed`. The ledger listens to `unloadSubset` only.
3. Answered (0.12.1, `collection/lifecycle.js`): the sync session's
   `cleanup()` runs only inside the collection's cleanup, which also
   clears `syncedData`. The ledger clears all refs on `cleanup()` and
   deletes nothing. See "cleanup" under "Flows".
4. Upstream: file an issue asking for a supported way for a sync source to
   write on-demand rows without a refetch. If it lands, it does not change
   this design; it only makes the bridge safer while this is built.
5. Answered: see "Sizing" under "Resume". Overflow discards the client
   at once.
6. Upstream: TanStack/db #1935 (maintainer proposal, open, 2026-09-28)
   is a `subscribe` option on `queryCollectionOptions` with a per-subset
   `write` and `invalidate`. It is the supported shape of what PR #23
   does by hand. A comment is drafted (not posted) asking that the
   per-subset write not refetch other holders and that `getVersion` be
   in the first cut. #2035 (closed) is the same symptom as PR #23's
   starting point; the maintainer's answer was "the refetch is by
   design". #843 (merged 2026-09-18) deprecates the `{ refetch }` handler
   return in favour of `utils.refetch()`; pbtsdb's handlers still return
   it, so PR #23 and this design must call `reload()` instead.
