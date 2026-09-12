# Per-Query Expand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a live query request PocketBase `expand` paths for that query only, typed on the rows, while every query on a PocketBase collection keeps sharing one TanStack DB collection and store.

**Architecture:** `books.expand('tags.color')` returns a cached object created with `Object.create(books)` whose overridden `subscribeChanges` tags the subscription it returns. pbtsdb's wrapper around the sync config's `loadSubset` recognizes tagged subscriptions and adds `expand` to the load options, which flow into a request-shaped query key that `queryFn` reads back. Eager collections cannot load subsets, so a view there widens a per-collection expand set and refetches. A merge step in the guarded sync `write` keeps `expand` entries on a row when a later write without them arrives.

**Tech Stack:** TypeScript 5.9+, `@tanstack/db` 0.9.0, `@tanstack/query-db-collection` 1.2.13, `@tanstack/react-db` 0.3.8, PocketBase JS SDK, Vitest 4 against a live PocketBase test server, Biome.

Spec: `docs/superpowers/specs/2026-09-11-per-query-expand-design.md`. Read it first.

## Global Constraints

- Upgrade targets, exact: `@tanstack/db` 0.9.0, `@tanstack/react-db` 0.3.8, `@tanstack/query-db-collection` 1.2.13. Peer dependency ranges in package.json stay unchanged.
- No `any`, even with biome-ignore, except the pre-existing `RelationAsCollection` block in types.ts.
- Never mutate a TanStack load options object or a sync write message; spread into a new object.
- Only documented TanStack surfaces plus the two pinned assumptions (spec, "Undocumented assumptions"). Do not touch `_changes`, `_sync`, or a subscription's `collection` field.
- Tests use the live PocketBase server via `npm test` (starts it) or `npm run test:run` (server already running). A single file: `TEST=test/foo.test.ts npm run test`.
- After every task: `npm run checks` (typecheck + lint) green, and the tests named in the task green. A red check is fixed at its source, never skipped or retried.
- Commits: no attribution lines, no mention of Claude. Conventional prefixes (`feat:`, `refactor:`, `test:`, `docs:`, `chore:`).
- Biome: 4-space indent, single quotes, no semicolons, ES5 trailing commas, line width 100. Run `npm run lint:fix` before committing.
- Comments only for critical context; JSDoc on public API.

## File Map

| File | Responsibility |
| --- | --- |
| `package.json` | dependency bumps, no peer range change |
| `src/types.ts` | option types (`relations`, `alwaysExpand`), expand-path types, row shape types, `ExpandTargetCollection` |
| `src/expand-paths.ts` (new) | pure helpers: normalize, validate, split/join path lists |
| `src/expand-merge.ts` (new) | pure `mergeExpand(incoming, existing)` |
| `src/build-collection.ts` (new) | runtime: everything now in the closure inside `createCollection`, plus request keys, views, eager set, realtime expand |
| `src/collection.ts` | public factory `createCollection`, `PbCollection` / `PbView` types, casts the built collection |
| `src/core.ts` | exports |
| `test/expand-views.test.tsx` (new) | feature tests |
| `test/tanstack-internals.test.ts` (new) | pinning test for the two upstream assumptions |
| `test/expand.test.tsx`, `test/relations.test.ts`, `test/includes.test.ts` | migrate `expand:` option to `relations` + `alwaysExpand` |
| `README.md`, `llms.txt`, `CHANGELOG.md` | docs |

---

### Task 1: Upgrade TanStack packages

**Files:**
- Modify: `package.json` (devDependencies only)
- Modify: `package-lock.json` (via npm)

**Interfaces:**
- Produces: a green baseline on `@tanstack/db` 0.9.0, `@tanstack/react-db` 0.3.8, `@tanstack/query-db-collection` 1.2.13.

- [ ] **Step 1: Bump the dev dependency floors**

In `package.json` `devDependencies`, change:

```json
"@tanstack/db": ">=0.9.0",
"@tanstack/query-db-collection": ">=1.2.13",
"@tanstack/react-db": ">=0.3.8",
```

Leave `peerDependencies` untouched.

- [ ] **Step 2: Install and confirm the resolved versions**

Run:

```bash
npm install
node -e "for (const p of ['db','react-db','query-db-collection']) console.log(p, require('@tanstack/'+p+'/package.json').version)"
```

Expected output lines: `db 0.9.0`, `react-db 0.3.8`, `query-db-collection 1.2.13` (or newer patch releases if npm resolved them; record what you got).

- [ ] **Step 3: Run checks**

Run: `npm run checks`

Expected: green. If typecheck fails, the likely spots are `src/collection.ts` accesses of `collection._state.optimisticUpserts`, `collection._state.syncedData`, `ctx.meta?.loadSubsetOptions`, and the `Parameters<typeof innerSync>[0]` cast on the sync wrapper. Fix each at the source against the new type definitions (read `node_modules/@tanstack/db/dist/esm/types.d.ts` and `collection/state.d.ts`). Do not add casts to `any`.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`

Expected: all green. If a test fails, use systematic debugging: read the failing assertion, read the new TanStack behavior in `node_modules/@tanstack/*/dist/esm`, and fix pbtsdb. Two known behavior changes to check against if a failure looks related: 0.9.0 strips `subscription` from `meta.loadSubsetOptions`, and `LoadSubsetOptions` gained `signal`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src
git commit -m "chore: upgrade @tanstack/db to 0.9, react-db to 0.3, query-db-collection to 1.2"
```

---

### Task 2: Move the collection builder into build-collection.ts

A pure move. No behavior change. The point is that later tasks edit a focused file.

**Files:**
- Create: `src/build-collection.ts`
- Modify: `src/collection.ts`
- Test: whole suite (unchanged)

**Interfaces:**
- Produces: `buildCollection<Schema, C>(input: BuildCollectionInput<Schema, C>): BuiltCollection<ExtractRecordType<Schema, C>>` in `src/build-collection.ts`.
- Produces: `interface CollectionSubscriptionHelpers` and `interface CreateCollectionFactoryOptions` stay exported from `src/collection.ts` (re-exported from build-collection).

- [ ] **Step 1: Create `src/build-collection.ts` with the moved body**

Move everything that is currently inside the inner arrow function of `createCollection` (from `type RecordType = ...` to `return collection as unknown as ...`) into this function. Keep the code byte-for-byte except for the signature and the return statement. Also move the `ExtendedLoadSubsetOptions` type, `CollectionSubscriptionHelpers`, and `CreateCollectionFactoryOptions` here.

```ts
import {
    type Collection,
    createCollection as createTanStackCollection,
    type LoadSubsetOptions,
} from '@tanstack/db'
import {
    DeleteOperationItemNotFoundError,
    type QueryCollectionUtils,
    queryCollectionOptions,
} from '@tanstack/query-db-collection'
import type { QueryClient } from '@tanstack/react-query'
import type PocketBase from 'pocketbase'
import type { RecordSubscribeOptions, RecordSubscription } from 'pocketbase'
import { logger } from './logger'
import { convertToPocketBaseFilter, convertToPocketBaseSort } from './pocketbase-query-converter'
import type {
    CreateCollectionOptions,
    ExpandTargetCollection,
    ExtractRecordType,
    SchemaDeclaration,
} from './types'

/**
 * Options applied to every collection built by a {@link createCollection} factory.
 */
export interface CreateCollectionFactoryOptions {
    /**
     * Extra options passed to every real-time subscription this factory creates,
     * such as `headers`, `filter`, `expand` or `fields`.
     *
     * Invoked at subscribe time rather than read once, because a subscription is
     * re-established on reconnect and whenever the subscriber count rises from
     * zero — a value captured at build time would go stale exactly then.
     *
     * Returning `undefined` subscribes with no extra options.
     */
    subscribeOptions?: () => RecordSubscribeOptions | undefined
}

type ExtendedLoadSubsetOptions = LoadSubsetOptions & {
    pbExpand?: string
}

/**
 * Subscription helpers added to collection instances.
 * @internal
 */
export interface CollectionSubscriptionHelpers {
    /** The PocketBase collection name */
    collectionName: string
    /** Wait for subscription to be established (useful in tests) */
    waitForSubscription: (timeout?: number) => Promise<void>
    /** Check if collection has an active subscription */
    isSubscribed: () => boolean
}

/**
 * Runtime shape of a built collection, before the public factory narrows it.
 * @internal
 */
export type BuiltCollection<T extends object> = Collection<
    T,
    string | number,
    QueryCollectionUtils<T, string | number, T>,
    never,
    T
> &
    CollectionSubscriptionHelpers

/** @internal */
export interface BuildCollectionInput<Schema extends SchemaDeclaration, C extends keyof Schema & string> {
    pb: PocketBase
    queryClient: QueryClient
    factoryOptions: CreateCollectionFactoryOptions | undefined
    collectionName: C
    options: CreateCollectionOptions<Schema, C> | undefined
}

