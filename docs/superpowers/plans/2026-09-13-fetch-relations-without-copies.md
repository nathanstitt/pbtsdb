# Fetch Relations Without Copies (0.9) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PocketBase `expand` purely a way to file related records into their own collections: rows never carry `expand`, reads go through `materialize()`, joins, or `collection.get()`, and keyed loads of already-filed rows make no request.

**Architecture:** Keep the 0.8 fetch plumbing (expand string union, filing into targets, realtime expand, held targets, per-query views) and rename its options; strip the requested `expand` keys from every row before it reaches a cache; delete the machinery that only kept embedded copies fresh (echo patching, dependents, merge rules, row `expand` typing); add a keyed-load short circuit in `queryFn` that serves id-only requests from the synced store when every id is present.

**Tech Stack:** TypeScript 5.9, `@tanstack/db` 0.9, `@tanstack/query-db-collection` 1.2, `@tanstack/react-db` 0.3, PocketBase JS SDK, Vitest 4 against the live PocketBase test server, Biome.

Spec: `docs/superpowers/specs/2026-09-13-fetch-relations-without-copies-design.md`. Read it first. Branch: create `feat/fetch-relations-without-copies` from `main` in Task 1.

## Global Constraints

- No `any`, even with biome-ignore, except the pre-existing `RelationAsCollection` block in types.ts.
- Never mutate a row, a sync write message, or a load options object; spread into new objects.
- Rows never carry `expand` for a path pbtsdb requested: stripped in `fetchRecords` before return and in the realtime handler before the write. Keys pbtsdb did not request (a user's `subscribeOptions().expand`) are left alone.
- Option and method names, exact: `relations` (unchanged), `alwaysFetchRelations` (was `alwaysExpand`), `collection.fetchRelations(...paths)` (was `expand`). Row type is always `ExtractRecordType<Schema, C>`; no `expand` member anywhere in the public types.
- `materialize` is re-exported from `pbtsdb` (`src/core.ts`) next to `toArray`.
- Keyed-load short circuit: a `where` that is only `eq(id, string)`, `in(id, string[])`, or an `or` of those becomes `ids` on the request; when every id is in the synced store the rows are served without a request; any other predicate goes to the server.
- Kept unchanged: request-shaped query keys, the subscription work tail, held targets and restart-on-union-growth, eager-target wait, index defaults, `gcTime` passthrough, all sync guards.
- Tests: `waitFor` on state or counters only, no sleeps, no timeout bumps. `npm run checks` and named files green after every task; full `npm test` once before each commit. A red check is fixed at its source.
- Biome: 4-space indent, single quotes, no semicolons, ES5 trailing commas, line width 100. `npm run lint:fix` before committing. Comments only for critical context. `logger`, never console.
- Commits: conventional prefixes, no attribution lines, no mention of Claude. Do not bump `package.json`; the maintainer runs `npm version minor`.

## File Map

| File | Responsibility after this plan |
| --- | --- |
| `src/build-collection.ts` | fetch, file, strip, keyed short circuit, guards, views, realtime, held targets |
| `src/collection.ts` | `createCollection` factory and `PbCollection` type |
| `src/types.ts` | options, path types, `ExpandTargetCollection`, `RelationsConfig` |
| `src/expand-paths.ts` | path helpers (unchanged) |
| `src/keyed-where.ts` (new) | pure `idsFromWhere(where)` |
| `src/expand-merge.ts`, `src/expand-patch.ts` | deleted |
| `src/core.ts` | exports (+`materialize`, minus removed types) |
| `test/fetch-relations.test.tsx` (renamed from `expand-views.test.tsx`) | fetch, file, strip, views, keys, held targets, keyed loads |
| `test/expand-helpers.test.ts` | path helpers only |
| `test/keyed-where.test.ts` (new) | `idsFromWhere` |
| `test/expand-types.test.ts` | path validation, no-`expand` row assertions, `materialize` export |
| `test/tanstack-internals.test.ts` | two view assumptions |
| `test/expand.test.tsx` | deleted (covered by fetch-relations.test.tsx) |
| `test/relations.test.ts`, `test/includes.test.ts` | renamed options, `materialize` pattern |
| `README.md`, `llms.txt`, `CHANGELOG.md`, `test/README.md`, `src/react.tsx` JSDoc | docs |

---

### Task 1: Rename the option and the method

Behavior is unchanged in this task; only names move. Rows still carry `expand` until Task 2.

**Files:**
- Modify: `src/types.ts`, `src/collection.ts`, `src/build-collection.ts`
- Modify: every test and doc that spells `alwaysExpand` or `.expand(`: `test/expand-views.test.tsx`, `test/expand.test.tsx`, `test/expand-types.test.ts`, `test/relations.test.ts`, `test/includes.test.ts`, `test/react.test.tsx`, `src/react.tsx`

**Interfaces:**
- Produces: `CreateCollectionOptions.alwaysFetchRelations?: readonly string[]`; `PbCollection.fetchRelations<P>(...paths: P)`; runtime property `fetchRelations` on the instance; the view's throwing method is `fetchRelations`.
- Produces in types.ts: `AlwaysFetchRelationsOf<Opts>` (renamed from `AlwaysExpandOf`), `AlwaysFetchRelationsCheck<Opts>` in collection.ts (renamed from `AlwaysExpandCheck`).

- [ ] **Step 1: Branch**

```bash
git checkout main && git pull --ff-only && git checkout -b feat/fetch-relations-without-copies
```

- [ ] **Step 2: Write the failing type test**

In `test/expand-types.test.ts`, change every `alwaysExpand:` to `alwaysFetchRelations:` and every `.expand(` to `.fetchRelations(`. Run `npm run typecheck`; expected: errors that `alwaysFetchRelations` is not a known option and `fetchRelations` does not exist.

- [ ] **Step 3: Rename in source**

In `src/types.ts`:
- `alwaysExpand?: readonly string[]` → `alwaysFetchRelations?: readonly string[]`; update its JSDoc: "Expand paths fetched with every request. The expanded records are filed into the collections named in `relations`; they are not kept on the row."
- `export type AlwaysExpandOf<Opts> = Opts extends { alwaysExpand: readonly (infer A extends string)[] } ? A : never` → `export type AlwaysFetchRelationsOf<Opts> = Opts extends { alwaysFetchRelations: readonly (infer A extends string)[] } ? A : never`.

In `src/collection.ts`:
- `AlwaysExpandCheck` → `AlwaysFetchRelationsCheck` with member `alwaysFetchRelations?: readonly ExpandPath<RelationsOf<Opts>>[]`.
- `AlwaysExpandOf` → `AlwaysFetchRelationsOf` wherever used.
- The method on `PbCollection`: `expand<const P ...>(...paths: P)` → `fetchRelations<const P ...>(...paths: P)`; JSDoc: "A view of this collection whose queries also fetch `paths` and file the expanded records into their target collections. Rows are unchanged; read the related records through `materialize()`, a join, or the target's `get()`."
- Update the `createCollection` JSDoc examples.

In `src/build-collection.ts`:
- `options?.alwaysExpand` → `options?.alwaysFetchRelations`; rename the local `alwaysExpand` to `alwaysFetch`.
- `function expand(...paths)` → `function fetchRelations(...paths)`; the `Object.assign` entry `expand,` → `fetchRelations,`.
- In `createView`, the throwing property `expand:` → `fetchRelations:` with message `` `A view of "${collectionName}" cannot fetch further relations` ``.

In `src/react.tsx` JSDoc and `test/react.test.tsx`, rename the same spellings.

- [ ] **Step 4: Migrate the tests mechanically**

```bash
sed -i '' -e 's/alwaysExpand/alwaysFetchRelations/g' -e "s/\.expand('/.fetchRelations('/g" -e 's/\.expand()/.fetchRelations()/g' \
  test/expand-views.test.tsx test/expand.test.tsx test/relations.test.ts test/includes.test.ts test/expand-types.test.ts test/react.test.tsx
grep -rn "alwaysExpand\|\.expand(" src test | grep -v 'expand?\.' | grep -v 'expand: '
```

The final grep must print nothing except `expand?.` row reads (which stay until Task 2). Update test titles that say "alwaysExpand" or "expand" to the new names where they name the option, and the error-message assertions: `'cannot be expanded further'` → `'cannot fetch further relations'`.

- [ ] **Step 5: Checks, full suite, commit**

```bash
npm run lint:fix && npm run checks && npm test
git add -A src test
git commit -m "refactor: rename alwaysExpand to alwaysFetchRelations and expand() to fetchRelations()"
```

Expected: 21 files / 182 tests green, same as `main`.

---

### Task 2: Strip requested expand keys and delete the copy-freshness machinery

**Files:**
- Modify: `src/build-collection.ts`
- Delete: `src/expand-merge.ts`, `src/expand-patch.ts`
- Modify: `src/types.ts` (`ExpandTargetCollection`, `RelationDependent`)
- Modify: `src/collection.ts` (`PbView` internals)
- Rename+modify: `test/expand-views.test.tsx` → `test/fetch-relations.test.tsx`
- Modify: `test/expand-helpers.test.ts`, `test/tanstack-internals.test.ts`, `test/relations.test.ts`, `test/includes.test.ts`
- Delete: `test/expand.test.tsx`

**Interfaces:**
- Produces in build-collection.ts: `function stripFetchedRelations(items: RecordType[], expandString: string | undefined): RecordType[]`.
- Removes from the instance and from `PbView`: `relationDependents`, `applyRelatedChange`. Keeps `relationTargets`, `heldRelationTargetCount`, `collectionName`, `waitForSubscription`, `isSubscribed`, `fetchRelations`.
- Removes from `ExpandTargetCollection`: `relationDependents?`, `applyRelatedChange?`, `collectionName?`; removes `RelationDependent`.

- [ ] **Step 1: Write the failing strip tests**

`git mv test/expand-views.test.tsx test/fetch-relations.test.tsx` and rename the outer `describe` to `'Fetch relations'`. Add a new block at the top of the file, before `describe('alwaysFetchRelations', ...)`:

```tsx
    describe('rows never carry expand', () => {
        it('files the expanded record and strips it from the stored and live rows', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', {
                syncMode: 'on-demand',
                relations: { author: authors },
                alwaysFetchRelations: ['author'],
            })
            const { result } = renderHook(() =>
                useLiveQuery(q =>
                    q.from({ b: books }).where(({ b }) => eq(b.title, 'Animal Farm'))
                )
            )
            await waitForLoadFinish(result, 10000)
            const row = result.current.data[0]
            expect((row as { expand?: unknown }).expand).toBeUndefined()
            await waitFor(() => expect(authors.has(row.author)).toBe(true))
            const stored = (
                books as unknown as { _state: { syncedData: Map<string, { expand?: unknown }> } }
            )._state.syncedData.get(row.id)
            expect(stored?.expand).toBeUndefined()
            const cached = queryClient
                .getQueryCache()
                .findAll({ queryKey: ['books'] })
                .flatMap(query => (query.state.data as Array<{ expand?: unknown }> | undefined) ?? [])
            expect(cached.every(item => item.expand === undefined)).toBe(true)
        }, 15000)

        it('strips nested paths and files every level', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            const metadata = c('book_metadata', {
                syncMode: 'on-demand',
                relations: { book: books },
                alwaysFetchRelations: ['book.author'],
            })
            const { result } = renderHook(() => useLiveQuery(q => q.from({ m: metadata })))
            await waitForLoadFinish(result, 10000)
            const row = result.current.data[0]
            expect((row as { expand?: unknown }).expand).toBeUndefined()
            await waitFor(() => {
                expect(books.has(row.book)).toBe(true)
                const book = books.get(row.book) as { author: string; expand?: unknown } | undefined
                expect(book?.expand).toBeUndefined()
                expect(authors.has(book?.author ?? '')).toBe(true)
            })
        }, 15000)

        it('strips a realtime echo after filing its expanded records', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', {
                syncMode: 'on-demand',
                relations: { author: authors },
                alwaysFetchRelations: ['author'],
            })
            const authorId = await getTestAuthorId()
            const seed = await pb.collection('books').create({
                title: `Strip ${getTestSlug('st')}`,
                isbn: getTestSlug('isbn'),
                genre: 'Fiction',
                author: authorId,
                published_date: '',
                page_count: 1,
            })
            try {
                const { result } = renderHook(() =>
                    useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.id, seed.id)))
                )
                await waitForLoadFinish(result, 10000)
                await books.waitForSubscription(10000)
                await pb.collection('books').update(seed.id, { title: 'Echoed' })
                await waitFor(() => expect(result.current.data[0]?.title).toBe('Echoed'))
                expect((result.current.data[0] as { expand?: unknown }).expand).toBeUndefined()
                await waitFor(() => expect(authors.has(authorId)).toBe(true))
            } finally {
                await pb.collection('books').delete(seed.id)
            }
        }, 20000)

        it('leaves expand keys pbtsdb did not request on an echo', async () => {
            const client = new PocketBase(process.env.TESTING_PB_ADDR)
            client.autoCancellation(false)
            await client.collection('users').authWithPassword(
                process.env.TEST_USER_EMAIL ?? '',
                process.env.TEST_USER_PW ?? ''
            )
            const c = createCollection<Schema>(client, queryClient, {
                subscribeOptions: () => ({ expand: 'author' }),
            })
            const books = c('books', { syncMode: 'on-demand' })
            const authorId = await getTestAuthorId()
            const seed = await pb.collection('books').create({
                title: `Keep ${getTestSlug('kp')}`,
                isbn: getTestSlug('isbn'),
                genre: 'Fiction',
                author: authorId,
                published_date: '',
                page_count: 1,
            })
            try {
                const { result } = renderHook(() =>
                    useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.id, seed.id)))
                )
                await waitForLoadFinish(result, 10000)
                await books.waitForSubscription(10000)
                await pb.collection('books').update(seed.id, { title: 'Echoed' })
                await waitFor(() => expect(result.current.data[0]?.title).toBe('Echoed'))
                const row = result.current.data[0] as { expand?: { author?: { id: string } } }
                expect(row.expand?.author?.id).toBe(authorId)
            } finally {
                await pb.collection('books').delete(seed.id)
            }
        }, 20000)
    })
```

Add `import PocketBase from 'pocketbase'` to the file's imports (the subscribe-options test already uses this pattern).

- [ ] **Step 2: Run to verify they fail**

Run: `TEST=test/fetch-relations.test.tsx npm run test`

Expected: the first three new tests FAIL on `expand` being defined; the fourth passes already.

- [ ] **Step 3: Strip in `fetchRecords` and the realtime handler**

In `src/build-collection.ts`, add near `activeExpand`:

```ts
    // pbtsdb asked PocketBase for these relations only to file them into their
    // target collections; the copies never reach a row in any cache.
    function stripFetchedRelations(
        items: RecordType[],
        expandString: string | undefined
    ): RecordType[] {
        const heads = new Set(splitPaths(expandString).map(path => path.split('.')[0]))
        if (heads.size === 0) return items
        return items.map(item => {
            const { expand, ...plain } = item as RecordType & {
                expand?: Record<string, unknown>
            }
            if (!expand) return item
            const kept = Object.fromEntries(
                Object.entries(expand).filter(([key]) => !heads.has(key))
            )
            return (Object.keys(kept).length > 0 ? { ...plain, expand: kept } : plain) as RecordType
        })
    }
```

In `fetchRecords`, replace

```ts
            await upsertExpanded(items, relationTargets)
            if (request.expand) writeExpandedRows(items)

            return withRowsConfirmedMidFlight(items, confirmedMidFlight)
```

with

```ts
            await upsertExpanded(items, relationTargets)
            return withRowsConfirmedMidFlight(
                stripFetchedRelations(items, activeExpand(request)),
                confirmedMidFlight
            )
```

In `handleRealtimeEvent`, compute the stripped record once before the write and write that instead of `event.record` for create and update, file from the original afterwards, and delete the `propagateRelatedChange` call at the tail:

```ts
        const [stored] = stripFetchedRelations([event.record], pendingSubscribeExpand())
        try {
            writeOwn(() =>
                collection.utils.writeBatch(() => {
                    switch (event.action) {
                        case 'create':
                            collection.utils.writeInsert(stored)
                            break
                        case 'update':
                            collection.utils.writeUpsert(stored)
                            break
                        case 'delete':
                            if (event.record && 'id' in event.record) {
                                collection.utils.writeDelete((event.record as { id: string }).id)
                            }
                            break
                    }
                })
            )
        } catch (error) {
            // existing DeleteOperationItemNotFoundError handling, unchanged
        }
        if (event.action !== 'delete') {
            upsertExpanded([event.record], relationTargets).catch(error =>
                logger.error('Failed to upsert expanded records from realtime echo', {
                    collectionName,
                    error,
                })
            )
        }
```

`markEchoPresence` and `isStaleEcho` keep using `event`. Note `pendingSubscribeExpand()` is declared later in the function body; it is a function declaration, so hoisting makes this fine.

- [ ] **Step 4: Delete the copy-freshness machinery**

In `src/build-collection.ts` remove: `writeExpandedRows` and its comment; `patchRowFields`, `patchedRows`, `applyRelatedChange`; the `relationDependents` registration loop after `createTanStackCollection`; `mergedWriteValue` and its use in `guardedWrite` (the write forwards `message` unchanged after `shouldDropSyncedWrite`); the `relationDependents` and `applyRelatedChange` entries in `Object.assign`; the imports of `mergeExpand`, `patchEmbedded`, `propagateRelatedChange`, `RelatedAction`, `RelationDependent`. Delete `src/expand-merge.ts` and `src/expand-patch.ts`.

In `src/types.ts` remove `RelationDependent` and the `collectionName?`, `relationDependents?`, `applyRelatedChange?` members of `ExpandTargetCollection` (keep `relationTargets?`, `subscribeChanges?`, `subscriberCount?`, `status?`, `preload?`). In `src/collection.ts` remove the `relationDependents` and `applyRelatedChange` members from `PbView`. In `src/build-collection.ts` `CollectionSubscriptionHelpers`, remove the same two.

- [ ] **Step 5: Prune tests that asserted copies**

`test/fetch-relations.test.tsx`:
- Delete the whole `describe('shared store coherence')` block except `'a mutation through a view is visible through the base immediately'` and `'serializes overlapping restarts ...'`; move those two into `describe('views (on-demand)')`.
- Delete `'holds an optimistic update against a view fetch racing it'` (it tested `writeExpandedRows`).
- In `describe('relation targets stay live')`, delete every test from `'patches the embedded author ...'` onward (they tested patching); keep the hold/release, nested, union growth, negative paths, cycles, GC, and "creating views holds nothing" tests.
- In every remaining test, replace assertions on `row.expand?.x` with the equivalent target-store assertion (`authors.has(row.author)`), and change `'shares one store: the base sees rows fetched through a view'` to assert the base `has()` the row and the stored row has no `expand`.
- `'expands per query and upserts into the target'` and `'expands a nested path through the target collection'`: keep, with the store assertions only.

`test/expand-helpers.test.ts`: delete the `mergeExpand`, `patchEmbedded`, and `propagateRelatedChange` describes and their imports.

`test/tanstack-internals.test.ts`: delete the second `it` (`insertsRow` pin) and any now-unused imports.

`test/expand.test.tsx`: delete the file.

`test/relations.test.ts`: in `'should auto-expand relations when configured with alwaysFetchRelations'` and `'should allow chaining where() and orderBy()'`, replace `expand?.author` assertions with `authors` store assertions; in the two eager-target tests keep the warning/upsert assertions and drop `expand` reads.

`test/includes.test.ts`: in `'should work with expand + includes coexistence'` rename to `'should read a filed relation through an include'`; it already reads the author through the include, so only the option rename (done in Task 1) matters; drop any `expand?.` read if present.

- [ ] **Step 6: Run the named files, then checks and the full suite**

Run: `TEST="test/fetch-relations.test.tsx test/expand-helpers.test.ts test/tanstack-internals.test.ts test/relations.test.ts test/includes.test.ts" npm run test`

Expected: PASS. If the view join test fails because a view's rows no longer reach the store for already-synced rows, that is expected to be fine now: rows are identical with or without the view, so the base's copy is correct.

```bash
npm run lint:fix && npm run checks && npm test
git add -A src test
git commit -m "feat: file expanded records into their collections and strip them from rows"
```

---

### Task 3: Collapse the row types and exports

**Files:**
- Modify: `src/types.ts`, `src/collection.ts`, `src/core.ts`
- Modify: `test/expand-types.test.ts`

**Interfaces:**
- Produces: `PbCollection<Schema, C, Opts>` whose row type is `ExtractRecordType<Schema, C>`; a view returns `Omit<PbCollection<Schema, C, Opts>, 'fetchRelations'>`.
- Removes exports: `ExpandShape`, `WithExpandPaths`, `WithExpand`, `ParseExpandFields`, `PbView`. Adds export: `materialize`.

- [ ] **Step 1: Write the failing type tests**

Replace the body of `test/expand-types.test.ts` with:

```ts
import { describe, expectTypeOf, it } from 'vitest'
import { createCollection, materialize } from '../src'
import { createTestQueryClient, pb } from './helpers'
import type { Books, Schema } from './schema'

const c = createCollection<Schema>(pb, createTestQueryClient())

describe('fetch relations types', () => {
    it('never puts expand on a row', () => {
        const authors = c('authors', {})
        const books = c('books', { relations: { author: authors }, alwaysFetchRelations: ['author'] })
        type Row = NonNullable<ReturnType<typeof books.get>>
        expectTypeOf<Row>().toEqualTypeOf<Books>()
        const view = books.fetchRelations('author')
        type ViewRow = NonNullable<ReturnType<typeof view.get>>
        expectTypeOf<ViewRow>().toEqualTypeOf<Books>()
    })

    it('rejects paths not declared in relations', () => {
        const authors = c('authors', {})
        // @ts-expect-error nope is not a declared relation
        c('books', { relations: { author: authors }, alwaysFetchRelations: ['nope'] })
        // @ts-expect-error alwaysFetchRelations without relations
        c('books', { alwaysFetchRelations: ['author'] })
        const books = c('books', { relations: { author: authors } })
        // @ts-expect-error nope is not a declared relation
        books.fetchRelations('nope')
        const view = books.fetchRelations('author')
        // @ts-expect-error views are leaves
        view.fetchRelations('author')
    })

    it('validates nested paths through the target collection', () => {
        const authors = c('authors', {})
        const books = c('books', { relations: { author: authors } })
        const metadata = c('book_metadata', { relations: { book: books } })
        metadata.fetchRelations('book.author')
        // @ts-expect-error nope is not a relation of books
        metadata.fetchRelations('book.nope')
        const plainBooks = c('books', {})
        const plainMetadata = c('book_metadata', { relations: { book: plainBooks } })
        // @ts-expect-error books declares no relations
        plainMetadata.fetchRelations('book.author')
    })

    it('keeps the insert type and helpers on views', () => {
        const authors = c('authors', {})
        const books = c('books', {
            relations: { author: authors },
            omitOnInsert: ['created', 'updated'],
        })
        const view = books.fetchRelations('author')
        expectTypeOf(view.collectionName).toEqualTypeOf<'books'>()
        expectTypeOf(view.waitForSubscription).toBeFunction()
        type Insert = Parameters<typeof view.insert>[0]
        expectTypeOf<Insert>().toMatchTypeOf<
            Omit<Books, 'created' | 'updated'> | Omit<Books, 'created' | 'updated'>[]
        >()
    })

    it('re-exports materialize', () => {
        expectTypeOf(materialize).toBeFunction()
    })
})
```

Note: the runtime `it` bodies that call `c(...)` with an undeclared path throw at runtime (creation-time validation); wrap those two `c(...)` calls in `expect(() => ...).toThrow()` as the current file already does, importing `expect` from vitest.

- [ ] **Step 2: Run typecheck to verify it fails**

Run: `npm run typecheck`

Expected: `Row` still has `expand`, `materialize` is not exported.

- [ ] **Step 3: Collapse the types**

In `src/types.ts` delete `ParseExpandFields`, `WithExpand`, `ExpandShape`, `WithExpandPaths`, and the private helpers only they used (`PathHead`, `PathTail`, `RelationRecord`, `WrapNested`, `NestedExpand`). Keep `ExpandPath`, `RelationsConfig`, `RelationAsCollection`, `PbMeta`, `MetaOf`, `RelationsOf`, `AlwaysFetchRelationsOf`, `InsertInputOf`, `ExcludeUndefined`, `ExtractRelations`.

In `src/collection.ts` replace `PbView` and `PbCollection` with:

```ts
export type PbCollection<
    Schema extends SchemaDeclaration,
    C extends keyof Schema & string,
    Opts,
> = Collection<
    ExtractRecordType<Schema, C>,
    string | number,
    QueryCollectionUtils<ExtractRecordType<Schema, C>, string | number, ExtractRecordType<Schema, C>>,
    never,
    InsertInputOf<Schema, C, Opts>
> & {
    /** The PocketBase collection name */
    readonly collectionName: C
    /** Wait for the real-time subscription to be established (useful in tests) */
    waitForSubscription: (timeout?: number) => Promise<void>
    /** Whether the collection has an active real-time subscription */
    isSubscribed: () => boolean
    /** @internal relation targets declared through `relations` */
    readonly relationTargets: Record<string, unknown> | undefined
    /** @internal number of relation targets currently held live */
    readonly heldRelationTargetCount: () => number
    /** @internal phantom; never present at runtime */
    readonly __pbtsdb: PbMeta<Schema, C, RelationsOf<Opts>>
    /**
     * A view of this collection whose queries also fetch `paths` and file the
     * expanded records into their target collections. Rows are unchanged; read
     * related records through `materialize()`, a join, or the target's `get()`.
     */
    fetchRelations<const P extends readonly ExpandPath<RelationsOf<Opts>>[]>(
        ...paths: P
    ): Omit<PbCollection<Schema, C, Opts>, 'fetchRelations'>
}
```

Remove the `WithExpandPaths` and `AlwaysFetchRelationsOf` imports from collection.ts if now unused (`AlwaysFetchRelationsOf` may still be needed by `AlwaysFetchRelationsCheck`; keep what compiles). In `src/core.ts`:

```ts
export { BasicIndex, BTreeIndex, createEffect, materialize, ReverseIndex, toArray } from '@tanstack/db'
export { type CreateCollectionFactoryOptions, createCollection, type PbCollection } from './collection'
export type {
    CreateCollectionOptions,
    ExcludeUndefined,
    ExpandPath,
    ExtractRecordType,
    ExtractRelations,
    OmittableFields,
    RelationAsCollection,
    RelationsConfig,
    SchemaDeclaration,
} from './types'
```

- [ ] **Step 4: Checks, named tests, full suite, commit**

```bash
npm run checks && TEST="test/expand-types.test.ts test/fetch-relations.test.tsx test/react.test.tsx" npm run test
npm run lint:fix && npm run checks && npm test
git add -A src test
git commit -m "feat: rows are typed without expand; export materialize"
```

---

### Task 4: Keyed loads served from the store

**Files:**
- Create: `src/keyed-where.ts`
- Create: `test/keyed-where.test.ts`
- Modify: `src/build-collection.ts` (`PbRequest`, `toRequest`, `fetchItems`)
- Modify: `test/fetch-relations.test.tsx` (new block)

**Interfaces:**
- Produces: `export function idsFromWhere(where: IR.BasicExpression<boolean> | undefined | null): string[] | undefined` in `src/keyed-where.ts`; sorted, deduplicated.
- Produces: `PbRequest.ids?: string[]`; when set, `filter` is absent.

- [ ] **Step 1: Write the failing unit tests**

`test/keyed-where.test.ts`:

```ts
import type { IR } from '@tanstack/db'
import { describe, expect, it } from 'vitest'
import { idsFromWhere } from '../src/keyed-where'

const ref = (...path: string[]) => ({ type: 'ref', path }) as unknown as IR.BasicExpression
const val = (value: unknown) => ({ type: 'val', value }) as unknown as IR.BasicExpression
const fn = (name: string, ...args: IR.BasicExpression[]) =>
    ({ type: 'func', name, args }) as unknown as IR.BasicExpression<boolean>

describe('idsFromWhere', () => {
    it('reads eq(id, string) in either argument order', () => {
        expect(idsFromWhere(fn('eq', ref('id'), val('a')))).toEqual(['a'])
        expect(idsFromWhere(fn('eq', val('a'), ref('id')))).toEqual(['a'])
    })

    it('reads in(id, strings) sorted and deduplicated', () => {
        expect(idsFromWhere(fn('in', ref('id'), val(['b', 'a', 'b'])))).toEqual(['a', 'b'])
    })

    it('reads an or of id equalities', () => {
        const where = fn('or', fn('eq', ref('id'), val('b')), fn('eq', ref('id'), val('a')))
        expect(idsFromWhere(where)).toEqual(['a', 'b'])
    })

    it('returns undefined for anything else', () => {
        expect(idsFromWhere(undefined)).toBeUndefined()
        expect(idsFromWhere(fn('eq', ref('name'), val('a')))).toBeUndefined()
        expect(idsFromWhere(fn('eq', ref('id'), val(1)))).toBeUndefined()
        expect(idsFromWhere(fn('and', fn('eq', ref('id'), val('a')), fn('eq', ref('name'), val('x'))))).toBeUndefined()
        expect(idsFromWhere(fn('or', fn('eq', ref('id'), val('a')), fn('gt', ref('id'), val('b'))))).toBeUndefined()
        expect(idsFromWhere(fn('in', ref('id'), val(['a', 2])))).toBeUndefined()
        expect(idsFromWhere(fn('eq', ref('b', 'id'), val('a')))).toBeUndefined()
    })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `TEST=test/keyed-where.test.ts npm run test` → FAIL, module not found.

- [ ] **Step 3: Implement `src/keyed-where.ts`**

```ts
import type { IR } from '@tanstack/db'

type Node = { type: string; name?: string; args?: Node[]; path?: string[]; value?: unknown }

function isIdRef(node: Node | undefined): boolean {
    return node?.type === 'ref' && node.path?.length === 1 && node.path[0] === 'id'
}

function stringValue(node: Node | undefined): string | undefined {
    return node?.type === 'val' && typeof node.value === 'string' ? node.value : undefined
}

function collect(node: Node): string[] | undefined {
    if (node.type !== 'func' || !node.args) return undefined
    const [a, b] = node.args
    if (node.name === 'eq') {
        if (isIdRef(a)) return stringValue(b) === undefined ? undefined : [stringValue(b) as string]
        if (isIdRef(b)) return stringValue(a) === undefined ? undefined : [stringValue(a) as string]
        return undefined
    }
    if (node.name === 'in') {
        if (!isIdRef(a) || b?.type !== 'val' || !Array.isArray(b.value)) return undefined
        return b.value.every(v => typeof v === 'string') ? (b.value as string[]) : undefined
    }
    if (node.name === 'or') {
        const ids: string[] = []
        for (const arg of node.args) {
            const sub = collect(arg)
            if (!sub) return undefined
            ids.push(...sub)
        }
        return ids
    }
    return undefined
}

/**
 * The ids a `where` selects when it is nothing but `id` equalities: `eq(id, x)`,
 * `in(id, [...])`, or an `or` of those. Anything else returns `undefined`.
 */
export function idsFromWhere(
    where: IR.BasicExpression<boolean> | undefined | null
): string[] | undefined {
    if (!where) return undefined
    const ids = collect(where as unknown as Node)
    return ids ? [...new Set(ids)].sort() : undefined
}
```

- [ ] **Step 4: Write the failing integration tests**

Append to `test/fetch-relations.test.tsx` inside the outer `describe`:

```tsx
    describe('keyed loads served from the store', () => {
        function countAuthorRequests() {
            const filters: string[] = []
            const prev = pb.beforeSend
            pb.beforeSend = (url, options) => {
                if (url.includes('/collections/authors/records')) {
                    const query = (options as { query?: { filter?: string } }).query
                    filters.push(query?.filter ?? '')
                }
                return { url, options }
            }
            return { filters, restore: () => { pb.beforeSend = prev } }
        }

        function make(always: boolean) {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', {
                syncMode: 'on-demand',
                relations: { author: authors },
                ...(always ? { alwaysFetchRelations: ['author'] as const } : {}),
            })
            return { authors, books }
        }

        it('a materialize include on filed rows makes no authors request', async () => {
            const { authors, books } = make(true)
            const counter = countAuthorRequests()
            try {
                const { result } = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ b: books })
                            .where(({ b }) => eq(b.genre, 'Fiction'))
                            .select(({ b }) => ({
                                id: b.id,
                                author: materialize(
                                    q
                                        .from({ a: authors })
                                        .where(({ a }) => eq(a.id, b.author))
                                        .findOne()
                                ),
                            }))
                    )
                )
                await waitForLoadFinish(result, 10000)
                await waitFor(() => {
                    expect(result.current.data.length).toBeGreaterThan(0)
                    expect(result.current.data.every(r => r.author?.name)).toBe(true)
                })
                expect(counter.filters).toEqual([])
            } finally {
                counter.restore()
            }
        }, 15000)

        it('a join on filed rows makes no authors request', async () => {
            const { authors, books } = make(true)
            const counter = countAuthorRequests()
            try {
                const { result } = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ b: books })
                            .where(({ b }) => eq(b.genre, 'Fiction'))
                            .join({ a: authors }, ({ b, a }) => eq(b.author, a.id))
                            .select(({ b, a }) => ({ id: b.id, name: a?.name }))
                    )
                )
                await waitForLoadFinish(result, 10000)
                await waitFor(() => expect(result.current.data.every(r => r.name)).toBe(true))
                expect(counter.filters).toEqual([])
            } finally {
                counter.restore()
            }
        }, 15000)

        it('get() and a findOne live query read a filed row without a request', async () => {
            const { authors, books } = make(true)
            const first = renderHook(() =>
                useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fiction')))
            )
            await waitForLoadFinish(first.result, 10000)
            const authorId = first.result.current.data[0].author
            await waitFor(() => expect(authors.has(authorId)).toBe(true))
            const counter = countAuthorRequests()
            try {
                expect(authors.get(authorId)?.id).toBe(authorId)
                const { result } = renderHook(() =>
                    useLiveQuery(q =>
                        q.from({ a: authors }).where(({ a }) => eq(a.id, authorId)).findOne()
                    )
                )
                await waitFor(() => expect(result.current.data?.id).toBe(authorId), { timeout: 10000 })
                expect(counter.filters).toEqual([])
            } finally {
                counter.restore()
            }
        }, 15000)

        it('without the always-fetch, a join issues exactly one batched request', async () => {
            const { authors, books } = make(false)
            const counter = countAuthorRequests()
            try {
                const { result } = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ b: books })
                            .join({ a: authors }, ({ b, a }) => eq(b.author, a.id))
                            .select(({ b, a }) => ({ id: b.id, name: a?.name }))
                    )
                )
                await waitForLoadFinish(result, 10000)
                await waitFor(() => expect(result.current.data.every(r => r.name)).toBe(true))
                expect(counter.filters).toHaveLength(1)
                expect(counter.filters[0]).toContain('id = "')
            } finally {
                counter.restore()
            }
        }, 15000)

        it('a mixed predicate still fetches', async () => {
            const { authors, books } = make(true)
            const first = renderHook(() =>
                useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fiction')))
            )
            await waitForLoadFinish(first.result, 10000)
            const authorId = first.result.current.data[0].author
            await waitFor(() => expect(authors.has(authorId)).toBe(true))
            const name = authors.get(authorId)?.name ?? ''
            const counter = countAuthorRequests()
            try {
                const { result } = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ a: authors })
                            .where(({ a }) => and(eq(a.id, authorId), eq(a.name, name)))
                    )
                )
                await waitForLoadFinish(result, 10000)
                expect(counter.filters).toHaveLength(1)
            } finally {
                counter.restore()
            }
        }, 15000)
    })
