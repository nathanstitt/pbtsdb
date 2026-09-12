# Per-query expand design

Date: 2026-09-11

## Goal

Let a live query ask PocketBase to expand relations for that query only, with
the expanded fields typed on the result rows, while every query on a
PocketBase collection keeps sharing one TanStack DB collection and one store.

```ts
const [books] = useStore('books')
const { data } = useLiveQuery(q =>
    q.from({ books: books.expand('tags') }).where(({ books }) => eq(books.genre, 'Fiction'))
)
data[0].expand?.author // Authors | undefined   (from alwaysExpand)
data[0].expand?.tags   // Tags[] | undefined    (from the view)
data[0].expand?.nope   // type error
```

## Why the design looks like this

TanStack DB offers no per-query option channel. `useLiveQuery` takes only
`(queryFn, deps)`, and the only data a live query hands to a collection's
`loadSubset` is `where`, `orderBy`, `limit`, `cursor`, `offset`, and the
`subscription` that triggered the load. This holds for the installed
`@tanstack/db` 0.6.8 and for upstream main (0.9.0) as of this date.

The one per-query knob that reaches the collection is the object passed to
`q.from()`. TanStack calls `subscribeChanges` on that object. So a "view" is
an object that inherits from the base collection and overrides
`subscribeChanges` to tag the subscription it returns. pbtsdb's own sync
wrapper then recognizes tagged subscriptions when TanStack asks it to load a
subset, and adds the expand string to that request.

Separate collections per expand shape were considered and rejected: they
split one PocketBase collection across several stores, so a query on the base
would not see rows fetched through a view.

### Documented surfaces the mechanism uses

- `collection.subscribeChanges(callback, options)`: public method.
- `LoadSubsetOptions.subscription`: documented as "the subscription that
  triggered the load", intended for sync implementations that key state by
  subscription. Present since `@tanstack/db` 0.4.10.
- Wrapping the sync config's `loadSubset` and `unloadSubset`: the documented
  contract for collection option creators.
- `queryKey` as a function of `LoadSubsetOptions`, with the base-prefix rule.
- `ctx.queryKey` in `queryFn`, and `utils.refetch()` / `utils.writeUpsert()`.

### Undocumented assumptions, pinned by a test

1. A live query calls `subscribeChanges` on the exact object passed to
   `q.from()` and accepts a prototype-derived collection.
2. An extra field placed on the options given to query-db-collection's
   `loadSubset` reaches `queryKey(opts)` unchanged.

Both hold in 0.6.8 and 0.9.0. `test/tanstack-internals.test.ts` fails with a
message naming the assumption if either stops holding.

## Prerequisite: TanStack upgrade

Before any feature work, upgrade to the current releases and get every check
and test green, fixing breakage at its source:

| package                           | from   | to     |
| --------------------------------- | ------ | ------ |
| `@tanstack/db`                    | 0.6.8  | 0.9.0  |
| `@tanstack/react-db`              | 0.1.86 | 0.3.8  |
| `@tanstack/query-db-collection`   | 1.0.40 | 1.2.13 |

Peer dependency ranges stay as they are. The changelogs list no breaking
changes after the versions pbtsdb already crossed. Older versions are covered
by inspection and the pinning test, not by CI.

## Public API

### Creation-time options

The `expand` option is removed and replaced by two options:

```ts
const authors = c('authors', {})
const tags = c('tags', {})
const books = c('books', {
    relations: { author: authors, tags },
    alwaysExpand: ['author'],
})
```

- `relations?: Partial<{ [K in keyof Relations]: RelationAsCollection<...> }>`
  declares which collection receives upserted records for each relation. Keys
  must be relations of the collection in the Schema. Same constraint the
  removed `expand` option had.
- `alwaysExpand?: readonly ExpandPath<...>[]` names expand paths applied on
  every fetch. A path not declared through `relations` (see Expand paths) is
  a type error and a runtime `Error`. Declaring `alwaysExpand` without
  `relations` is a type error and a runtime `Error`.

Migration: `expand: { author }` becomes
`relations: { author }, alwaysExpand: ['author']`.

### Expand paths