/** @internal */
export function buildCollection<Schema extends SchemaDeclaration, C extends keyof Schema & string>(
    input: BuildCollectionInput<Schema, C>
): BuiltCollection<ExtractRecordType<Schema, C>> {
    const { pb, queryClient, factoryOptions, collectionName, options } = input
    type RecordType = ExtractRecordType<Schema, C>
    // ... moved body, unchanged ...
    return collection as unknown as BuiltCollection<RecordType>
}
```

- [ ] **Step 2: Reduce `src/collection.ts` to the factory and types**

Keep `WithExpandFromConfig`, `InferCollectionType`, and the JSDoc for `createCollection`. Replace the inner function body with a call:

```ts
import type { Collection } from '@tanstack/db'
import type { QueryCollectionUtils } from '@tanstack/query-db-collection'
import type { QueryClient } from '@tanstack/react-query'
import type PocketBase from 'pocketbase'
import {
    buildCollection,
    type CollectionSubscriptionHelpers,
    type CreateCollectionFactoryOptions,
} from './build-collection'
import type { CreateCollectionOptions, ExtractRecordType, SchemaDeclaration } from './types'

export type { CreateCollectionFactoryOptions } from './build-collection'
export type { BaseRecord, CreateCollectionOptions, SchemaDeclaration } from './types'

// WithExpandFromConfig and InferCollectionType unchanged (InferCollectionType now
// imports CollectionSubscriptionHelpers from './build-collection').

export function createCollection<Schema extends SchemaDeclaration>(
    pb: PocketBase,
    queryClient: QueryClient,
    factoryOptions?: CreateCollectionFactoryOptions
) {
    return <
        C extends keyof Schema & string,
        Opts extends CreateCollectionOptions<Schema, C> = CreateCollectionOptions<Schema, C>,
    >(
        collectionName: C,
        options?: Opts
    ): InferCollectionType<Schema, C, Opts> => {
        return buildCollection<Schema, C>({
            pb,
            queryClient,
            factoryOptions,
            collectionName,
            options,
        }) as unknown as InferCollectionType<Schema, C, Opts>
    }
}
```

- [ ] **Step 3: Run checks and the full suite**

Run: `npm run checks && npm test`

Expected: green, identical test counts to Task 1.

- [ ] **Step 4: Commit**

```bash
git add src/build-collection.ts src/collection.ts
git commit -m "refactor: move the collection builder into build-collection.ts"
```

---

### Task 3: Pure helpers for expand paths and expand merging

**Files:**
- Create: `src/expand-paths.ts`
- Create: `src/expand-merge.ts`
- Create: `test/expand-helpers.test.ts`

**Interfaces:**
- Produces, from `src/expand-paths.ts`:
  - `normalizePaths(paths: Iterable<string>): string[]` (dedupe, drop empty, sort)
  - `splitPaths(csv: string | undefined): string[]`
  - `joinPaths(paths: Iterable<string>): string | undefined` (`undefined` when empty)
  - `validateExpandPath(collectionName: string, targets: RelationTargets | undefined, path: string): void` (throws `Error`)
  - `type RelationTargets = Record<string, ExpandTargetCollection>`
- Produces, from `src/expand-merge.ts`:
  - `mergeExpand<T extends object>(incoming: T, existing: T | undefined): T`
- Consumes: `ExpandTargetCollection` from `src/types.ts` (Task 4 adds `relationTargets` to it; this task adds the optional field now so the helper compiles).

- [ ] **Step 1: Add `relationTargets` to `ExpandTargetCollection` in `src/types.ts`**

```ts
export interface ExpandTargetCollection {
    utils?: {
        writeUpsert: (records: object[]) => void
    }
    isReady: () => boolean
    _sync: {
        startSync: () => Promise<void>
    }
    config?: {
        syncMode?: 'eager' | 'on-demand'
    }
    /** Relation targets of this collection, when it was built by pbtsdb. */
    relationTargets?: Record<string, ExpandTargetCollection>
}
```

- [ ] **Step 2: Write the failing helper tests**

`test/expand-helpers.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mergeExpand } from '../src/expand-merge'
import {
    joinPaths,
    normalizePaths,
    type RelationTargets,
    splitPaths,
    validateExpandPath,
} from '../src/expand-paths'

function target(relationTargets?: RelationTargets) {
    return {
        isReady: () => true,
        _sync: { startSync: async () => undefined },
        relationTargets,
    }
}

describe('expand paths', () => {
    it('normalizes by dropping empties, deduping and sorting', () => {
        expect(normalizePaths(['tags', '', 'author', 'tags', 'book.author'])).toEqual([
            'author',
            'book.author',
            'tags',
        ])
    })

    it('splits and joins comma lists', () => {
        expect(splitPaths(undefined)).toEqual([])
        expect(splitPaths('tags, author,,')).toEqual(['author', 'tags'])
        expect(joinPaths([])).toBeUndefined()
        expect(joinPaths(['tags', 'author'])).toBe('author,tags')
    })

    it('accepts a declared single segment', () => {
        expect(() => validateExpandPath('books', { author: target() }, 'author')).not.toThrow()
    })

    it('accepts a nested path through a target with its own map', () => {
        const authors = target()
        const books = target({ author: authors })
        expect(() =>
            validateExpandPath('book_metadata', { book: books }, 'book.author')
        ).not.toThrow()
    })

    it('rejects an undeclared first segment', () => {
        expect(() => validateExpandPath('books', { author: target() }, 'nope')).toThrow(
            'Cannot expand "nope" on collection "books": segment "nope" is not a declared relation'
        )
    })

    it('rejects a nested segment the target does not declare', () => {
        const books = target({})
        expect(() =>
            validateExpandPath('book_metadata', { book: books }, 'book.nope')
        ).toThrow(
            'Cannot expand "book.nope" on collection "book_metadata": segment "nope" is not a declared relation'
        )
    })

    it('rejects a nested segment when the target has no relation map', () => {
        expect(() =>
            validateExpandPath('book_metadata', { book: target() }, 'book.author')
        ).toThrow(
            'Cannot expand "book.author" on collection "book_metadata": segment "author" is not a declared relation'
        )
    })

    it('rejects when nothing is declared', () => {
        expect(() => validateExpandPath('books', undefined, 'author')).toThrow(
            'Cannot expand "author" on collection "books": no relations declared'
        )
    })
})