```

Add `materialize` and `and` to the `@tanstack/react-db` import in the file (both are re-exported there; if `materialize` is not, import it from `@tanstack/db`).

- [ ] **Step 5: Run to verify they fail**

Run: `TEST="test/keyed-where.test.ts test/fetch-relations.test.tsx" npm run test`

Expected: the three "no request" tests FAIL with one recorded filter each; the other two pass.

- [ ] **Step 6: Implement the short circuit**

In `src/build-collection.ts`:

```ts
    type PbRequest = { filter?: string; sort?: string; limit?: number; expand?: string; ids?: string[] }

    function toRequest(opts: LoadSubsetOptions | undefined): PbRequest {
        const request: PbRequest = {}
        const ids = idsFromWhere(opts?.where)
        const filter = ids ? undefined : convertToPocketBaseFilter(opts?.where)
        const sort = convertToPocketBaseSort(opts?.orderBy)
        const expand = joinPaths((opts as LoadOptions | undefined)?.expand ?? [])
        if (ids) request.ids = ids
        if (filter) request.filter = filter
        if (sort) request.sort = sort
        if (opts?.limit) request.limit = opts.limit
        if (expand) request.expand = expand
        return request
    }

    function idFilter(ids: readonly string[]): string {
        return ids.map(id => `id = "${id.replace(/"/g, '\\"')}"`).join(' || ')
    }

    // Rows already in the synced store are as fresh as realtime keeps them;
    // an id-only request whose ids are all present needs no round trip.
    function rowsFromStore(ids: readonly string[]): RecordType[] | undefined {
        const rows: RecordType[] = []
        for (const id of ids) {
            const row = collection._state.syncedData.get(id) as RecordType | undefined
            if (!row) return undefined
            rows.push(row)
        }
        return rows
    }

    async function fetchItems(request: PbRequest): Promise<RecordType[]> {
        const { sort, limit, ids } = request
        if (ids) {
            const present = rowsFromStore(ids)
            if (present) return limit ? present.slice(0, limit) : present
        }
        const filter = ids ? idFilter(ids) : request.filter
        const expand = activeExpand(request)
        // ... existing getList / getFullList calls using `filter`, `sort`, `limit`, `expand` ...
    }