An expand path is a PocketBase dot path such as `'author'` or
`'book.author'`. It is valid when each segment is a key of the `relations`
map of the collection reached by the previous segments. The first segment
is looked up in this collection's `relations`; the target collection there
must itself be a pbtsdb collection, and its own `relations` map resolves the
next segment. PocketBase caps depth at six levels; pbtsdb inherits that cap
and does not enforce its own.

Both `alwaysExpand` and `expand()` accept paths. Chained `.expand()` calls
are not supported: `books.expand('tags').expand('color')` would be ambiguous
about which collection `color` belongs to, and views are leaves.

```ts
const authors = c('authors', {})
const books = c('books', { relations: { author: authors } })
const metadata = c('book_metadata', { relations: { book: books } })

metadata.expand('book.author') // ok
metadata.expand('book.nope')   // type error and runtime Error
```

### Views

`collection.expand(...paths)`:

- Variadic over valid expand paths of this collection.
- Return type is the base collection type with `expand` widened to the union
  of `alwaysExpand` and the requested paths. Insert input type, utils,
  `collectionName`, `waitForSubscription`, and `isSubscribed` are unchanged.
- With no arguments, or only paths already in `alwaysExpand`, returns the
  base collection itself.
- Views have no `expand` method in their type. At runtime the method throws
  an `Error` saying a view cannot be expanded further.
- An invalid path throws an `Error` naming the collection, the path, and the
  segment that failed to resolve. Validation walks the path through the
  relation maps once, at the call site, so a bad path never reaches
  PocketBase.

### Row shape

`expand` is an optional object whose entries are optional, because PocketBase
omits entries for empty relations. Single relations are typed as the record,
multi relations as an array. A nested path types the nested record the same
way, so `'book.author'` yields:

```ts
expand?: { book?: Books & { expand?: { author?: Authors } } }
```

Paths sharing a prefix merge: `'book.author'` and `'book.tags'` produce one
`book` entry whose nested `expand` has both keys.

### Types

Two helpers carry the path work, and both mirror the runtime lookup rather
than searching the Schema for a collection by record type:

- The collection type pbtsdb returns carries its `relations` map as a
  phantom type parameter. A path segment resolves by indexing that map, then
  the map of the target, and so on. A relation whose target is not a pbtsdb
  collection has no map, so any path continuing through it is a type error,
  which matches the runtime skip.
- A template literal type splits a path into head and rest. The result shape
  groups the requested paths by head, wraps each head's target record (array
  or single) and recurses on the rests. The same helper serves
  `alwaysExpand`, `expand()`, and the row type, so field-only and nested
  paths share one implementation.

## Runtime architecture

### Module split

The body of `createCollection` moves from collection.ts to a new
`src/build-collection.ts` exporting `buildCollection`. collection.ts keeps
the public factory, option types, and the view cache. The sync guards,
write-back, and realtime handling move with the builder unchanged. This is a
move, not a rewrite.

### One shared store

`createCollection` builds one query collection per PocketBase collection, as
today. Its `queryFn` reads the request shape from `ctx.queryKey` (see Query
keys), unions the request's `expand` paths with `alwaysExpand`, and passes
the joined string to `getList` or `getFullList`. PocketBase accepts dot
paths in that string as-is.

Each built collection exposes its `relations` map on the instance (an
internal property alongside `collectionName`). Upserting expanded records
recurses along it: for each entry in a record's `expand`, the record or
records are upserted into the target named by this collection's map, and
then the same routine runs on those records against the target's own map.
A target that has no map, or no entry for the next segment, ends the
recursion for that branch with a debug log; the parent record is still
upserted with its nested `expand` intact.

### Views

`books.expand(...paths)` validates each path against the relation maps,
then normalizes the list (merge with `alwaysExpand`, dedupe, sort). A path
implied by a longer one (`'book'` next to `'book.author'`) is kept; PocketBase
handles the overlap. If nothing is added beyond `alwaysExpand`, it returns
the base.
Otherwise it returns a cached object, keyed by the normalized paths in a
`Map` held in the base's closure, created with `Object.create(base)` and
owning exactly two properties:

- `id`: `${collectionName}?expand=${paths.join(',')}`, so a base and a view
  can appear in the same query. TanStack keys live-query sources by `id`.