describe('mergeExpand', () => {
    const author = { id: 'a1', name: 'Orwell' }

    it('returns incoming unchanged when nothing is stored', () => {
        const incoming = { id: 'b1', author: 'a1' }
        expect(mergeExpand(incoming, undefined)).toBe(incoming)
    })

    it('carries an expand entry over when the relation field is unchanged', () => {
        const incoming = { id: 'b1', author: 'a1' }
        const existing = { id: 'b1', author: 'a1', expand: { author } }
        const merged = mergeExpand(incoming, existing)
        expect(merged).not.toBe(incoming)
        expect(merged).toEqual({ id: 'b1', author: 'a1', expand: { author } })
        expect(incoming).toEqual({ id: 'b1', author: 'a1' })
    })

    it('drops an entry when the relation field changed', () => {
        const incoming = { id: 'b1', author: 'a2' }
        const existing = { id: 'b1', author: 'a1', expand: { author } }
        expect(mergeExpand(incoming, existing)).toBe(incoming)
    })

    it('compares multi relations element-wise in order', () => {
        const tags = [{ id: 't1' }, { id: 't2' }]
        const existing = { id: 'b1', tags: ['t1', 't2'], expand: { tags } }
        expect(mergeExpand({ id: 'b1', tags: ['t1', 't2'] }, existing).expand).toEqual({ tags })
        expect(mergeExpand({ id: 'b1', tags: ['t2', 't1'] }, existing).expand).toBeUndefined()
        expect(mergeExpand({ id: 'b1', tags: ['t1'] }, existing).expand).toBeUndefined()
    })

    it('lets an incoming entry win over the stored one', () => {
        const fresh = { id: 'a1', name: 'George Orwell' }
        const incoming = { id: 'b1', author: 'a1', expand: { author: fresh } }
        const existing = { id: 'b1', author: 'a1', expand: { author } }
        expect(mergeExpand(incoming, existing)).toBe(incoming)
    })

    it('keeps nested expand inside a carried entry', () => {
        const book = { id: 'b1', author: 'a1', expand: { author } }
        const existing = { id: 'm1', book: 'b1', expand: { book } }
        expect(mergeExpand({ id: 'm1', book: 'b1' }, existing).expand).toEqual({ book })
    })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `TEST=test/expand-helpers.test.ts npm run test`

Expected: FAIL, modules `../src/expand-paths` and `../src/expand-merge` not found.

- [ ] **Step 4: Implement `src/expand-paths.ts`**

```ts
import type { ExpandTargetCollection } from './types'

export type RelationTargets = Record<string, ExpandTargetCollection>

export function normalizePaths(paths: Iterable<string>): string[] {
    const set = new Set<string>()
    for (const path of paths) {
        const trimmed = path.trim()
        if (trimmed) set.add(trimmed)
    }
    return [...set].sort()
}

export function splitPaths(csv: string | undefined): string[] {
    return csv ? normalizePaths(csv.split(',')) : []
}

export function joinPaths(paths: Iterable<string>): string | undefined {
    const normalized = normalizePaths(paths)
    return normalized.length > 0 ? normalized.join(',') : undefined
}

export function validateExpandPath(
    collectionName: string,
    targets: RelationTargets | undefined,
    path: string
): void {
    if (!targets) {
        throw new Error(
            `Cannot expand "${path}" on collection "${collectionName}": no relations declared`
        )
    }
    let current: RelationTargets | undefined = targets
    for (const segment of path.split('.')) {
        const next: ExpandTargetCollection | undefined = current?.[segment]
        if (!next) {
            throw new Error(
                `Cannot expand "${path}" on collection "${collectionName}": segment "${segment}" is not a declared relation`
            )
        }
        current = next.relationTargets
    }
}
```

- [ ] **Step 5: Implement `src/expand-merge.ts`**

```ts
type Expandable = { expand?: Record<string, unknown> } & Record<string, unknown>

function sameRelationValue(a: unknown, b: unknown): boolean {
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((value, index) => value === b[index])
    }
    return a === b
}

/**
 * Carry `expand` entries from the stored row onto an incoming row that lacks them,
 * as long as the relation field itself did not change. Never mutates `incoming`.
 */
export function mergeExpand<T extends object>(incoming: T, existing: T | undefined): T {
    const stored = (existing as Expandable | undefined)?.expand
    if (!stored) return incoming
    const row = incoming as Expandable
    const merged: Record<string, unknown> = { ...(row.expand ?? {}) }
    let carried = false
    for (const [relation, value] of Object.entries(stored)) {
        if (relation in merged) continue
        if (!sameRelationValue(row[relation], (existing as Expandable)[relation])) continue
        merged[relation] = value
        carried = true
    }
    return carried ? ({ ...row, expand: merged } as T) : incoming
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `TEST=test/expand-helpers.test.ts npm run test`

Expected: PASS, 14 tests.

- [ ] **Step 7: Checks and commit**

```bash
npm run lint:fix && npm run checks
git add src/expand-paths.ts src/expand-merge.ts src/types.ts test/expand-helpers.test.ts
git commit -m "feat: expand path and expand merge helpers"
```

---

### Task 4: Option types, path types, and the public collection type

Replaces the `expand` option with `relations` + `alwaysExpand`, introduces the path and row-shape types, and defines `PbCollection` / `PbView`. Runtime for `alwaysExpand` lands in Task 5, so this task ends with the migrated existing tests typechecking and the runtime still honoring the old behavior through a temporary shim (removed in Task 5).

**Files:**
- Modify: `src/types.ts`
- Modify: `src/collection.ts`
- Modify: `src/core.ts`
- Modify: `src/build-collection.ts` (shim only)
- Modify: `test/expand.test.tsx`, `test/relations.test.ts`, `test/includes.test.ts`
- Create: `test/expand-types.test.ts`

**Interfaces:**
- Produces in `src/types.ts`: `RelationsConfig<Schema, C>`, `PbMeta<Schema, C, Relations>`, `MetaOf<T>`, `RelationsOf<Opts>`, `AlwaysExpandOf<Opts>`, `ExpandPath<Relations>`, `ExpandShape<Schema, C, Relations, P>`, `WithExpandPaths<Schema, C, Relations, P>`, `InsertInputOf<Schema, C, Opts>`.
- Produces in `src/collection.ts`: `PbView<Schema, C, Opts, Paths>`, `PbCollection<Schema, C, Opts>`, and the factory signature `(collectionName: C, options?: Opts & AlwaysExpandCheck<Opts>) => PbCollection<Schema, C, Opts>` with `const Opts`.
- Consumes: `CollectionSubscriptionHelpers` from Task 2.

- [ ] **Step 1: Write the failing type tests**

`test/expand-types.test.ts` (compiled by `npm run typecheck`; vitest runs it as a no-op):

```ts
import { describe, expectTypeOf, it } from 'vitest'
import { createCollection } from '../src'
import type { ExpandShape } from '../src/types'
import { createTestQueryClient, pb } from './helpers'
import type { Authors, Books, Schema } from './schema'

const c = createCollection<Schema>(pb, createTestQueryClient())

describe('expand types', () => {
    it('types alwaysExpand on the base rows', () => {
        const authors = c('authors', {})
        const books = c('books', { relations: { author: authors }, alwaysExpand: ['author'] })
        type Row = NonNullable<ReturnType<typeof books.get>>
        expectTypeOf<Row['expand']>().toEqualTypeOf<{ author?: Authors } | undefined>()
    })

    it('rejects alwaysExpand paths not declared in relations', () => {
        const authors = c('authors', {})
        // @ts-expect-error nope is not a declared relation
        c('books', { relations: { author: authors }, alwaysExpand: ['nope'] })
        // @ts-expect-error alwaysExpand without relations
        c('books', { alwaysExpand: ['author'] })
    })

    it('widens expand on a view and rejects undeclared paths', () => {
        const authors = c('authors', {})
        const books = c('books', { relations: { author: authors } })
        const view = books.expand('author')
        type Row = NonNullable<ReturnType<typeof view.get>>
        expectTypeOf<Row['expand']>().toEqualTypeOf<{ author?: Authors } | undefined>()
        // @ts-expect-error nope is not a declared relation
        books.expand('nope')
        // @ts-expect-error views are leaves
        view.expand('author')
    })

    it('types nested paths through the target collection', () => {
        const authors = c('authors', {})
        const books = c('books', { relations: { author: authors } })
        const metadata = c('book_metadata', { relations: { book: books } })
        const view = metadata.expand('book.author')
        type Row = NonNullable<ReturnType<typeof view.get>>
        expectTypeOf<Row['expand']>().toEqualTypeOf<
            { book?: Books & { expand?: { author?: Authors } } } | undefined
        >()
        // @ts-expect-error nope is not a relation of books
        metadata.expand('book.nope')
    })

    it('rejects a nested path when the target declares no relations', () => {
        const books = c('books', {})
        const metadata = c('book_metadata', { relations: { book: books } })
        // @ts-expect-error books declares no relations
        metadata.expand('book.author')
    })

    it('merges paths that share a head', () => {
        type A = { id: string; n: number }
        type B = { id: string; s: string }
        type Mid = { id: string; a: string; b: string[] }
        type S = {
            top: { type: { id: string; mid: string }; relations: { mid: Mid } }
            mid: { type: Mid; relations: { a: A; b: B[] } }
            a: { type: A }
            b: { type: B }
        }
        type MidCollection = { readonly __pbtsdb: { schema: S; name: 'mid'; relations: { a: unknown; b: unknown } } }
        type Shape = ExpandShape<S, 'top', { mid: MidCollection }, 'mid.a' | 'mid.b'>
        expectTypeOf<Shape>().toEqualTypeOf<{
            mid?: Mid & { expand?: { a?: A; b?: B[] } }
        }>()
    })

    it('keeps the insert type and helpers on views', () => {
        const authors = c('authors', {})
        const books = c('books', {
            relations: { author: authors },
            omitOnInsert: ['created', 'updated'],
        })
        const view = books.expand('author')
        expectTypeOf(view.collectionName).toEqualTypeOf<'books'>()
        expectTypeOf(view.waitForSubscription).toBeFunction()
        type Insert = Parameters<typeof view.insert>[0]
        expectTypeOf<Insert>().toMatchTypeOf<
            Omit<Books, 'created' | 'updated'> | Omit<Books, 'created' | 'updated'>[]
        >()
    })
})
```

- [ ] **Step 2: Run typecheck to verify it fails**

Run: `npm run typecheck`

Expected: errors in `test/expand-types.test.ts` such as `'relations' does not exist in type`, `Property 'expand' does not exist`, and unused `@ts-expect-error` directives.

- [ ] **Step 3: Replace the expand option types in `src/types.ts`**

Delete `ExpandConfig` and `ExpandableStoresConfig`. Keep `WithExpand` and `ParseExpandFields` (public, unused internally). Add, in the "Expand Type Utilities" section:

```ts
/**
 * Maps relation field names to the collections that receive their expanded records.
 */
export type RelationsConfig<Schema extends SchemaDeclaration, CollectionName extends keyof Schema> =
    ExtractRelations<Schema, CollectionName> extends never
        ? Record<string, never>
        : Partial<{
              [K in keyof ExtractRelations<Schema, CollectionName>]: RelationAsCollection<
                  ExcludeUndefined<ExtractRelations<Schema, CollectionName>[K]>
              >
          }>

/**
 * Phantom metadata carried on the type of every pbtsdb collection so that nested
 * expand paths resolve through the target collection's own relations.
 * @internal
 */
export interface PbMeta<Schema extends SchemaDeclaration, C extends keyof Schema, Relations> {
    schema: Schema
    name: C
    relations: Relations
}

/** @internal */
export type MetaOf<T> = T extends { readonly __pbtsdb: infer M } ? M : never

/** @internal */
export type RelationsOf<Opts> = Opts extends { relations: infer R } ? R : never

/** @internal */
export type AlwaysExpandOf<Opts> = Opts extends {
    alwaysExpand: readonly (infer A extends string)[]
}
    ? A
    : never

type RelationsOfMeta<M> = M extends { relations: infer R } ? R : never

type Prev = [never, 0, 1, 2, 3, 4, 5]

/**
 * Every valid PocketBase expand path for a relations map: each declared relation,
 * and each relation of a pbtsdb target joined with a dot, to six levels.
 */
export type ExpandPath<Relations, Depth extends number = 6> = [Depth] extends [0]
    ? never
    : Relations extends object
      ? {
            [K in keyof Relations & string]:
                | K
                | `${K}.${ExpandPath<RelationsOfMeta<MetaOf<Relations[K]>>, Prev[Depth]>}`
        }[keyof Relations & string]
      : never

type PathHead<P extends string> = P extends `${infer H}.${string}` ? H : P
type PathTail<P extends string, H extends string> = P extends `${H}.${infer R}` ? R : never

type RelationRecord<Schema extends SchemaDeclaration, C extends keyof Schema, K> =
    K extends keyof ExtractRelations<Schema, C>
        ? ExcludeUndefined<ExtractRelations<Schema, C>[K]>
        : never

type WrapNested<Rel, Nested> = Rel extends (infer U)[] ? (U & Nested)[] : Rel & Nested

type NestedExpand<Target, Tail extends string> = [Tail] extends [never]
    ? unknown
    : MetaOf<Target> extends PbMeta<infer S, infer N, infer R>
      ? { expand?: ExpandShape<S, N & keyof S, R, Tail> }
      : unknown

/**
 * The `expand` object type produced by a set of expand paths.
 */
export type ExpandShape<
    Schema extends SchemaDeclaration,
    C extends keyof Schema,
    Relations,
    P extends string,
> = {
    [H in PathHead<P>]?: WrapNested<
        RelationRecord<Schema, C, H>,
        NestedExpand<H extends keyof Relations ? Relations[H] : never, PathTail<P, H>>
    >
}

/**
 * Record type with an `expand` property for the given paths; the plain record when
 * there are none.
 */
export type WithExpandPaths<
    Schema extends SchemaDeclaration,
    C extends keyof Schema,
    Relations,
    P extends string,
> = [P] extends [never]
    ? ExtractRecordType<Schema, C>
    : ExtractRecordType<Schema, C> & { expand?: ExpandShape<Schema, C, Relations, P> }

/** @internal */
export type InsertInputOf<Schema extends SchemaDeclaration, C extends keyof Schema, Opts> =
    Opts extends { omitOnInsert: infer O extends readonly OmittableFields<ExtractRecordType<Schema, C>>[] }
        ? ComputeInsertType<ExtractRecordType<Schema, C>, O>
        : ExtractRecordType<Schema, C>
```

Then in `CreateCollectionOptions`, replace the `expand?: ExpandConfig<...>` member with:

```ts
    /**
     * Collections that receive the records PocketBase expands for each relation.
     * Declaring a relation here makes it available to `alwaysExpand` and to
     * `collection.expand()`.
     *
     * @example
     * ```ts
     * const authors = c('authors', {})
     * const books = c('books', { relations: { author: authors } })
     * ```
     */
    relations?: RelationsConfig<Schema, CollectionName>

    /**
     * Expand paths applied on every fetch. Each path must resolve through
     * `relations` (and, for nested paths, the target collection's `relations`).
     *
     * @example
     * ```ts
     * const books = c('books', { relations: { author: authors }, alwaysExpand: ['author'] })
     * // data[0].expand?.author is typed and populated on every fetch
     * ```
     */
    alwaysExpand?: readonly string[]
```

- [ ] **Step 4: Define `PbView`, `PbCollection`, and the new factory signature in `src/collection.ts`**

Replace `WithExpandFromConfig` and `InferCollectionType` with:

```ts
import type { Collection } from '@tanstack/db'
import type { QueryCollectionUtils } from '@tanstack/query-db-collection'
import type { QueryClient } from '@tanstack/react-query'
import type PocketBase from 'pocketbase'
import { buildCollection, type CreateCollectionFactoryOptions } from './build-collection'
import type {
    AlwaysExpandOf,
    CreateCollectionOptions,
    ExpandPath,
    InsertInputOf,
    PbMeta,
    RelationsOf,
    SchemaDeclaration,
    WithExpandPaths,
} from './types'

/**
 * A pbtsdb collection or view: a TanStack DB collection whose rows carry the
 * expand paths in `Paths`, plus pbtsdb's subscription helpers.
 */
export type PbView<
    Schema extends SchemaDeclaration,
    C extends keyof Schema & string,
    Opts,
    Paths extends string,
> = Collection<
    WithExpandPaths<Schema, C, RelationsOf<Opts>, Paths>,
    string | number,
    QueryCollectionUtils<
        WithExpandPaths<Schema, C, RelationsOf<Opts>, Paths>,
        string | number,
        WithExpandPaths<Schema, C, RelationsOf<Opts>, Paths>
    >,
    never,
    InsertInputOf<Schema, C, Opts>
> & {
    /** The PocketBase collection name */
    readonly collectionName: C
    /** Wait for the real-time subscription to be established (useful in tests) */
    waitForSubscription: (timeout?: number) => Promise<void>
    /** Whether the collection has an active real-time subscription */
    isSubscribed: () => boolean
    /** @internal phantom; never present at runtime */
    readonly __pbtsdb: PbMeta<Schema, C, RelationsOf<Opts>>
}

/**
 * The collection returned by {@link createCollection}: a {@link PbView} over the
 * `alwaysExpand` paths, plus `expand()` for per-query views.
 */
export type PbCollection<
    Schema extends SchemaDeclaration,
    C extends keyof Schema & string,
    Opts,
> = PbView<Schema, C, Opts, AlwaysExpandOf<Opts>> & {
    /**
     * A view of this collection whose queries also expand `paths`. Views share
     * this collection's store, realtime subscription, and mutations; only the
     * fetch differs. Paths must resolve through `relations`.
     *
     * @example
     * ```ts
     * const { data } = useLiveQuery(q => q.from({ books: books.expand('author') }))
     * data[0].expand?.author?.name
     * ```
     */
    expand<const P extends readonly ExpandPath<RelationsOf<Opts>>[]>(
        ...paths: P
    ): PbView<Schema, C, Opts, AlwaysExpandOf<Opts> | P[number]>
}

type AlwaysExpandCheck<Opts> = {
    alwaysExpand?: readonly ExpandPath<RelationsOf<Opts>>[]
}

export function createCollection<Schema extends SchemaDeclaration>(
    pb: PocketBase,
    queryClient: QueryClient,
    factoryOptions?: CreateCollectionFactoryOptions
) {
    return <C extends keyof Schema & string, const Opts extends CreateCollectionOptions<Schema, C>>(
        collectionName: C,
        options?: Opts & AlwaysExpandCheck<Opts>
    ): PbCollection<Schema, C, Opts> => {
        return buildCollection<Schema, C>({
            pb,
            queryClient,
            factoryOptions,
            collectionName,
            options,
        }) as unknown as PbCollection<Schema, C, Opts>
    }
}
```

Keep the existing JSDoc block on `createCollection`, updating its examples from `expand:` to `relations` + `alwaysExpand` and adding a per-query example.

- [ ] **Step 5: Temporary runtime shim in `src/build-collection.ts`**

So the migrated tests keep passing until Task 5 lands the real runtime, change the two lines that read the old option:

```ts
const expandStores = options?.relations as Record<string, ExpandTargetCollection> | undefined
const expandString = options?.alwaysExpand?.length
    ? [...options.alwaysExpand].sort().join(',')
    : undefined
```

Also add a placeholder `expand` that Task 5 replaces, so `PbCollection` callers do not hit `undefined`:

```ts
Object.assign(collection, {
    collectionName,
    waitForSubscription,
    isSubscribed: () => isSubscribed,
    expand: () => {
        throw new Error('expand() is not implemented yet')
    },
})
```

- [ ] **Step 6: Update exports in `src/core.ts`**

```ts
export {
    type CreateCollectionFactoryOptions,
    createCollection,
    type PbCollection,
    type PbView,
} from './collection'
export type {
    CreateCollectionOptions,
    ExcludeUndefined,
    ExpandPath,
    ExpandShape,
    ExtractRecordType,
    ExtractRelations,
    OmittableFields,
    ParseExpandFields,
    RelationAsCollection,
    RelationsConfig,
    SchemaDeclaration,
    WithExpand,
    WithExpandPaths,
} from './types'
```

- [ ] **Step 7: Migrate the existing tests**

In `test/expand.test.tsx`, `test/relations.test.ts`, and `test/includes.test.ts`, every

```ts
expand: {
    author: authorsCollection,
},
```

becomes

```ts
relations: { author: authorsCollection },
alwaysExpand: ['author'],
```

There are four sites in expand.test.tsx, four in relations.test.ts, one in includes.test.ts. Also update the `describe`/`it` titles that say "expand config" or "expand option" to say "alwaysExpand".

- [ ] **Step 8: Typecheck, then run the affected suites**

Run: `npm run checks`

Expected: green, including every `@ts-expect-error` in `test/expand-types.test.ts` being used. If `alwaysExpand: ['author']` is rejected because `Opts` inferred `string[]`, confirm the factory uses `const Opts`; if `PathTail` distributes wrongly and the nested assertion fails, check that `PathHead`/`PathTail` are applied to the union `P` (they must be distributive, which they are as written because `P` is a naked type parameter).

Run: `TEST="test/expand.test.tsx test/relations.test.ts test/includes.test.ts test/expand-types.test.ts" npm run test`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
npm run lint:fix
git add src/types.ts src/collection.ts src/core.ts src/build-collection.ts test
git commit -m "feat: relations and alwaysExpand options with typed expand paths"
```

---

### Task 5: Runtime for relations, alwaysExpand, nested upsert, and request-shaped query keys

**Files:**
- Modify: `src/build-collection.ts`
- Create: `test/expand-views.test.tsx` (first cases; later tasks extend it)

**Interfaces:**
- Produces on every built collection: `relationTargets: RelationTargets | undefined` (runtime property next to `collectionName`).
- Produces inside `buildCollection`: `type PbRequest = { filter?: string; sort?: string; limit?: number; expand?: string }`, `function toRequest(opts: LoadOptions): PbRequest`, `function activeExpand(request: PbRequest): string | undefined`, `const requestedExpand = new Set<string>()`.
- Produces: `type LoadOptions = LoadSubsetOptions & { expand?: readonly string[] }` replacing `ExtendedLoadSubsetOptions`.
- Consumes: Task 3 helpers.

- [ ] **Step 1: Write the failing tests**

`test/expand-views.test.tsx`:

```tsx
import { eq, useLiveQuery } from '@tanstack/react-db'
import type { QueryClient } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createCollection } from '../src'
import {
    authenticateTestUser,
    clearAuth,
    createTestLogger,
    createTestQueryClient,
    pb,
    resetLogger,
    setLogger,
    waitForLoadFinish,
} from './helpers'
import type { Schema } from './schema'

describe('Per-query expand', () => {
    let queryClient: QueryClient
    const testLogger = createTestLogger()

    beforeAll(async () => {
        await authenticateTestUser()
        setLogger(testLogger)
    })

    afterAll(() => {
        clearAuth()
        resetLogger()
    })

    beforeEach(() => {
        queryClient = createTestQueryClient()
        testLogger.clear()
    })

    afterEach(() => {
        queryClient.clear()
    })

    describe('alwaysExpand', () => {
        it('rejects an undeclared path at creation', () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', {})
            expect(() =>
                // @ts-expect-error runtime check of an undeclared path
                c('books', { relations: { author: authors }, alwaysExpand: ['nope'] })
            ).toThrow('Cannot expand "nope" on collection "books"')
            // @ts-expect-error runtime check without relations
            expect(() => c('books', { alwaysExpand: ['author'] })).toThrow(
                'no relations declared'
            )
        })

        it('expands nested paths and upserts each level into its target', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            const metadata = c('book_metadata', {
                syncMode: 'on-demand',
                relations: { book: books },
                alwaysExpand: ['book.author'],
            })

            const { result } = renderHook(() => useLiveQuery(q => q.from({ m: metadata })))
            await waitForLoadFinish(result, 10000)

            const row = result.current.data[0]
            expect(row.expand?.book?.id).toBe(row.book)
            expect(row.expand?.book?.expand?.author?.id).toBe(row.expand?.book?.author)

            await waitFor(() => {
                expect(books.has(row.book)).toBe(true)
                expect(authors.has(row.expand?.book?.author ?? '')).toBe(true)
            })
        }, 15000)

        it('exposes relation targets for nested validation', () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', {})
            const books = c('books', { relations: { author: authors } })
            expect(books.relationTargets?.author).toBe(authors)
            expect(authors.relationTargets).toBeUndefined()
        })
    })

    describe('query keys', () => {
        it('keys on-demand subsets by the PocketBase request', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', {})
            const books = c('books', {
                syncMode: 'on-demand',
                relations: { author: authors },
                alwaysExpand: ['author'],
            })

            const { result } = renderHook(() =>
                useLiveQuery(q =>
                    q
                        .from({ books })
                        .where(({ books }) => eq(books.genre, 'Fiction'))
                        .orderBy(({ books }) => books.title)
                        .limit(2)
                )
            )
            await waitForLoadFinish(result, 10000)

            const keys = queryClient
                .getQueryCache()
                .findAll({ queryKey: ['books'] })
                .map(query => query.queryKey)
            expect(keys).toContainEqual([
                'books',
                { filter: 'genre = "Fiction"', sort: 'title', limit: 2 },
            ])
        }, 15000)
    })
})
```

Note the expected filter string: confirm the exact output of `convertToPocketBaseFilter` for `eq(books.genre, 'Fiction')` by reading `src/pocketbase-query-converter.ts` (it emits `genre = "Fiction"`); adjust the literal if the converter differs.

`relationTargets` is a runtime-only property; add it to `PbView` in `src/collection.ts`:

```ts
    /** @internal relation targets declared through `relations` */
    readonly relationTargets: Record<string, unknown> | undefined
```

- [ ] **Step 2: Run to verify it fails**

Run: `TEST=test/expand-views.test.tsx npm run test`

Expected: FAIL. `alwaysExpand: ['nope']` does not throw, `relationTargets` is undefined, nested author is not upserted, and the query key is `['books', <serialized subset>]` rather than the request shape.

- [ ] **Step 3: Replace the option reading and expand-string logic in `buildCollection`**

At the top of the function body, replace the `expandStores`/`expandString` lines (and the Task 4 shim) with:

```ts
const relationTargets = options?.relations as RelationTargets | undefined
const alwaysExpand = normalizePaths(options?.alwaysExpand ?? [])
for (const path of alwaysExpand) validateExpandPath(collectionName, relationTargets, path)
const syncMode = options?.syncMode ?? 'eager'

// Paths requested by views that have subscribed at least once. Eager fetches
// read it because they cannot receive per-subset options; the realtime
// subscription reads it so echoes carry every relation in use.
const requestedExpand = new Set<string>()

type LoadOptions = LoadSubsetOptions & { expand?: readonly string[] }
type PbRequest = { filter?: string; sort?: string; limit?: number; expand?: string }

function toRequest(opts: LoadOptions | undefined): PbRequest {
    const request: PbRequest = {}
    const filter = convertToPocketBaseFilter(opts?.where)
    const sort = convertToPocketBaseSort(opts?.orderBy)
    const expand = joinPaths(opts?.expand ?? [])
    if (filter) request.filter = filter
    if (sort) request.sort = sort
    if (opts?.limit) request.limit = opts.limit
    if (expand) request.expand = expand
    return request
}

function queryKeyFor(opts: LoadOptions | undefined): [C] | [C, PbRequest] {
    const request = toRequest(opts)
    return Object.keys(request).length === 0 ? [collectionName] : [collectionName, request]
}

function activeExpand(request: PbRequest): string | undefined {
    return joinPaths([
        ...alwaysExpand,
        ...splitPaths(request.expand),
        ...(syncMode === 'eager' ? requestedExpand : []),
    ])
}
```

Import `normalizePaths`, `joinPaths`, `splitPaths`, `validateExpandPath`, and `type RelationTargets` from `./expand-paths`. Delete `ExtendedLoadSubsetOptions`.

- [ ] **Step 4: Make the upsert recursive**

Replace `upsertExpandedRelation` and `upsertExpandedRelations` with:

```ts
async function upsertInto(key: string, target: ExpandTargetCollection, values: object[]) {
    if (!target.utils) return
    if (!target.isReady()) {
        if (target.config?.syncMode === 'on-demand') {
            await target._sync.startSync()
        } else {
            logger.warn(`not syncing ${key} on ${collectionName} because store is not yet ready`)
            return
        }
    }
    target.utils.writeUpsert(values)
}

async function upsertExpanded(records: object[], targets: RelationTargets | undefined) {
    if (!targets) return
    for (const record of records) {
        const expandData = (record as { expand?: Record<string, object | object[]> }).expand
        if (!expandData) continue
        for (const [key, value] of Object.entries(expandData)) {
            const target = targets[key]
            if (!target) {
                logger.debug('No relation target for expanded field', { collectionName, key })
                continue
            }
            const values = Array.isArray(value) ? value : [value]
            await upsertInto(key, target, values)
            await upsertExpanded(values, target.relationTargets)
        }
    }
}
```

and change the call in `fetchRecords` to `await upsertExpanded(items, relationTargets)`.

- [ ] **Step 5: Switch `fetchItems`, `fetchRecords`, and `queryFn` to the request shape**

```ts
async function fetchItems(request: PbRequest): Promise<RecordType[]> {
    const { filter, sort, limit } = request
    const expand = activeExpand(request)
    if (limit) {
        const result = await pb.collection(collectionName).getList(1, limit, {
            filter,
            sort,
            skipTotal: true,
            expand,
        })
        return result.items as unknown as RecordType[]
    }
    return (await pb.collection(collectionName).getFullList({ filter, sort, expand })) as unknown as RecordType[]
}

async function fetchRecords(request: PbRequest, queryKey: readonly unknown[]): Promise<RecordType[]> {
    // body unchanged except: fetchItems(request), and the autocancel fallback reads
    // queryClient.getQueryData<RecordType[]>(queryKey) with no `?? [collectionName]`
}
```

and in `queryCollectionOptions`:

```ts
queryKey: queryKeyFor,
syncMode,
queryFn: async (ctx): Promise<RecordType[]> => {
    const request = (ctx.queryKey[1] as PbRequest | undefined) ?? {}
    return fetchRecords(request, ctx.queryKey)
},
```

`queryKeyFor` is typed against `LoadSubsetOptions`; if query-db-collection's `queryKey` option type rejects the wider `LoadOptions` parameter, declare `queryKeyFor` with `(opts?: LoadSubsetOptions)` and read `(opts as LoadOptions | undefined)?.expand` inside `toRequest`.

- [ ] **Step 6: Expose `relationTargets` on the instance**

```ts
Object.assign(collection, {
    collectionName,
    relationTargets,
    waitForSubscription,
    isSubscribed: () => isSubscribed,
    expand: () => {
        throw new Error('expand() is not implemented yet')
    },
})
```

- [ ] **Step 7: Run the new tests and the suites touched by the key change**

Run: `TEST="test/expand-views.test.tsx test/server-side-filtering.test.ts test/pagination.test.ts test/queries.test.ts test/expand.test.tsx test/relations.test.ts" npm run test`

Expected: PASS. If `server-side-filtering` asserts on query-key contents, update those assertions to the request shape; the observable PocketBase requests are unchanged.

- [ ] **Step 8: Full checks, full suite, commit**

```bash
npm run lint:fix && npm run checks && npm test
git add src/build-collection.ts src/collection.ts test/expand-views.test.tsx
git commit -m "feat: request-shaped query keys and nested relation upserts"
```

---

### Task 6: Views, subscription tagging, and the load-subset wrapper (on-demand)

**Files:**
- Modify: `src/build-collection.ts`
- Modify: `test/expand-views.test.tsx`
- Create: `test/tanstack-internals.test.ts`

**Interfaces:**
- Produces: `collection.expand(...paths: string[])` at runtime returning the base or a cached view.
- Produces: module-level `const viewPaths = new WeakMap<object, string[]>()` in `src/build-collection.ts`.
- Produces: `function noteViewSubscribed(paths: string[]): void` (this task: records into `requestedExpand` only; Task 7 adds refetch and realtime restart).
- Consumes: Task 5 `LoadOptions`, `requestedExpand`.

- [ ] **Step 1: Write the failing view tests**

Append to `test/expand-views.test.tsx` inside the outer `describe`:

```tsx
    describe('views (on-demand)', () => {
        function make() {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const tags = c('tags', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            const bookTags = c('book_tags', {
                syncMode: 'on-demand',
                relations: { book: books, tag: tags },
            })
            return { authors, tags, books, bookTags }
        }

        it('expands per query and upserts into the target', async () => {
            const { authors, books } = make()
            const view = books.expand('author')

            const { result } = renderHook(() =>
                useLiveQuery(q =>
                    q.from({ books: view }).where(({ books }) => eq(books.title, 'Animal Farm'))
                )
            )
            await waitForLoadFinish(result, 10000)

            const book = result.current.data[0]
            expect(book.expand?.author?.name).toBeTypeOf('string')
            await waitFor(() => expect(authors.has(book.author)).toBe(true))
        }, 15000)

        it('returns the same instance for the same normalized paths', () => {
            const { bookTags } = make()
            const a = bookTags.expand('tag', 'book')
            const b = bookTags.expand('book', 'tag', 'book')
            expect(a).toBe(b)
            expect(a).not.toBe(bookTags)
            expect(a.id).toBe('book_tags?expand=book,tag')
            expect(bookTags.expand('book')).not.toBe(a)
        })

        it('returns the base when nothing is added beyond alwaysExpand', () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', {})
            const books = c('books', { relations: { author: authors }, alwaysExpand: ['author'] })
            expect(books.expand()).toBe(books)
            expect(books.expand('author')).toBe(books)
        })

        it('shares one store: the base sees rows fetched through a view', async () => {
            const { books } = make()
            const view = books.expand('author')

            const viewQuery = renderHook(() =>
                useLiveQuery(q =>
                    q.from({ books: view }).where(({ books }) => eq(books.title, 'Animal Farm'))
                )
            )
            await waitForLoadFinish(viewQuery.result, 10000)
            const id = viewQuery.result.current.data[0].id

            expect(books.has(id)).toBe(true)
            const stored = books.get(id) as { expand?: { author?: { name: string } } }
            expect(stored.expand?.author?.name).toBeTypeOf('string')
        }, 15000)

        it('lets a base and a view of the same collection share one query', async () => {
            const { books } = make()
            const view = books.expand('author')

            const { result } = renderHook(() =>
                useLiveQuery(q =>
                    q
                        .from({ plain: books })
                        .join({ expanded: view }, ({ plain, expanded }) => eq(plain.id, expanded.id))
                        .where(({ plain }) => eq(plain.title, 'Animal Farm'))
                        .select(({ plain, expanded }) => ({
                            id: plain.id,
                            author: expanded?.expand?.author?.name,
                        }))
                )
            )
            await waitForLoadFinish(result, 10000)
            expect(result.current.data[0].author).toBeTypeOf('string')
        }, 15000)

        it('expands a nested path through the target collection', async () => {
            const { authors, books } = make()
            const metadata = createCollection<Schema>(pb, queryClient)('book_metadata', {
                syncMode: 'on-demand',
                relations: { book: books },
            })
            const view = metadata.expand('book.author')

            const { result } = renderHook(() => useLiveQuery(q => q.from({ m: view })))
            await waitForLoadFinish(result, 10000)

            const row = result.current.data[0]
            expect(row.expand?.book?.id).toBe(row.book)
            expect(row.expand?.book?.expand?.author?.id).toBe(row.expand?.book?.author)
            await waitFor(() => {
                expect(books.has(row.book)).toBe(true)
                expect(authors.has(row.expand?.book?.author ?? '')).toBe(true)
            })
        }, 15000)

        it('throws for an undeclared path and for expanding a view', () => {
            const { books } = make()
            // @ts-expect-error runtime check of an undeclared path
            expect(() => books.expand('nope')).toThrow(
                'Cannot expand "nope" on collection "books": segment "nope" is not a declared relation'
            )
            const view = books.expand('author')
            // @ts-expect-error views are leaves
            expect(() => view.expand('author')).toThrow('view of "books" cannot be expanded further')
        })

        it('keys a view fetch by its expand string', async () => {
            const { books } = make()
            const view = books.expand('author')
            const { result } = renderHook(() =>
                useLiveQuery(q =>
                    q.from({ books: view }).where(({ books }) => eq(books.title, 'Animal Farm'))
                )
            )
            await waitForLoadFinish(result, 10000)
            const keys = queryClient
                .getQueryCache()
                .findAll({ queryKey: ['books'] })
                .map(query => query.queryKey)
            expect(keys).toContainEqual([
                'books',
                { filter: 'title = "Animal Farm"', expand: 'author' },
            ])
        }, 15000)
    })
```

- [ ] **Step 2: Write the failing pinning test**

`test/tanstack-internals.test.ts`:

```ts
import { createCollection, createLiveQueryCollection, type LoadSubsetOptions } from '@tanstack/db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'

/**
 * pbtsdb's per-query expand rests on two behaviours TanStack DB does not
 * document. This test reproduces the mechanism with plain TanStack pieces so an
 * upgrade that changes either fails here, with a message naming the assumption.
 */
describe('TanStack DB assumptions behind per-query expand', () => {
    it('calls subscribeChanges on the object passed to from(), and forwards extra load options to queryKey', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const seenKeyOptions: Array<Record<string, unknown>> = []
        const seenLoadSubscriptions: unknown[] = []

        const options = queryCollectionOptions<{ id: string }>({
            queryClient,
            queryKey: (opts: LoadSubsetOptions) => {
                seenKeyOptions.push(opts as Record<string, unknown>)
                return ['pin']
            },
            queryFn: async () => [{ id: '1' }],
            getKey: item => item.id,
            syncMode: 'on-demand',
        })
        const innerSync = options.sync.sync
        options.sync = {
            ...options.sync,
            sync: params => {
                const res = innerSync(params)
                if (!res || typeof res === 'function' || !res.loadSubset) return res
                const { loadSubset } = res
                return {
                    ...res,
                    loadSubset: (opts: LoadSubsetOptions) => {
                        seenLoadSubscriptions.push(opts.subscription)
                        return loadSubset({ ...opts, marker: 'from-view' } as LoadSubsetOptions)
                    },
                }
            },
        }
        const base = createCollection(options)

        let subscribeCalledOnView = false
        const tagged = new WeakSet<object>()
        const view = Object.create(base) as typeof base
        Object.defineProperties(view, {
            id: { value: 'pin?view' },
            subscribeChanges: {
                value: (...args: Parameters<typeof base.subscribeChanges>) => {
                    subscribeCalledOnView = true
                    const subscription = base.subscribeChanges(...args)
                    tagged.add(subscription)
                    return subscription
                },
            },
        })

        const live = createLiveQueryCollection({ query: q => q.from({ v: view }) })
        await live.preload()

        expect(
            subscribeCalledOnView,
            'Assumption 1 broke: the live query no longer calls subscribeChanges on the object passed to from()'
        ).toBe(true)
        expect(
            seenLoadSubscriptions.some(s => typeof s === 'object' && s !== null && tagged.has(s)),
            'Assumption 1 broke: loadSubset no longer receives the subscription returned by subscribeChanges'
        ).toBe(true)
        expect(
            seenKeyOptions.some(o => o.marker === 'from-view'),
            'Assumption 2 broke: an extra field on load options no longer reaches queryKey(opts)'
        ).toBe(true)
        expect(live.toArray).toEqual([{ id: '1' }])
    })
})
```

- [ ] **Step 3: Run both files to verify they fail**

Run: `TEST="test/expand-views.test.tsx test/tanstack-internals.test.ts" npm run test`

Expected: the view tests fail with `expand() is not implemented yet`; the pinning test passes already (it uses no pbtsdb code). If the pinning test fails, stop: an assumption does not hold on the installed version, and the design must be revisited before continuing.

- [ ] **Step 4: Add the module-level tag map and wrap `loadSubset` / `unloadSubset`**

At module level in `src/build-collection.ts`:

```ts
// Subscriptions created through a view, mapped to the view's expand paths. Keyed
// by the subscription object TanStack hands back to loadSubset/unloadSubset.
const viewPaths = new WeakMap<object, string[]>()
```

Inside `buildCollection`, replace the sync wrapper so it also wraps the load functions:

```ts
function withViewExpand(opts: LoadSubsetOptions): LoadOptions {
    const paths = opts.subscription ? viewPaths.get(opts.subscription) : undefined
    return paths ? { ...opts, expand: paths } : opts
}

const innerSync = collectionOptions.sync.sync
collectionOptions.sync = {
    ...collectionOptions.sync,
    sync: (params: Parameters<typeof innerSync>[0]) => {
        const guardedWrite: typeof params.write = message => {
            if (shouldDropSyncedWrite(message as { type: string; value?: unknown; key?: unknown })) {
                return
            }
            return params.write(message)
        }
        const res = innerSync({ ...params, write: guardedWrite })
        if (!res || typeof res === 'function') return res
        const { loadSubset, unloadSubset } = res
        return {
            ...res,
            loadSubset: loadSubset ? opts => loadSubset(withViewExpand(opts)) : undefined,
            unloadSubset: unloadSubset ? opts => unloadSubset(withViewExpand(opts)) : undefined,
        }
    },
}
```

- [ ] **Step 5: Implement `expand()` and the view cache**

After `const collection = createTanStackCollection(collectionOptions)` and the helper definitions, add:

```ts
const views = new Map<string, object>()

function noteViewSubscribed(paths: string[]): void {
    for (const path of paths) requestedExpand.add(path)
}

function createView(paths: string[]): object {
    const view = Object.create(collection)
    Object.defineProperties(view, {
        id: { value: `${collectionName}?expand=${paths.join(',')}` },
        subscribeChanges: {
            value: (...args: Parameters<typeof collection.subscribeChanges>) => {
                noteViewSubscribed(paths)
                const subscription = collection.subscribeChanges(...args)
                viewPaths.set(subscription, paths)
                return subscription
            },
        },
        expand: {
            value: () => {
                throw new Error(`A view of "${collectionName}" cannot be expanded further`)
            },
        },
    })
    return view
}

function expand(...paths: string[]): object {
    for (const path of paths) validateExpandPath(collectionName, relationTargets, path)
    const all = normalizePaths([...alwaysExpand, ...paths])
    if (all.every(path => alwaysExpand.includes(path))) return collection
    const key = all.join(',')
    let view = views.get(key)
    if (!view) {
        view = createView(all)
        views.set(key, view)
    }
    return view
}
```

and replace the placeholder in `Object.assign(collection, { ... })` with `expand`.

- [ ] **Step 6: Run the tests**

Run: `TEST="test/expand-views.test.tsx test/tanstack-internals.test.ts" npm run test`

Expected: PASS. If the shared-store test fails because the base row lacks `expand`, check that `queryFn` reads `expand` from the key (Task 5) and that the view's subscription was tagged before its first `loadSubset` (it is, because `subscribeChanges` returns before TanStack requests the snapshot).

- [ ] **Step 7: Checks, full suite, commit**

```bash
npm run lint:fix && npm run checks && npm test
git add src/build-collection.ts test/expand-views.test.tsx test/tanstack-internals.test.ts
git commit -m "feat: per-query expand views over a shared store"
```

---

### Task 7: Merge rule, eager views, realtime expand, and echo upserts

**Files:**
- Modify: `src/build-collection.ts`
- Modify: `test/expand-views.test.tsx`

**Interfaces:**
- Consumes: `mergeExpand` from Task 3; `noteViewSubscribed`, `requestedExpand`, `alwaysExpand` from Tasks 5 and 6.
- Produces: `function realtimeSubscribeOptions(): RecordSubscribeOptions | undefined`, `async function restartSubscription(): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Append to `test/expand-views.test.tsx` inside the outer `describe`:

```tsx
    describe('shared store coherence', () => {
        async function createBook(authorId: string) {
            const book = await pb.collection('books').create({
                title: `Expand ${Date.now().toString().slice(-8)}`,
                genre: 'Fiction',
                isbn: `exp-${Date.now().toString().slice(-8)}`,
                author: authorId,
            })
            return book.id as string
        }

        it('keeps expand on a row when a plain fetch overwrites it, and drops it when the relation changes', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            const allAuthors = await pb.collection('authors').getFullList()
            const bookId = await createBook(allAuthors[0].id)
            try {
                const expanded = renderHook(() =>
                    useLiveQuery(q =>
                        q.from({ b: books.expand('author') }).where(({ b }) => eq(b.id, bookId))
                    )
                )
                await waitForLoadFinish(expanded.result, 10000)
                expect(expanded.result.current.data[0].expand?.author?.id).toBe(allAuthors[0].id)

                const plain = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ b: books })
                            .where(({ b }) => eq(b.id, bookId))
                            .orderBy(({ b }) => b.title)
                    )
                )
                await waitForLoadFinish(plain.result, 10000)
                expect(expanded.result.current.data[0].expand?.author?.id).toBe(allAuthors[0].id)

                await books.waitForSubscription()
                await pb.collection('books').update(bookId, { author: allAuthors[1].id })
                await waitFor(() =>
                    expect(expanded.result.current.data[0].author).toBe(allAuthors[1].id)
                )
                await waitFor(() =>
                    expect(expanded.result.current.data[0].expand?.author?.id).toBe(
                        allAuthors[1].id
                    )
                )
            } finally {
                await pb.collection('books').delete(bookId)
            }
        }, 20000)

        it('eager: a view created after load refetches and rows gain expand', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'eager', relations: { author: authors } })

            const plain = renderHook(() => useLiveQuery(q => q.from({ books })))
            await waitForLoadFinish(plain.result, 10000)
            expect((plain.result.current.data[0] as { expand?: unknown }).expand).toBeUndefined()

            const expanded = renderHook(() =>
                useLiveQuery(q => q.from({ books: books.expand('author') }))
            )
            await waitForLoadFinish(expanded.result, 10000)
            await waitFor(() =>
                expect(expanded.result.current.data[0].expand?.author?.name).toBeTypeOf('string')
            )
            await waitFor(() => expect(authors.size).toBeGreaterThan(0))
        }, 15000)

        it('subscribes realtime with the expand union so an echo keeps expand populated', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            const authorId = (await pb.collection('authors').getFirstListItem('')).id
            const bookId = await createBook(authorId)
            try {
                const { result } = renderHook(() =>
                    useLiveQuery(q =>
                        q.from({ b: books.expand('author') }).where(({ b }) => eq(b.id, bookId))
                    )
                )
                await waitForLoadFinish(result, 10000)
                await books.waitForSubscription()

                await pb.collection('books').update(bookId, { title: 'Echoed' })
                await waitFor(() => expect(result.current.data[0].title).toBe('Echoed'))
                expect(result.current.data[0].expand?.author?.id).toBe(authorId)
            } finally {
                await pb.collection('books').delete(bookId)
            }
        }, 20000)

        it('a mutation through a view is visible through the base immediately', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            const authorId = (await pb.collection('authors').getFirstListItem('')).id
            const bookId = await createBook(authorId)
            try {
                const view = books.expand('author')
                const viaView = renderHook(() =>
                    useLiveQuery(q => q.from({ b: view }).where(({ b }) => eq(b.id, bookId)))
                )
                const viaBase = renderHook(() =>
                    useLiveQuery(q => q.from({ b: books }).where(({ b }) => eq(b.id, bookId)))
                )
                await waitForLoadFinish(viaView.result, 10000)
                await waitForLoadFinish(viaBase.result, 10000)

                const viaViewTx = view.update(bookId, draft => {
                    draft.title = 'Optimistic via view'
                })
                await waitFor(() =>
                    expect(viaBase.result.current.data[0].title).toBe('Optimistic via view')
                )
                await viaViewTx.isPersisted.promise

                const viaBaseTx = books.update(bookId, draft => {
                    draft.title = 'Optimistic via base'
                })
                await waitFor(() =>
                    expect(viaView.result.current.data[0].title).toBe('Optimistic via base')
                )
                await viaBaseTx.isPersisted.promise
            } finally {
                await pb.collection('books').delete(bookId)
            }
        }, 20000)
    })