```

Import `idsFromWhere` from `./keyed-where`. Rows served from the store skip filing (they were filed when fetched) and skip `stripFetchedRelations` (they already have no `expand`): `fetchRecords` runs `upsertExpanded` on them harmlessly since they carry no `expand`.

- [ ] **Step 7: Run, then full suite, commit**

```bash
TEST="test/keyed-where.test.ts test/fetch-relations.test.tsx test/server-side-filtering.test.ts test/queries.test.ts" npm run test
npm run lint:fix && npm run checks && npm test
git add -A src test
git commit -m "feat: serve id-only loads from the synced store when every row is present"
```

If `server-side-filtering.test.ts` asserts on a filter string for an id-only query, update that assertion to the `ids` request shape or to the observable PocketBase filter `id = "..."`, whichever it checks.

---

### Task 5: Docs, changelog, push, PR

**Files:**
- Modify: `README.md`, `llms.txt`, `CHANGELOG.md`, `test/README.md`, `src/react.tsx`

- [ ] **Step 1: README "Related data" section**

Replace everything from the "With always-expanded relations:" example under `createCollection()` through the end of "#### Per-query expand" (the section that starts around line 340 and ends before "#### Collection Options Passthrough") with:

```markdown
#### Related data

PocketBase `expand` is used only to bring related records into their own
collections. Rows never carry `expand`; read related records from the target
collection.

