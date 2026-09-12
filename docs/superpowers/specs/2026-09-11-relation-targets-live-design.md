# Relation targets stay live

Date: 2026-09-11. Follow-up to `2026-09-11-per-query-expand-design.md`,
landing on the same branch (`feat/per-query-expand`, PR #12).

## Goal

For a live query such as

```ts
const { data } = useLiveQuery(q => q.from({ books: books.expand('tags.colors') }))
```

1. The `tags` and `colors` collections keep realtime subscriptions while the
   query is live, so their stores stay fresh.
2. A change to a tag or a color updates the embedded copy on affected book
   rows in place, so `data[0].expand?.tags?.[i].name` refreshes without any
   write to the book itself. Nested copies update too.
3. Nothing leaks and nothing loops: subscriptions are released when the
   parent's last subscriber leaves, an unchanged echo produces no write, and
   propagation terminates on cyclic relation graphs.

## Background

After PR #12, expanded records are upserted into their target collections,
but a target only opens its realtime subscription when a live query reads
from it, and nothing writes a target's echoes back into the `expand` copies
on parent rows. The parent's own realtime subscription carries its expand
union, so a *parent* echo refreshes copies; a *target-only* change does not.

## Design

### Held subscriptions

When a collection's realtime subscription starts (`doStartSubscription`
after `subscribe` resolves), it computes the set of collections along every
path in its active expand union by walking `relationTargets` one segment at
a time, and holds a bare `subscribeChanges(() => {}, { includeInitialState:
false })` on each. TanStack DB then bumps the target's subscriber count,
cancels its GC timer, and starts its sync; pbtsdb's existing zero-to-one
`subscribers:change` handler starts the target's PocketBase realtime. No data
load is requested.

Held subscriptions live in one `Map<ExpandTargetCollection,
{ unsubscribe(): void }>` per collection, mutated only by
`syncHeldSubscriptions(desired: Set<ExpandTargetCollection>)`, which
subscribes targets in `desired` but not in the map and unsubscribes targets
in the map but not in `desired`. Start and restart pass the computed set;
stop (`doStopSubscription`) passes the empty set. Union growth already goes
through the restart path, so the held set follows it for free.

Holding a subscription on an eager target that has not started yet starts its
full load, which also removes today's "not syncing … store is not yet ready"
warning for that case.

`ExpandTargetCollection` (types.ts) gains
`subscribeChanges?: (callback: () => void, options: { includeInitialState: false }) => { unsubscribe(): void }`
and `subscriberCount?: number` for the runtime shape pbtsdb reads.

### Dependents registry

When `buildCollection` runs with `relations: { tags: tagsCollection }`, it
registers `{ field: 'tags', parent }` on `tagsCollection.relationDependents`,
an `@internal` runtime array next to `relationTargets`. Registration happens
once at creation, never per subscribe or per view, because the relation is a
static fact. `parent` exposes one internal method:

```ts
applyRelatedChange(field: string, action: 'create' | 'update' | 'delete',
                   record: { id: string }, visited: Set<string>): void
```

### Trigger

In the target's realtime handler, after its own batch write has been
applied (a delete echo whose record was already gone counts too: embedded
copies may still exist), it calls each dependent:

```ts
for (const { field, parent } of relationDependents)
    parent.applyRelatedChange(field, event.action, event.record, new Set())
```

wrapped so a throw logs with `logger.error` and neither escapes the handler
nor prevents the target's own write. Create, update, and delete all go
through; a create that nothing embeds yet is a no-op scan.

### Patching

`src/expand-patch.ts` exports one pure function:

```ts
patchEmbedded<T extends object>(row: T, field: string,
    action: 'create' | 'update' | 'delete', record: { id: string }): T | undefined
```

Create and update:

- If `row.expand?.[field]` is absent, return `undefined`: rows that never
  embedded the relation are untouched.
- Single relation: if the embedded copy's `id` differs, return `undefined`.
  Otherwise the new entry is `mergeExpand(record, embedded)`, so a nested
  `expand` the echo lacks is carried from the old copy when its relation
  field is unchanged.
- Multi relation: find the element by `id`; if none, return `undefined`.
  Otherwise replace that element with `mergeExpand(record, element)`,
  preserving order.
- If the new entry is `deepEquals` (from `@tanstack/db`) to the existing
  one, return `undefined`. This is what makes redelivered or unchanged echoes
  produce no write.
- Otherwise return a new row with a new `expand` object. Never mutate `row`.

Delete removes the reference as well as the copy, mirroring what PocketBase
does server-side (it clears the deleted id out of every optional relation
field that references it, then sends an update echo for the parent; it
refuses the delete when a required relation references the record without
cascade). The local patch puts the client in the state the server is about
to confirm; the later parent echo carries a newer `updated`, passes the
staleness arm, and lands as a no-op or a confirmation:

- If `row[field]` does not reference `record.id` (string equality, or array
  includes), return `undefined`. This applies whether or not the row has an
  embedded copy.
- Single relation: set `row[field]` to `''`, PocketBase's empty value for a
  single relation, and delete `expand[field]` if present.
- Multi relation: filter `record.id` out of `row[field]`, and out of
  `expand[field]` if present, preserving order.
- Return a new row (and a new `expand` object when it changed). Never mutate
  `row`.

`applyRelatedChange` on the parent:

1. If the parent's store is not ready, return.
2. Scan `_state.syncedData`; for each row not in `visited` (keyed
   `${collectionName}:${id}`), call `patchEmbedded`; collect patched rows and
   add their keys to `visited`. For an update, the scan can skip rows with
   no `expand`; for a delete it must look at every row, because a reference
   without a copy still has to be cleared.
3. If none, return.
4. Write them in one `writeOwn(() => utils.writeUpsert(patched))`. The
   authoritative path is right: the row is the current synced row with only
   `expand` changed, so its `updated` equals the stored one and the staleness
   arm passes; the optimistic-pending arm is skipped and an optimistic
   overlay stays layered on top.
5. For each patched row, call this collection's own dependents with
   `('update', patchedRow, visited)` so nested copies update. The shared
   `visited` set bounds a cyclic graph and patches each row at most once
   per originating echo. Propagation never returns to the collection the
   echo came from because that collection's rows are the echo, not embedded
   copies of it.

### Why React refreshes

The patch is a synced write through `utils.writeUpsert`, the same path a
realtime echo takes. TanStack DB emits a change message to every
subscription on the parent; a live query is one, so its pipeline re-runs for
that key and `useLiveQuery` re-renders. The patched row is a new object, so
it is a real change; the commit layer drops identical no-op writes, and the
`deepEquals` check above means those are never even attempted.

### Error handling

- Held-subscription bookkeeping runs inside the serialized subscription
  work tail, so it cannot race start/stop/restart.
- A `subscribeChanges` throw on a target is logged and that target is left
  out of the map; the parent's own subscription is unaffected.
- `applyRelatedChange` is wrapped at the call site; a failure for one
  dependent does not stop the others.

## Testing

All timing is by `waitFor` on state or counters; no sleeps, no timeout
bumps. Internal counters needed to observe behaviour are exposed as
`@internal` runtime properties next to `collectionName`.

`test/expand-helpers.test.ts` (pure, no server), for `patchEmbedded`:

- update, single: replace; id mismatch returns `undefined`; absent `expand`
  returns `undefined`; unchanged record returns `undefined`.
- update, multi: replace in place preserving order; id not present returns
  `undefined`.
- delete, single: `row[field]` becomes `''` and `expand[field]` is removed;
  a row referencing the id with no `expand` still gets its field cleared; a
  row not referencing the id returns `undefined`.
- delete, multi: the id is filtered out of both `row[field]` and
  `expand[field]`, order preserved; a row whose array lacks the id returns
  `undefined`.
- nested `expand` carried across from the old copy on update.
- input row never mutated, in every branch.

`test/expand-views.test.tsx`, new block `relation targets stay live`:

1. Mounted `books.expand('author')` query makes `authors.isSubscribed()`
   true; unmounting the last reader makes `authors.subscriberCount` 0 and
   `isSubscribed()` false.
2. `data[0].expand.author.name` changes after the author is updated through
   PocketBase, with no book write.
3. Nested: `book_metadata.expand('book.author')` sees
   `expand.book.expand.author.name` change after an author update.
4. A book row fetched through the plain base (never embedded `author`) is
   untouched by an author update echo, checked in the synced store.
4b. Every relation in the test schema is required, so PocketBase refuses to
   delete a referenced author, book, or tag; the delete branch is covered by
   the unit tests above. The integration check is the storm side: deleting
   an author no row references produces zero parent writes.
5. A pending optimistic update on a book (held with a controlled deferred)
   survives an author echo: the view shows the optimistic title and the
   patched author name.
6. Union growth: with a `book_tags` base query live, mounting
   `book_tags.expand('tag')` grows the union through the restart path and
   starts the tags subscription.

Leak tests:

7. Twenty mount/unmount cycles of a `books.expand('author')` query; after
   each, `authors.subscriberCount` is 0 and both `isSubscribed()` are false;
   a spy on the authors PocketBase `subscribe` and its returned unsubscribe
   functions shows equal counts at the end.
8. Three union growths on `book_tags` (`'book'`, `'tag'`, `'book.author'`)
   while its base query stays live; after each, every
   target on an active path has `subscriberCount` 1 from this parent, the
   held map size equals the number of such targets, and the parent's
   PocketBase subscribe/unsubscribe calls net to one live subscription.
9. With a small `gcTime` on the target, it reaches `cleaned-up` after the
   parent's last subscriber leaves.
10. Fifty distinct views on one collection add zero dependents to its targets
    and zero held subscriptions until one subscribes.

Storm tests:

11. One author update yields exactly one `writeUpsert` batch on the parent
    containing exactly the rows that embed that author, and exactly one
    write on the authors store; the parent live query is notified once.
12. The same author record delivered twice through the handler produces zero
    parent writes and zero notifications the second time.
13. Unit test with fake collections declaring `A.relations.b = B` and
    `B.relations.a = A`, rows embedding each other: one echo patches each
    row at most once and returns; a patched row never propagates back to
    the originating collection.
14. The target's realtime handler runs once per PocketBase event while
    dependents are patched.
15. After the echo tests, a bounded `waitFor` asserts the notification
    counters stop increasing.

## Documentation

- README "Per-query expand": one paragraph stating relation targets stay
  subscribed while a query that expands into them is live, and their
  changes update the embedded `expand` copies in place.
- CHANGELOG: an "Added" line under the unreleased `[0.8.0]` block.
- `2026-09-11-per-query-expand-design.md` "Realtime": one sentence pointing
  here.

## Out of scope

- Back-relations.
- Subscribing targets for relations that are declared but never expanded.
- Indexing the parent scan by relation value; revisit if a collection large
  enough to notice appears.