```

- [ ] **Step 2: Run to verify they fail**

Run: `TEST=test/expand-views.test.tsx npm run test`

Expected: the four new tests FAIL (expand wiped by the plain fetch, eager view never expands, echo drops expand, or the update test fails only if views do not inherit `update`, which they do, so that one may already pass).

- [ ] **Step 3: Apply the merge rule inside the guarded write**

Change `guardedWrite`:

```ts
const guardedWrite: typeof params.write = message => {
    const op = message as { type: string; value?: unknown; key?: unknown }
    if (shouldDropSyncedWrite(op)) return
    if ((op.type === 'insert' || op.type === 'update') && op.value && typeof op.value === 'object') {
        const key = syncedWriteKey(op)
        const existing = key === null ? undefined : (collection._state.syncedData.get(key) as RecordType | undefined)
        const merged = mergeExpand(op.value as RecordType, existing)
        if (merged !== op.value) return params.write({ ...message, value: merged })
    }
    return params.write(message)
}
```

Import `mergeExpand` from `./expand-merge`. `collection` is declared after the wrapper is installed but before any write runs, as the existing guard already relies on.

- [ ] **Step 4: Eager refetch and realtime restart in `noteViewSubscribed`**

```ts
function noteViewSubscribed(paths: string[]): void {
    let grew = false
    for (const path of paths) {
        if (requestedExpand.has(path)) continue
        requestedExpand.add(path)
        grew = true
    }
    if (!grew) return
    if (syncMode === 'eager' && collection.status !== 'idle' && collection.status !== 'cleaned-up') {
        void collection.utils.refetch()
    }
    if (isSubscribed) {
        restartSubscription().catch(error =>
            logger.error('Failed to restart subscription with wider expand', { collectionName, error })
        )
    }
}
```

`noteViewSubscribed` references `isSubscribed` and `restartSubscription`, which are declared later in the function body; since it only runs from `subscribeChanges` after construction, that is fine, but move the definition below `stopSubscription` to keep the reading order sane.

- [ ] **Step 5: Realtime subscribe options with the expand union, restart, and echo upserts**

```ts
function realtimeSubscribeOptions(): RecordSubscribeOptions | undefined {
    const base = factoryOptions?.subscribeOptions?.()
    const expand = joinPaths([...alwaysExpand, ...requestedExpand, ...splitPaths(base?.expand)])
    return expand ? { ...base, expand } : base
}