```typescript
const c = createCollection<MySchema>(pb, queryClient);
const authors = c('authors', { syncMode: 'on-demand' });
const tags = c('tags', { syncMode: 'on-demand' });
const books = c('books', {
    relations: { author: authors, tags },   // where expanded records are filed
    alwaysFetchRelations: ['author'],       // fetched with every books request
});
```

Every books request expands `author`; the expanded authors are filed into
`authors` (an on-demand target has its sync started) and removed from the
book rows. Read them through `materialize()` in a query, a join, or
`authors.get(book.author)`:

```typescript
import { eq, materialize } from 'pbtsdb';

const { data } = useLiveQuery((q) =>
    q.from({ b: books }).select(({ b }) => ({
        ...b,
        author: materialize(
            q.from({ a: authors }).where(({ a }) => eq(a.id, b.author)).findOne()
        ),
    }))
);
// data[0].author?.name is Authors | undefined and updates when the author changes
```

Because the authors are already in the store, that include makes no request:
an id-only load (`eq(id, x)`, `inArray(id, [...])`, or an `or` of those) is
served from the synced store when every id is present, and fetched in one
batched request otherwise.

Fetch a relation for one query only with `fetchRelations()`; the view shares the
collection's store, realtime subscription, and mutations, and only its fetches
add the `expand` parameter:

