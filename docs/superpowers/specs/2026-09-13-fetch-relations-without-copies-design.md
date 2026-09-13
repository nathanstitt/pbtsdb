# Fetch relations without embedded copies (0.9)

Date: 2026-09-13. Supersedes the embedded-copy parts of
`2026-09-11-per-query-expand-design.md` and all of
`2026-09-11-relation-targets-live-design.md`. Declines
`2026-09-12-expand-for-upsert-only-design.md` as written, for the reasons in
Background, while adopting its underlying intent.

## Goal

PocketBase `expand` becomes purely a way to bring related records into their
own collections. Rows never carry `expand`. Related data is read from the
target collection, through `materialize()` or a join in a query, or through
`collection.get()`.

```ts
const authors = c('authors', { syncMode: 'on-demand' })
const tags = c('tags', { syncMode: 'on-demand' })
const books = c('books', {
    relations: { author: authors, tags },        // where expanded records are filed
    alwaysFetchRelations: ['author'],            // expanded on every books request
})

// per query: also bring tags in, for this query's rows only
const { data } = useLiveQuery(q =>
    q.from({ b: books.fetchRelations('tags') }).select(({ b }) => ({
        ...b,
        author: materialize(q.from({ a: authors }).where(({ a }) => eq(a.id, b.author)).findOne()),
    }))
)
data[0].author?.name   // Authors | undefined, live
data[0].expand         // type error: rows are plain Books
```

## Background

0.8.0 shipped embedded copies (`row.expand.author`) kept fresh by echo patching,
held target subscriptions, and merge rules. Measured against the alternative:

- A `materialize()` include or a join on an on-demand target loads its rows by
  key in one batched PocketBase request per query
  (`id = "a" || id = "b" || …`), whether or not a parent expand already filed
  them. So embedded copies never save that request; they add payload on top.
- Copies duplicate every related record once per parent row in two caches and
  need the fan-out machinery to stay fresh, which is where the subtle races
  lived.
- Keeping the fetch but stripping the copy (the declined spec's `populate`)
  costs the same payload as keeping the copy; its only gains are client
  memory and the removal of fan-out.

So the useful pieces are: file expanded records into their targets, keep those
targets live, and make keyed reads of already-filed rows free. Everything that
existed only to keep copies fresh goes.

## Public API

### Options

- `relations?: RelationsConfig<Schema, C>` (unchanged): maps relation field
  names to the collections that receive their expanded records. Declares every
  relation the collection can file, whether or not anything fetches it by
  default.
- `alwaysFetchRelations?: readonly ExpandPath<...>[]` (renamed from
  `alwaysExpand`, same type and validation): paths expanded on every request.
  A path must resolve through `relations` (and, for nested paths such as
  `'author.org'`, through the target's `relations`). Undeclared paths are a
  type error and a runtime `Error` at creation.

### Per-query fetch

`collection.fetchRelations(...paths)` (renamed from `expand`) returns a cached
view whose queries also expand `paths`. Same cache, normalization, validation,
and base-return rules as 0.8's `expand()`. A view's rows are the same type as
the base's. Views are leaves: `fetchRelations` on a view throws.

### Row type

`PbCollection<Schema, C, Opts>` rows are `ExtractRecordType<Schema, C>` with no
`expand` member, regardless of options or views. `PbView` collapses into
`PbCollection` minus `fetchRelations`. Removed types: `ExpandShape`,
`WithExpandPaths`, `WithExpand`, `ParseExpandFields`. Kept: `ExpandPath`,
`RelationsConfig`, `RelationAsCollection`, `PbMeta` (path validation still
walks target maps).

### Exports

`materialize` is re-exported from `pbtsdb` next to `toArray`.

### Migration from 0.8

| 0.8 | 0.9 |
| --- | --- |
| `alwaysExpand: ['author']` | `alwaysFetchRelations: ['author']` |
| `books.expand('tags')` | `books.fetchRelations('tags')` |
| `row.expand?.author?.name` | `materialize(q.from({ a: authors }).where(({ a }) => eq(a.id, b.author)).findOne())` in `select`, or `authors.get(row.author)` |
| `row.expand?.tags` (multi) | `materialize(q.from({ t: tags }).where(({ t }) => inArray(t.id, b.tags)))` |

## Runtime

### Fetch and file

Unchanged from 0.8: the request's expand string is the union of
`alwaysFetchRelations` and the request's own paths (from a view, carried by
the tagged subscription through the `loadSubset` wrapper) plus, in eager mode,
the requested set. Expanded records are upserted recursively into their
targets; an on-demand target has its sync started, an eager target whose load
is in flight is awaited, an idle eager target is skipped with a warning.

### Strip

After filing, `fetchRecords` deletes from each row the `expand` keys for the
head segments of every path it requested. The realtime handler does the same
to an echo after filing its expanded records. Keys the request did not ask for
(a user-supplied `subscribeOptions().expand`, say) are left alone: pbtsdb only
removes what it asked for. Stripping happens before the row reaches either
cache, so the TanStack Query cache and the synced store hold plain rows.

Because rows never carry `expand`, `writeExpandedRows`, `mergeExpand`'s
expand handling, `patchEmbedded`, `propagateRelatedChange`, dependents
registration, and `applyRelatedChange` are removed. The guarded `write` keeps
only the staleness and optimistic-pending arms.

### Realtime and held targets

The subscription's `expand` is still the union of `alwaysFetchRelations` and
every view's paths (merged with the factory's `subscribeOptions().expand`), so
echoes keep filing related records. Targets along active paths are held live
while the parent has subscribers, released on its last-subscriber stop, kept
across restarts, exactly as in 0.8. The restart-on-union-growth path stays.