const restartSubscription = async () => {
    await stopSubscription()
    await startSubscription()
}
```

In `startSubscription`, replace `factoryOptions?.subscribeOptions?.()` with `realtimeSubscribeOptions()`.

In `handleRealtimeEvent`, after the `writeOwn(...)` block succeeds (inside the `try`, after the batch), add:

```ts
if (event.action !== 'delete') {
    upsertExpanded([event.record], relationTargets).catch(error =>
        logger.error('Failed to upsert expanded records from realtime echo', { collectionName, error })
    )
}
```

- [ ] **Step 6: Run the tests**

Run: `TEST="test/expand-views.test.tsx test/subscriptions.test.ts test/subscribe-options.test.ts test/realtime-delete-echo.test.ts" npm run test`

Expected: PASS. If the echo test still drops `expand`, confirm PocketBase includes `expand` on realtime records when the subscribe options carry it (log `event.record` at debug level while diagnosing, then remove the log).

- [ ] **Step 7: Checks, full suite, commit**

```bash
npm run lint:fix && npm run checks && npm test
git add src/build-collection.ts test/expand-views.test.tsx
git commit -m "feat: expand merge on synced writes, eager views, realtime expand union"
```

---

### Task 8: Documentation, changelog, and cleanup

**Files:**
- Modify: `README.md`
- Modify: `llms.txt`
- Modify: `CHANGELOG.md`
- Modify: `src/react.tsx` (JSDoc example only)
- Modify: `test/README.md`

- [ ] **Step 1: README options list**

Under "### createCollection()" → "**Options:**", replace the `expand?` line with:

```markdown
- `relations?: Record<string, Collection>` - Collections that receive expanded records for each relation; declares what `alwaysExpand` and `collection.expand()` may name
- `alwaysExpand?: readonly string[]` - Expand paths applied on every fetch (e.g. `['author', 'book.author']`)
```

- [ ] **Step 2: README examples**

Replace the "With auto-expand relations:" example block (search for that heading in README.md) with:

```markdown
With always-expanded relations:
```typescript
const c = createCollection<MySchema>(pb, queryClient);
const authorsCollection = c('authors', {});
const booksCollection = c('books', {
    relations: { author: authorsCollection },  // where expanded authors are upserted
    alwaysExpand: ['author'],                  // expanded on every fetch
});

const { data } = useLiveQuery((q) => q.from({ books: booksCollection }));
// data[0].expand?.author is typed and populated
```