```typescript
const { data } = useLiveQuery((q) => q.from({ b: books.fetchRelations('tags') }));
// tags referenced by these books are now in the tags collection
```

Paths can be nested through a target collection's own `relations`
(`'book.author'`). While a query fetches into a target, that target keeps its
realtime subscription, so `get()` reads stay fresh.
```

- [ ] **Step 2: README other passages**

- Options list under `createCollection()`: `alwaysExpand?` line → `` `alwaysFetchRelations?: readonly string[]` - Expand paths fetched with every request and filed into their `relations` targets; never kept on the row``.
- Getting started (`### 2. Set Up Your App` / `### 3. Build Your Components`): rename the options; replace `post.expand?.author?.username` with a `materialize` include on `users` in the query and `post.author?.username` in the JSX.
- "### Type Safety" snippet: rename `alwaysExpand`.
- "#### Combining expand with includes" → "#### Includes on filed relations": rename the option and state the include makes no request.
- "### 5. Use Expand for Performance" → rewrite: expand costs one request but carries the related record once per parent row; joins and includes cost one batched request per query and carry each record once; prefer `alwaysFetchRelations` when the parent is the only path by which those rows enter an on-demand collection, otherwise let the query load them.
- Anywhere else `grep -n 'expand?\.\|alwaysExpand\|\.expand(' README.md` still matches: fix.