### Keyed loads served from the store

A live query that reads a target by key (`materialize`, `includes`, or a join)
makes TanStack request those keys through `loadSubset` even when the rows are
already filed. `toRequest` recognizes a `where` that is only `id` equalities
(`eq(id, x)`, `inArray(id, [...])`, or an `or` of those) and records
`ids: string[]` on the request instead of a filter. In `queryFn`, when every
id is in the synced store, the rows are returned from the store with no
PocketBase request; when any id is missing, the whole set is fetched by filter
as today and filed. The query key still differs per id set, so ownership and
GC are unchanged. Rows served from the store are as fresh as the store, which
realtime keeps current.

## Error handling

- Undeclared path in `alwaysFetchRelations` or `fetchRelations()`: `Error`
  naming the collection, path, and failing segment, as today.
- Filing failures and held-subscription failures log with `logger.error` and
  never escape the realtime handler, as today.
- The keyed-load short circuit falls back to a fetch on any doubt: a `where`
  that mixes id equalities with other predicates is not recognized and goes to
  the server.

## Testing

Adapted from 0.8's suites; every assertion on `row.expand` is removed.

`test/expand-views.test.tsx` (rename to `test/fetch-relations.test.tsx`):

1. `alwaysFetchRelations: ['author']`: authors receives the upsert; the stored
   row and the live query row have no `expand` key; both sync modes.
2. Nested `'book.author'` files both levels; no `expand` on the metadata row.
3. `fetchRelations('tags')` view: cache identity, normalization, base return,
   throw on undeclared path and on a view; tags filed for the view's rows.
4. Query keys: a view fetch keys by its expand string; a plain fetch does not.
5. Held targets: hold and release, nested paths, union growth without bouncing,
   twenty mount/unmount cycles balanced, GC of a released target, views hold
   nothing until subscribed, subscribe rejection and unsubscribe throw
   negative paths. (Unchanged from 0.8.)
6. Realtime: an echo with expanded records files them and the stored echo row
   has no `expand`.
7. Keyed load from store: after a books query with `alwaysFetchRelations:
   ['author']`, a `materialize()` include on authors and a join on authors each
   make zero PocketBase requests to authors, counted through `pb.beforeSend`;
   removing the always-fetch makes the same query issue exactly one batched
   request; a mixed predicate on authors still fetches.
8. Strip respects other keys: with `subscribeOptions: () => ({ expand:
   'author' })` on a collection that does not declare `author` in
   `alwaysFetchRelations`, the echoed row keeps `expand.author`.
9. After-load access: after a books query with `alwaysFetchRelations:
   ['author']` (or a `fetchRelations('author')` view), `authors.get(authorId)`
   returns the record, and a `useLiveQuery` on authors with
   `where(eq(a.id, authorId))` and `findOne()` returns it, with zero PocketBase
   requests to authors.

`test/expand-helpers.test.ts`: keep the path helpers' tests; delete the
`mergeExpand`, `patchEmbedded`, and `propagateRelatedChange` describes.
`src/expand-merge.ts` and `src/expand-patch.ts` are deleted.

`test/expand-types.test.ts`: keep path validation and `alwaysFetchRelations`
type errors; replace row-shape assertions with `expectTypeOf<Row>().not.toHaveProperty('expand')`
for base and view; assert `materialize` is exported.

`test/tanstack-internals.test.ts`: keep the two view assumptions; delete the
`insertsRow` pin, which only existed for `writeExpandedRows`.

`test/relations.test.ts` and `test/includes.test.ts`: migrate option names;
the includes examples become the documented `materialize` pattern.

## Documentation

- README: the "Per-query expand" and always-expand sections become one
  "Related data" section: `relations` + `alwaysFetchRelations`, per-query
  `fetchRelations()`, reading through `materialize()` (single and multi), joins,
  and `collection.get()`; the keyed-load-from-store behaviour; the statement
  that rows never carry `expand`. The getting-started example uses
  `materialize` for the author name. The "Use Expand for Performance" tip is
  rewritten around one request versus two.
- llms.txt: same.
- CHANGELOG `[0.9.0]`: Breaking (renames, `expand` removed from rows, types
  removed), Added (`materialize` export, keyed loads from store), Removed
  (echo patching and copies). The maintainer bumps the version at release.

## Out of scope

- Back-relations (`book_tags_via_book`).
- Type-checking join keys against the schema's relation declarations.
- A pbtsdb helper wrapping `materialize`; TanStack's is documented instead.