#### Per-query expand

Declare relations once, then ask for expansion per query with `collection.expand()`.
A view shares the collection's store, realtime subscription, and mutations; only
its fetches add the `expand` parameter.

```typescript
const tagsCollection = c('tags', {});
const booksCollection = c('books', {
    relations: { author: authorsCollection, tags: tagsCollection },
});

function BookList() {
    const [books] = useStore('books');
    const { data } = useLiveQuery((q) =>
        q.from({ books: books.expand('tags') })
         .where(({ books }) => eq(books.genre, 'Fiction'))
    );
    // data[0].expand?.tags is Tags[] | undefined; data[0].expand?.author is a type error
}
```

Paths can be nested through a target collection's own `relations`:

```typescript
const metadata = c('book_metadata', { relations: { book: booksCollection } });
const { data } = useLiveQuery((q) => q.from({ m: metadata.expand('book.author') }));
// data[0].expand?.book?.expand?.author?.name
```

Rows fetched through a view keep their `expand` data in the shared store, and the
realtime subscription requests every relation in use, so echoes keep it populated.
```

Also update the other README passages that configure expand. Find them with `grep -n 'expand: {' README.md`: "Combining expand with includes", the "✅ Good - with auto-expand relations" snippet under Type Safety, "Create Dependencies Before Dependents", and "Use Expand for Performance". In each, `expand: { author: authors }` becomes `relations: { author: authors }, alwaysExpand: ['author']`.

The getting-started example (section "2. Set Up Your App", the `createReactProvider({...})` block) reads `post.expand?.author?.username` later but never configures expand, so it would not typecheck today. Fix it so `users` is created first and `posts` and `comments` declare it:

```typescript
const c = createCollection<BlogSchema>(pb, queryClient);
const users = c('users', {});
export const { Provider, useStore } = createReactProvider({
    users,
    posts: c('posts', {
        omitOnInsert: ['created', 'updated'] as const,
        relations: { author: users },
        alwaysExpand: ['author'],
    }),
    comments: c('comments', {
        omitOnInsert: ['created', 'updated'] as const,
        relations: { author: users },
        alwaysExpand: ['author'],
    }),
});
```

- [ ] **Step 3: llms.txt**

In "Approach 1: Auto-Expand (Recommended)", replace the code block with the always-expanded example from Step 2, and add after its bullet list:

```markdown
**Per-query expand**
```typescript
const books = c('books', { relations: { author: authors, tags } });
const { data } = useLiveQuery((q) => q.from({ books: books.expand('tags') }));
// data[0].expand?.tags typed; nested paths like 'book.author' resolve through
// the target collection's own relations. Views share the base store.
```
```

- [ ] **Step 4: JSDoc in `src/react.tsx`**

In the "With auto-expand collections" example, replace `expand: { author: authors }` with `relations: { author: authors }, alwaysExpand: ['author']`.

- [ ] **Step 5: CHANGELOG**

Add above `## [0.7.3]`:

```markdown
## [0.8.0] - 2026-09-11

### Changed

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

### Fixed

- The realtime subscription now requests every expand path in use, so an echo
  no longer wipes `expand` from an always-expanded row.
```

- [ ] **Step 6: test/README.md**

Add under "### Core Test Suites":

```markdown
#### `expand-views.test.tsx`
Per-query expand views, nested paths, shared-store coherence, eager refetch, realtime expand.

#### `expand-helpers.test.ts`
Pure helpers for expand paths and expand merging.

#### `tanstack-internals.test.ts`
Pins the two undocumented TanStack DB behaviours per-query expand relies on. If this fails after an upgrade, read the assertion message before touching anything else.
```

- [ ] **Step 7: Final verification**

Run: `npm run checks && npm test && npm run build`

Expected: all green; `dist/` builds. Then `git status` shows only the intended files.

- [ ] **Step 8: Commit**

```bash
git add README.md llms.txt CHANGELOG.md src/react.tsx test/README.md
git commit -m "docs: relations, alwaysExpand and per-query expand"
```

Release is `npm version minor` by the maintainer, not part of this plan.