- `subscribeChanges`: calls the base's `subscribeChanges`, records the
  returned subscription in a module-level `WeakMap<Subscription, string[]>`
  against the view's paths, applies the eager handling below, and returns
  the subscription.

Everything else (store, optimistic layer, realtime, utils, mutations) is
inherited through the prototype. `CollectionImpl` uses no `#` private fields
in 0.6.8 or 0.9.0.

The cache never evicts. TanStack lets a `cleaned-up` collection return to
`loading`, so a cached view restarts on its next subscriber.

### On-demand fetches

pbtsdb wraps the sync config's `loadSubset` and `unloadSubset` (the existing
`collectionOptions.sync` wrapper already intercepts `sync`). Each wrapper
looks up `options.subscription` in the `WeakMap`. On a hit it forwards a
shallow copy of the options with `expand` set to the view's paths. On a miss
it forwards the options untouched. The subscription keeps its own original
options object, so its unload bookkeeping is unaffected. Because
`unloadSubset` applies the same lookup, load and unload produce the same key.

### Eager fetches

TanStack bypasses `loadSubset` in eager mode, so a view's `subscribeChanges`
adds its paths to a per-collection "eager expand set" that the eager
`queryFn` reads. If the collection's sync has not started, the initial full
fetch includes the paths. If it has, the view calls `utils.refetch()` and
rows gain their expand data when the refetch lands. The set only grows. Eager
mode is one fetch for the whole table, so expand there is per collection by
nature.

### Query keys

The collection's `queryKey` becomes a function of the load options returning
`[collectionName, request]`, where `request` is the PocketBase request shape
pbtsdb already derives: `filter` (from `convertToPocketBaseFilter`), `sort`
(from `convertToPocketBaseSort`), `limit`, and `expand` (the request's own
expand paths, sorted; `alwaysExpand` is folded in at fetch time rather than
keyed, since a per-collection constant cannot cause key collisions),
omitting empty fields. With no options it
returns `[collectionName]`, the base key, so prefix invalidation and
`refetchOnMutation` keep working. In eager mode the key is always
`[collectionName]`; the eager `queryFn` reads the eager expand set at fetch
time, so `utils.refetch()` re-runs the same observer with the wider set.

Two subsets share a cache entry exactly when they make the same PocketBase
request. The autocancel fallback reads `queryClient.getQueryData(ctx.queryKey)`
so a cancelled expanded fetch resolves to its own cached rows.

`queryFn` reads the request from `ctx.queryKey`, not from `meta`. 0.9.0
strips `subscription` from `meta.loadSubsetOptions`; reading the key keeps
the behaviour identical across versions and on the documented path.

### Row merging

One store means one copy of each row, so a write without expand must not
wipe expand another query put there. The existing guarded `write` wrapper
gains a merge step for synced inserts and updates:

- For each entry in the synced row's `expand` that is absent from the
  incoming row's `expand`: if the incoming row's value for that relation
  field equals the synced row's (strict equality for single relations,
  element-wise in order for arrays), the entry is carried over onto a shallow
  copy of the incoming row. Otherwise it is dropped, because it would
  describe the wrong record.
- An incoming `expand` entry wins over the stored one, except when both
  describe the same record (same `id`; element-wise by `id` for arrays) and
  both carry a string `updated` that is newer on the stored side — then the
  stored entry is kept. An in-flight parent fetch issued before a relation
  target's echo can otherwise resolve after it and revert the patch with its
  older embedded copy, with no later parent write to heal it. On a tie, or
  when either entry lacks `updated`, the incoming entry wins.
- Nested `expand` objects ride inside their top-level entry and are carried
  or dropped with it; the rule is not applied recursively.
- The incoming object is never mutated.

This covers plain subset fetches, mutation write-backs, and realtime echoes.

### Realtime

One subscription per collection, as today. Its `expand` option is the union
of `alwaysExpand` and the paths of every view created so far, merged with
any `expand` from the factory's `subscribeOptions` (split on commas, union,
sort, rejoin; other keys pass through). If a view is created while the
subscription is live and widens the union, the subscription is stopped and
restarted with the wider string using the existing stop and start functions;
`waitForSubscription` resolves against the new one. Echoes therefore carry
expanded data for every relation in use, and expanded records in echoes are
upserted into their targets. This also fixes the existing behaviour where an
echo into an always-expand collection wiped `expand` from the row.