- [ ] **Step 3: llms.txt, react.tsx JSDoc, test/README.md**

Apply the same renames and replace the "Approach 1: Auto-Expand" and "Per-query expand" blocks with a condensed version of Step 1's section. In `src/react.tsx`, the "With auto-expand collections" JSDoc example uses `materialize`. In `test/README.md`, replace the `expand-views.test.tsx` entry with `fetch-relations.test.tsx` ("fetching and filing relations, stripping, views, held targets, keyed loads from the store"), add `keyed-where.test.ts`, remove `expand.test.tsx`, and update `expand-helpers.test.ts` to "path helpers".

- [ ] **Step 4: CHANGELOG**

Add above `## [0.8.0]`:

```markdown
## [0.9.0] - 2026-09-13

### Changed

- **Breaking:** rows never carry `expand`. PocketBase `expand` now only files
  related records into the collections named in `relations`; read them with
  `materialize()`, a join, or the target's `get()`.
- **Breaking:** `alwaysExpand` is `alwaysFetchRelations`, and
  `collection.expand()` is `collection.fetchRelations()`. Both keep their path
  validation.
- **Breaking:** the row-shape types `ExpandShape`, `WithExpandPaths`,
  `WithExpand`, `ParseExpandFields`, and `PbView` are removed;
  `PbCollection` rows are the schema record type.

### Added

- `materialize` is re-exported from `pbtsdb`.
- Id-only loads (`eq(id, x)`, `inArray(id, [...])`, or an `or` of those) are
  served from the synced store when every id is present, so includes and joins
  on filed rows make no request.

### Removed

- Embedded-copy patching from relation echoes, the `expand` merge rules, and
  the dependents registry; they existed only to keep copies fresh.
```

- [ ] **Step 5: Verify, commit, push, PR**

```bash
grep -rn 'alwaysExpand\|\.expand(\|expand?\.' README.md llms.txt src | grep -v 'subscribeOptions' ; npm run checks && npm test && npm run build
git add -A
git commit -m "docs: related data through materialize, joins and get(); 0.9 changelog"
git push -u origin feat/fetch-relations-without-copies
gh pr create --base main --title "feat: fetch relations without embedded copies" --body-file - <<'EOF'
PocketBase `expand` now only files related records into their own collections; rows never carry `expand`. Reads go through `materialize()`, joins, or the target's `get()`, and id-only loads on already-filed rows are served from the store without a request. `alwaysExpand` becomes `alwaysFetchRelations`, `expand()` becomes `fetchRelations()`. The echo-patching, merge, and dependents machinery that kept embedded copies fresh is removed.

Design: `docs/superpowers/specs/2026-09-13-fetch-relations-without-copies-design.md`. Version 0.9.0.
EOF
```

The first `grep` must print nothing.