Relation targets are held live and their echoes patch embedded copies; see
`2026-09-11-relation-targets-live-design.md`.

### Mutations

Views inherit `insert`, `update`, and `delete`. There is one optimistic
layer, so a mutation issued through a view or the base is visible through
both immediately.

### Removed

The dead `pbExpand` field on `ExtendedLoadSubsetOptions`; the type collapses
to `LoadSubsetOptions`.

## Error handling and edge cases

- Undeclared field in `expand()`: runtime `Error` naming collection and field.
- `alwaysExpand` without `relations`: type error and runtime `Error`.
- Target not ready when an expanded record arrives: unchanged. On-demand
  targets have sync started; eager targets not yet ready log a warning and
  the record is skipped.
- Load options are read-only upstream. Wrappers spread into new objects.
- A `loadSubset` call with no `subscription`, or an untagged one, is a base
  load and passes through untouched.
- Realtime restart reuses stop/start and their promise bookkeeping.
- Views work in `join` and `includes` because they are collections by
  prototype.

## Testing

All tests run against the live PocketBase test server like the existing
suite, except the pinning test.

`test/expand-views.test.tsx`:

1. `books.expand('author')` rows carry `expand.author` and the authors
   collection receives the upsert, for both sync modes.
2. Same view requested twice returns the same instance. Different field
   order or duplicates return the same instance.
3. `expand()` with only `alwaysExpand` paths returns the base.
4. A live query on the base sees rows fetched through a view, and those rows
   carry `expand` in the shared store.
5. Base and view of the same collection in one query, joined, both resolve.
6. On-demand: a plain fetch of a row already expanded by a view keeps the
   `expand` entry. Changing the relation field through an update drops it.
7. Eager: a view created after the initial load triggers a refetch and rows
   gain `expand`.
8. A realtime update to a book keeps `expand.author` populated.
9. A mutation issued through a view is visible optimistically through the
   base, and vice versa.
10. Runtime throws for an undeclared field, for a nested path whose second
    segment is undeclared, and for expanding a view.
11. Nested: `metadata.expand('book.author')` rows carry
    `expand.book.expand.author`; the books and authors collections both
    receive upserts; a realtime update to the metadata row keeps the nested
    expand.
12. Nested through a target that declares no `relations`: `expand()` throws
    naming the second segment, so the path never reaches PocketBase. (The
    upsert recursion's no-map branch is defensive only; validation makes it
    unreachable through the public API.)
13. Type assertions with `expectTypeOf`: `expand.author` is
    `Authors | undefined`; `expand.book.expand.author` on the nested view is
    `Authors | undefined`; `expand.nope`, `books.expand('nope')`,
    `metadata.expand('book.nope')`, and `alwaysExpand: ['nope']` are type
    errors; `'book.author'` and `'book.tags'` together yield one `book` entry
    with both nested keys.

`test/tanstack-internals.test.ts` (pinning test, no PocketBase): builds a
plain TanStack query collection and a view over it, runs a live query through
the view, and asserts that `subscribeChanges` was called on the view object,
that the sync-level `loadSubset` received a `subscription` present in the
view's map, and that a custom field placed on the options reached
`queryKey(opts)`. Failure messages name the upstream assumption that broke.

Existing expand.test.tsx and README examples migrate from `expand:` to
`relations` plus `alwaysExpand`. No test is deleted.

## Documentation and versioning

- README: the options list under `createCollection()` swaps `expand` for
  `relations` and `alwaysExpand`; the auto-expand examples are rewritten; a
  new "Per-query expand" subsection follows them showing
  `books.expand('tags')` and a nested path. llms.txt gets the same
  treatment.
- JSDoc on `CreateCollectionOptions` and on `expand()` carries the examples.
- Version 0.8.0 (breaking: `expand` option removed). CHANGELOG names the
  removal, the migration, the TanStack upgrade, and the realtime fix.

## Out of scope

- Chained `.expand()` on views.
- Back-relations such as `'book_tags_via_book'`. Untested here, not blocked.
- Shrinking the eager expand set or the realtime expand union when views go
  idle.
- Upstreaming a `meta` channel to TanStack DB.
