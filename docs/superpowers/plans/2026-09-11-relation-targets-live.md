# Relation Targets Stay Live Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While a live query expands into relation targets, keep those targets' realtime subscriptions open and patch their changes into the embedded `expand` copies on parent rows, without leaks or update loops.

**Architecture:** A collection's realtime start holds a bare `subscribeChanges` on every collection along its active expand paths and releases them on its last-subscriber stop (one `Map`, diffed by `syncHeldSubscriptions`). Each collection registers itself as a dependent on its relation targets at creation; a target's realtime handler, after its own write, asks each dependent to patch rows via a pure `patchEmbedded`, writes the patched rows through the authoritative path, and propagates to nested dependents with a shared `visited` set. Unchanged results return `undefined`, so redelivered echoes never write.

**Tech Stack:** TypeScript 5.9, `@tanstack/db` 0.9, `@tanstack/query-db-collection` 1.2, `@tanstack/react-db` 0.3, PocketBase JS SDK, Vitest 4 against the live PocketBase test server, Biome.

Spec: `docs/superpowers/specs/2026-09-11-relation-targets-live-design.md`. Read it first. Same branch as PR #12 (`feat/per-query-expand`).

## Global Constraints

- No `any`, even with biome-ignore, except the pre-existing `RelationAsCollection` block in types.ts.
- Never mutate a row, a sync write message, or a load options object; spread into new objects.
- Held subscriptions are mutated only by `syncHeldSubscriptions(desired)`; a normal stop (last subscriber left) releases all; a restart keeps them and only adds.
- Dependents register once at creation, never per subscribe or per view.
- Patching uses the authoritative write path (`writeOwn` + `utils.writeUpsert`) and writes only rows `patchEmbedded` changed; `patchEmbedded` returns `undefined` when the result would be `deepEquals` to the existing entry.
- Delete echoes clear the reference (`''` for single, filtered array for multi) and the copy; update echoes touch only rows with an embedded copy.
- Every background failure logs with `logger.error` and never escapes the realtime handler.
- Tests: `waitFor` on state or counters only, no sleeps, no timeout bumps. `npm run checks` and the named test files green after every task; full `npm test` once before each commit. A red check is fixed at its source, never skipped or retried.
- Biome: 4-space indent, single quotes, no semicolons, ES5 trailing commas, line width 100. `npm run lint:fix` before committing. Comments only for critical context. Use `logger`, never console.
- Commits: conventional prefixes, no attribution lines, no mention of Claude.

## File Map

| File | Responsibility |
| --- | --- |
| `src/expand-patch.ts` (new) | pure `patchEmbedded(row, field, action, record)` |
| `src/types.ts` | `ExpandTargetCollection` gains `subscribeChanges?`, `subscriberCount?`, `relationDependents?`, `applyRelatedChange?`; `RelationDependent` type |
| `src/build-collection.ts` | held subscriptions; dependents registration; `applyRelatedChange`; trigger in the realtime handler; internal counters |
| `src/collection.ts` | `PbView` gains the `@internal` runtime members tests read |
| `test/expand-helpers.test.ts` | unit tests for `patchEmbedded` and for cyclic propagation with fakes |
| `test/expand-views.test.tsx` | new block `relation targets stay live` |
| `README.md`, `CHANGELOG.md`, spec for PR #12 | docs |

---

### Task 1: `patchEmbedded`

**Files:**
- Create: `src/expand-patch.ts`
- Modify: `test/expand-helpers.test.ts` (append a `describe`)

**Interfaces:**
- Produces: `export type RelatedAction = 'create' | 'update' | 'delete'` and `export function patchEmbedded<T extends object>(row: T, field: string, action: RelatedAction, record: { id: string }): T | undefined` in `src/expand-patch.ts`.
- Consumes: `mergeExpand` from `src/expand-merge.ts` (`mergeExpand<T extends object>(incoming: T, existing: T | undefined): T`), `deepEquals` from `@tanstack/db`.

- [ ] **Step 1: Write the failing tests**

Append to `test/expand-helpers.test.ts` (add `import { patchEmbedded } from '../src/expand-patch'` to the imports):

```ts
describe('patchEmbedded', () => {
    const author = { id: 'a1', name: 'Orwell', updated: '1' }
    const renamed = { id: 'a1', name: 'George Orwell', updated: '2' }

    describe('update, single relation', () => {
        it('replaces the embedded copy', () => {
            const row = { id: 'b1', author: 'a1', expand: { author } }
            const patched = patchEmbedded(row, 'author', 'update', renamed)
            expect(patched).toEqual({ id: 'b1', author: 'a1', expand: { author: renamed } })
            expect(patched).not.toBe(row)
            expect(row.expand.author).toBe(author)
        })

        it('returns undefined when the embedded id differs', () => {
            const row = { id: 'b1', author: 'a1', expand: { author } }
            expect(patchEmbedded(row, 'author', 'update', { id: 'a2' })).toBeUndefined()
        })

        it('returns undefined when the row has no embedded copy', () => {
            expect(patchEmbedded({ id: 'b1', author: 'a1' }, 'author', 'update', renamed)).toBeUndefined()
            expect(
                patchEmbedded({ id: 'b1', author: 'a1', expand: {} }, 'author', 'update', renamed)
            ).toBeUndefined()
        })

        it('returns undefined when the record is unchanged', () => {
            const row = { id: 'b1', author: 'a1', expand: { author } }
            expect(patchEmbedded(row, 'author', 'update', { ...author })).toBeUndefined()
        })

        it('treats create like update', () => {
            const row = { id: 'b1', author: 'a1', expand: { author } }
            expect(patchEmbedded(row, 'author', 'create', renamed)?.expand.author).toEqual(renamed)
        })

        it('carries a nested expand the echo lacks', () => {
            const org = { id: 'o1', name: 'Org' }
            const embedded = { id: 'a1', name: 'Orwell', org: 'o1', expand: { org } }
            const row = { id: 'b1', author: 'a1', expand: { author: embedded } }
            const echo = { id: 'a1', name: 'George Orwell', org: 'o1' }
            expect(patchEmbedded(row, 'author', 'update', echo)?.expand.author).toEqual({
                ...echo,
                expand: { org },
            })
        })
    })

    describe('update, multi relation', () => {
        const t1 = { id: 't1', name: 'one' }
        const t2 = { id: 't2', name: 'two' }
        const t3 = { id: 't3', name: 'three' }

        it('replaces the matching element in place, preserving order', () => {
            const row = { id: 'b1', tags: ['t1', 't2', 't3'], expand: { tags: [t1, t2, t3] } }
            const patched = patchEmbedded(row, 'tags', 'update', { id: 't2', name: 'TWO' })
            expect(patched?.expand.tags).toEqual([t1, { id: 't2', name: 'TWO' }, t3])
            expect(row.expand.tags[1]).toBe(t2)
        })

        it('returns undefined when the id is not embedded', () => {
            const row = { id: 'b1', tags: ['t1'], expand: { tags: [t1] } }
            expect(patchEmbedded(row, 'tags', 'update', { id: 't9', name: 'x' })).toBeUndefined()
        })

        it('returns undefined when the element is unchanged', () => {
            const row = { id: 'b1', tags: ['t1', 't2'], expand: { tags: [t1, t2] } }
            expect(patchEmbedded(row, 'tags', 'update', { ...t2 })).toBeUndefined()
        })
    })

    describe('delete, single relation', () => {
        it('clears the reference and removes the copy', () => {
            const row = { id: 'b1', author: 'a1', expand: { author } }
            const patched = patchEmbedded(row, 'author', 'delete', { id: 'a1' })
            expect(patched).toEqual({ id: 'b1', author: '', expand: {} })
            expect(row.author).toBe('a1')
            expect(row.expand.author).toBe(author)
        })

        it('clears the reference on a row with no copy', () => {
            expect(patchEmbedded({ id: 'b1', author: 'a1' }, 'author', 'delete', { id: 'a1' })).toEqual({
                id: 'b1',
                author: '',
            })
        })

        it('returns undefined when the row does not reference the id', () => {
            const row = { id: 'b1', author: 'a2', expand: { author: { id: 'a2' } } }
            expect(patchEmbedded(row, 'author', 'delete', { id: 'a1' })).toBeUndefined()
        })
    })

    describe('delete, multi relation', () => {
        const t1 = { id: 't1' }
        const t2 = { id: 't2' }

        it('filters the id out of the field and the copy, preserving order', () => {
            const row = { id: 'b1', tags: ['t1', 't2'], expand: { tags: [t1, t2] } }
            const patched = patchEmbedded(row, 'tags', 'delete', { id: 't1' })
            expect(patched).toEqual({ id: 'b1', tags: ['t2'], expand: { tags: [t2] } })
            expect(row.tags).toEqual(['t1', 't2'])
        })

        it('filters the field on a row with no copy', () => {
            expect(patchEmbedded({ id: 'b1', tags: ['t1', 't2'] }, 'tags', 'delete', { id: 't2' })).toEqual({
                id: 'b1',
                tags: ['t1'],
            })
        })

        it('returns undefined when the array lacks the id', () => {
            const row = { id: 'b1', tags: ['t1'], expand: { tags: [t1] } }
            expect(patchEmbedded(row, 'tags', 'delete', { id: 't9' })).toBeUndefined()
        })
    })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `TEST=test/expand-helpers.test.ts npm run test`

Expected: FAIL, module `../src/expand-patch` not found.

- [ ] **Step 3: Implement `src/expand-patch.ts`**

```ts
import { deepEquals } from '@tanstack/db'
import { mergeExpand } from './expand-merge'

export type RelatedAction = 'create' | 'update' | 'delete'

type Embedded = { id: string }
type Row = Record<string, unknown> & { expand?: Record<string, unknown> }

function embeddedId(value: unknown): string | undefined {
    return (value as Embedded | null | undefined)?.id
}

function patchUpdate(row: Row, field: string, record: Embedded): Row | undefined {
    const embedded = row.expand?.[field]
    if (embedded === undefined) return undefined
    let next: unknown
    if (Array.isArray(embedded)) {
        const index = embedded.findIndex(entry => embeddedId(entry) === record.id)
        if (index === -1) return undefined
        const replaced = mergeExpand(record, embedded[index] as Embedded)
        next = embedded.map((entry, i) => (i === index ? replaced : entry))
    } else {
        if (embeddedId(embedded) !== record.id) return undefined
        next = mergeExpand(record, embedded as Embedded)
    }
    if (deepEquals(next, embedded)) return undefined
    return { ...row, expand: { ...row.expand, [field]: next } }
}

function patchDelete(row: Row, field: string, id: string): Row | undefined {
    const value = row[field]
    const embedded = row.expand?.[field]
    if (Array.isArray(value)) {
        if (!value.includes(id)) return undefined
        const patched: Row = { ...row, [field]: value.filter(item => item !== id) }
        if (Array.isArray(embedded)) {
            patched.expand = {
                ...row.expand,
                [field]: embedded.filter(entry => embeddedId(entry) !== id),
            }
        }
        return patched
    }
    if (value !== id) return undefined
    const patched: Row = { ...row, [field]: '' }
    if (embedded !== undefined) {
        const expand = { ...row.expand }
        delete expand[field]
        patched.expand = expand
    }
    return patched
}

/**
 * Apply a relation target's realtime change to one parent row. Returns a new
 * row, or `undefined` when the row is unaffected or the result would be
 * identical, so callers can skip the write.
 */
export function patchEmbedded<T extends object>(
    row: T,
    field: string,
    action: RelatedAction,
    record: Embedded
): T | undefined {
    const current = row as Row
    const patched =
        action === 'delete'
            ? patchDelete(current, field, record.id)
            : patchUpdate(current, field, record)
    return patched as T | undefined
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `TEST=test/expand-helpers.test.ts npm run test`

Expected: PASS (14 existing + 15 new).

- [ ] **Step 5: Checks and commit**

```bash
npm run lint:fix && npm run checks
git add src/expand-patch.ts test/expand-helpers.test.ts
git commit -m "feat: patchEmbedded applies a relation echo to a parent row"
```

---

### Task 2: Held subscriptions on relation targets

**Files:**
- Modify: `src/types.ts` (`ExpandTargetCollection`)
- Modify: `src/build-collection.ts`
- Modify: `src/collection.ts` (`PbView`)
- Modify: `test/expand-views.test.tsx` (new block)

**Interfaces:**
- Produces on `ExpandTargetCollection`: `subscribeChanges?: (callback: () => void, options: { includeInitialState: false }) => { unsubscribe: () => void }`, `subscriberCount?: number`.
- Produces inside `buildCollection`: `function activeExpandTargets(): Set<ExpandTargetCollection>`, `function syncHeldSubscriptions(desired: Set<ExpandTargetCollection>): void`, `doStopSubscription(releaseTargets = true)`.
- Produces on the instance (and `PbView`, `@internal`): `heldRelationTargetCount: () => number`.
- Consumes: `pendingSubscribeExpand()`, `relationTargets`, `splitPaths`, the subscription work tail, `doStartSubscription` / `doStopSubscription` / `doRestartSubscription`.

- [ ] **Step 1: Write the failing tests**

Add to `test/expand-views.test.tsx`, inside the outer `describe`, a new block. It needs `getTestAuthorId` and `getTestSlug` from `./helpers` (already imported in the file for the race test) and `vi` from vitest.

```tsx
    describe('relation targets stay live', () => {
        type Internals = {
            heldRelationTargetCount: () => number
            subscriberCount: number
            status: string
        }
        const internals = (c: unknown) => c as Internals

        it('holds the target subscription while a view is live and releases it after', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })

            const query = renderHook(() =>
                useLiveQuery(q =>
                    q
                        .from({ b: books.expand('author') })
                        .orderBy(({ b }) => b.id)
                        .limit(1)
                )
            )
            await waitForLoadFinish(query.result, 10000)
            await books.waitForSubscription(10000)
            await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 10000 })
            expect(internals(authors).subscriberCount).toBe(1)
            expect(internals(books).heldRelationTargetCount()).toBe(1)

            query.unmount()
            await waitFor(() => expect(books.isSubscribed()).toBe(false), { timeout: 10000 })
            await waitFor(() => expect(authors.isSubscribed()).toBe(false), { timeout: 10000 })
            expect(internals(authors).subscriberCount).toBe(0)
            expect(internals(books).heldRelationTargetCount()).toBe(0)
        }, 20000)

        it('holds every collection along a nested path', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            const metadata = c('book_metadata', {
                syncMode: 'on-demand',
                relations: { book: books },
            })

            const query = renderHook(() =>
                useLiveQuery(q =>
                    q
                        .from({ m: metadata.expand('book.author') })
                        .orderBy(({ m }) => m.id)
                        .limit(1)
                )
            )
            await waitForLoadFinish(query.result, 10000)
            await metadata.waitForSubscription(10000)
            await waitFor(() => expect(books.isSubscribed()).toBe(true), { timeout: 10000 })
            await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 10000 })
            expect(internals(metadata).heldRelationTargetCount()).toBe(2)

            query.unmount()
            await waitFor(() => expect(metadata.isSubscribed()).toBe(false), { timeout: 10000 })
            await waitFor(() => expect(books.isSubscribed()).toBe(false), { timeout: 10000 })
            await waitFor(() => expect(authors.isSubscribed()).toBe(false), { timeout: 10000 })
        }, 20000)

        it('union growth through the restart path adds targets without bouncing existing ones', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const tags = c('tags', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            const bookTags = c('book_tags', {
                syncMode: 'on-demand',
                relations: { book: books, tag: tags },
            })

            const unsubscribeSpies: ReturnType<typeof vi.fn>[] = []
            const realSubscribe = pb.collection('books').subscribe.bind(pb.collection('books'))
            const subscribeSpy = vi
                .spyOn(pb.collection('books'), 'subscribe')
                .mockImplementation(async (...args) => {
                    const unsubscribe = await realSubscribe(...args)
                    const spy = vi.fn(unsubscribe)
                    unsubscribeSpies.push(spy)
                    return spy
                })

            try {
                const first = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ bt: bookTags.expand('book') })
                            .orderBy(({ bt }) => bt.id)
                            .limit(1)
                    )
                )
                await waitForLoadFinish(first.result, 10000)
                await bookTags.waitForSubscription(10000)
                await waitFor(() => expect(books.isSubscribed()).toBe(true), { timeout: 10000 })
                expect(internals(bookTags).heldRelationTargetCount()).toBe(1)

                const second = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ bt: bookTags.expand('tag') })
                            .orderBy(({ bt }) => bt.id)
                            .limit(1)
                    )
                )
                await waitForLoadFinish(second.result, 10000)
                await waitFor(() => expect(tags.isSubscribed()).toBe(true), { timeout: 10000 })

                const third = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ bt: bookTags.expand('book.author') })
                            .orderBy(({ bt }) => bt.id)
                            .limit(1)
                    )
                )
                await waitForLoadFinish(third.result, 10000)
                await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 10000 })

                await waitFor(() => expect(internals(bookTags).heldRelationTargetCount()).toBe(3))
                expect(internals(books).subscriberCount).toBe(1)
                expect(internals(tags).subscriberCount).toBe(1)
                expect(internals(authors).subscriberCount).toBe(1)
                // books was held from the first view and never released across
                // the two restarts: exactly one PocketBase subscribe, no unsubscribe.
                expect(subscribeSpy).toHaveBeenCalledTimes(1)
                expect(unsubscribeSpies[0]).not.toHaveBeenCalled()

                first.unmount()
                second.unmount()
                third.unmount()
                await waitFor(() => expect(bookTags.isSubscribed()).toBe(false), { timeout: 10000 })
                await waitFor(() => expect(internals(bookTags).heldRelationTargetCount()).toBe(0))
                await waitFor(() => expect(unsubscribeSpies[0]).toHaveBeenCalledTimes(1))
            } finally {
                subscribeSpy.mockRestore()
            }
        }, 30000)

        it('twenty mount/unmount cycles leave nothing held and balanced PocketBase calls', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })

            const unsubscribeSpies: ReturnType<typeof vi.fn>[] = []
            const realSubscribe = pb.collection('authors').subscribe.bind(pb.collection('authors'))
            const subscribeSpy = vi
                .spyOn(pb.collection('authors'), 'subscribe')
                .mockImplementation(async (...args) => {
                    const unsubscribe = await realSubscribe(...args)
                    const spy = vi.fn(unsubscribe)
                    unsubscribeSpies.push(spy)
                    return spy
                })

            try {
                for (let cycle = 0; cycle < 20; cycle++) {
                    const query = renderHook(() =>
                        useLiveQuery(q =>
                            q
                                .from({ b: books.expand('author') })
                                .orderBy(({ b }) => b.id)
                                .limit(1)
                        )
                    )
                    await waitForLoadFinish(query.result, 10000)
                    await books.waitForSubscription(10000)
                    await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 10000 })
                    query.unmount()
                    await waitFor(() => expect(books.isSubscribed()).toBe(false), { timeout: 10000 })
                    await waitFor(() => expect(authors.isSubscribed()).toBe(false), { timeout: 10000 })
                    expect(internals(authors).subscriberCount).toBe(0)
                    expect(internals(books).heldRelationTargetCount()).toBe(0)
                }
                expect(subscribeSpy).toHaveBeenCalledTimes(unsubscribeSpies.length)
                for (const spy of unsubscribeSpies) expect(spy).toHaveBeenCalledTimes(1)
            } finally {
                subscribeSpy.mockRestore()
            }
        }, 120000)

        it('lets a released target garbage collect', async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', {
                syncMode: 'on-demand',
                collectionOptions: { gcTime: 50 },
            })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })

            const query = renderHook(() =>
                useLiveQuery(q =>
                    q
                        .from({ b: books.expand('author') })
                        .orderBy(({ b }) => b.id)
                        .limit(1)
                )
            )
            await waitForLoadFinish(query.result, 10000)
            await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 10000 })

            query.unmount()
            await waitFor(() => expect(internals(authors).status).toBe('cleaned-up'), {
                timeout: 10000,
            })
        }, 20000)

        it('creating views holds nothing until one subscribes', () => {
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const tags = c('tags', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            const bookTags = c('book_tags', {
                syncMode: 'on-demand',
                relations: { book: books, tag: tags },
            })
            for (let i = 0; i < 50; i++) {
                bookTags.expand(i % 2 === 0 ? 'book' : 'tag')
                bookTags.expand('book', 'tag')
            }
            expect(internals(bookTags).heldRelationTargetCount()).toBe(0)
            expect(internals(books).subscriberCount).toBe(0)
            expect(internals(tags).subscriberCount).toBe(0)
        })
    })
```

- [ ] **Step 2: Run to verify it fails**

Run: `TEST=test/expand-views.test.tsx npm run test`

Expected: FAIL. `heldRelationTargetCount is not a function`, and `authors.isSubscribed()` never becomes true.

- [ ] **Step 3: Extend `ExpandTargetCollection` in `src/types.ts`**

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
    /** Subscribe without requesting data; keeps the target live while held. */
    subscribeChanges?: (
        callback: () => void,
        options: { includeInitialState: false }
    ) => { unsubscribe: () => void }
    subscriberCount?: number
}
```

- [ ] **Step 4: Held subscriptions in `src/build-collection.ts`**

Add after `pendingSubscribeExpand`:

```ts
    // Collections along every active expand path. Held live (below) so their
    // realtime echoes reach this collection's embedded copies.
    function activeExpandTargets(): Set<ExpandTargetCollection> {
        const targets = new Set<ExpandTargetCollection>()
        for (const path of splitPaths(pendingSubscribeExpand())) {
            let current: RelationTargets | undefined = relationTargets
            for (const segment of path.split('.')) {
                const target: ExpandTargetCollection | undefined = current?.[segment]
                if (!target) break
                targets.add(target)
                current = target.relationTargets
            }
        }
        return targets
    }

    // The only place held target subscriptions are added or removed, so the
    // map always mirrors the last desired set exactly.
    const heldTargetSubscriptions = new Map<ExpandTargetCollection, { unsubscribe: () => void }>()
    function syncHeldSubscriptions(desired: Set<ExpandTargetCollection>): void {
        for (const [target, held] of heldTargetSubscriptions) {
            if (desired.has(target)) continue
            heldTargetSubscriptions.delete(target)
            try {
                held.unsubscribe()
            } catch (error) {
                logger.error('Failed to release relation target subscription', {
                    collectionName,
                    error,
                })
            }
        }
        for (const target of desired) {
            if (heldTargetSubscriptions.has(target) || !target.subscribeChanges) continue
            try {
                const held = target.subscribeChanges(() => {}, { includeInitialState: false })
                heldTargetSubscriptions.set(target, held)
            } catch (error) {
                logger.error('Failed to hold relation target subscription', {
                    collectionName,
                    error,
                })
            }
        }
    }
```

In `doStartSubscription`, inside the `try` right after `subscribedExpand = pendingExpand`, add:

```ts
            syncHeldSubscriptions(activeExpandTargets())
```

Change `doStopSubscription` to take a flag and release only on a real stop:

```ts
    const doStopSubscription = async (releaseTargets = true) => {
        if (!isSubscribed || !unsubscribeFn) return
        if (releaseTargets) syncHeldSubscriptions(new Set())
        // ... existing body unchanged ...
    }
```

In `doRestartSubscription`, call `await doStopSubscription(false)` so a restart keeps held targets and the following start only adds. The `stopSubscription` wrapper stays `() => enqueueSubscriptionWork(() => doStopSubscription())`.

Expose the counter in the `Object.assign` block:

```ts
        heldRelationTargetCount: () => heldTargetSubscriptions.size,
```

- [ ] **Step 5: Add the `@internal` member to `PbView` in `src/collection.ts`**

```ts
    /** @internal number of relation targets currently held live */
    readonly heldRelationTargetCount: () => number
```

- [ ] **Step 6: Run the tests**

Run: `TEST="test/expand-views.test.tsx test/subscriptions.test.ts test/subscribe-options.test.ts" npm run test`

Expected: PASS. If the target's `isSubscribed()` never flips, confirm `subscribeChanges` is called on the real target object (the `relations` value is the collection the user passed, which owns the `subscribers:change` handler), and that `syncHeldSubscriptions` runs after `isSubscribed = true`.

- [ ] **Step 7: Checks, full suite, commit**

```bash
npm run lint:fix && npm run checks && npm test
git add src/types.ts src/build-collection.ts src/collection.ts test/expand-views.test.tsx
git commit -m "feat: hold relation target subscriptions while a query expands into them"
```

---

### Task 3: Dependents, `applyRelatedChange`, and the echo trigger

**Files:**
- Modify: `src/types.ts` (`RelationDependent`, `ExpandTargetCollection`)
- Modify: `src/build-collection.ts`
- Modify: `src/collection.ts` (`PbView`)
- Modify: `test/expand-helpers.test.ts` (cyclic propagation unit test)
- Modify: `test/expand-views.test.tsx` (extend the block)

**Interfaces:**
- Produces in `src/types.ts`: `export interface RelationDependent { field: string; parent: ExpandTargetCollection }`; `ExpandTargetCollection` gains `relationDependents?: RelationDependent[]`, `applyRelatedChange?: (field: string, action: RelatedAction, record: { id: string }, visited: Set<string>) => void`, and `collectionName?: string`.
- Produces in `src/build-collection.ts`: `function applyRelatedChange(field, action, record, visited): void` and `function notifyDependents(action, record, visited): void`; the instance exposes `relationDependents` and `applyRelatedChange`.
- Produces in `src/expand-patch.ts`: `export function propagateRelatedChange(source: ExpandTargetCollection, action: RelatedAction, record: { id: string }, visited: Set<string>): void`, the pure fan-out used by both the trigger and the unit test.
- Consumes: `patchEmbedded` (Task 1), `writeOwn`, `collection._state.syncedData`, `collection.isReady()`.

- [ ] **Step 1: Write the failing unit test for propagation and cycles**

Append to `test/expand-helpers.test.ts` (import `propagateRelatedChange` from `../src/expand-patch` and `type ExpandTargetCollection, type RelationDependent` from `../src/types`):

```ts
describe('propagateRelatedChange', () => {
    function fakeCollection(name: string) {
        const calls: Array<{ field: string; id: string }> = []
        const target: ExpandTargetCollection & { calls: typeof calls } = {
            calls,
            collectionName: name,
            isReady: () => true,
            _sync: { startSync: async () => undefined },
            relationDependents: [],
            applyRelatedChange: (field, action, record, visited) => {
                const key = `${name}:${record.id}`
                if (visited.has(key)) return
                visited.add(key)
                calls.push({ field, id: record.id })
                // a patched row of this collection fans out to its own dependents
                propagateRelatedChange(target, action, { id: `${name}-row` }, visited)
            },
        }
        return target
    }

    it('fans out to every dependent once and terminates on a cycle', () => {
        const a = fakeCollection('a')
        const b = fakeCollection('b')
        const deps = (parent: ExpandTargetCollection, field: string): RelationDependent => ({
            field,
            parent,
        })
        a.relationDependents = [deps(b, 'a')]
        b.relationDependents = [deps(a, 'b')]

        propagateRelatedChange(a, 'update', { id: 'x' }, new Set())

        // x -> b patches (b:x) -> b-row -> a patches (a:b-row) -> a-row -> b
        // patches (b:a-row) -> b-row -> a: (a:b-row) already visited, stop.
        // Returning at all proves termination; the lists prove each
        // (collection, row) pair was patched exactly once.
        expect(b.calls).toEqual([
            { field: 'a', id: 'x' },
            { field: 'a', id: 'a-row' },
        ])
        expect(a.calls).toEqual([{ field: 'b', id: 'b-row' }])
    })

    it('never calls back into the source for the originating record', () => {
        const a = fakeCollection('a')
        const b = fakeCollection('b')
        a.relationDependents = [{ field: 'a', parent: b }]
        b.relationDependents = []
        propagateRelatedChange(a, 'delete', { id: 'x' }, new Set())
        expect(a.calls).toEqual([])
        expect(b.calls).toEqual([{ field: 'a', id: 'x' }])
    })

    it('logs and continues when one dependent throws', () => {
        const a = fakeCollection('a')
        const bad: ExpandTargetCollection = {
            collectionName: 'bad',
            isReady: () => true,
            _sync: { startSync: async () => undefined },
            applyRelatedChange: () => {
                throw new Error('boom')
            },
        }
        const b = fakeCollection('b')
        a.relationDependents = [
            { field: 'a', parent: bad },
            { field: 'a', parent: b },
        ]
        expect(() => propagateRelatedChange(a, 'update', { id: 'x' }, new Set())).not.toThrow()
        expect(b.calls).toEqual([{ field: 'a', id: 'x' }])
    })
})
```

- [ ] **Step 2: Write the failing integration tests**

Append inside the `relation targets stay live` block in `test/expand-views.test.tsx`:

```tsx
        function patchBatchesFor(
            spy: { mock: { calls: unknown[][] } },
            id: string
        ): unknown[][] {
            return spy.mock.calls.filter(call =>
                (call[0] as Array<{ id: string }>).some(row => row.id === id)
            )
        }

        async function createAuthor() {
            const record = await pb.collection('authors').create({
                name: `Live ${getTestSlug('au')}`,
                email: `${getTestSlug('live')}@example.com`,
            })
            return record.id as string
        }

        async function createBook(authorId: string) {
            const record = await pb.collection('books').create({
                title: `Live ${getTestSlug('bk')}`,
                isbn: getTestSlug('isbn'),
                genre: 'Fiction',
                author: authorId,
                published_date: '',
                page_count: 1,
            })
            return record.id as string
        }

        it('patches the embedded author when the author changes, with no book write', async () => {
            const authorId = await createAuthor()
            const bookId = await createBook(authorId)
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            try {
                const { result } = renderHook(() =>
                    useLiveQuery(q =>
                        q.from({ b: books.expand('author') }).where(({ b }) => eq(b.id, bookId))
                    )
                )
                await waitForLoadFinish(result, 10000)
                await books.waitForSubscription(10000)
                await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 10000 })
                await authors.waitForSubscription(10000)

                const before = result.current.data[0]
                await pb.collection('authors').update(authorId, { name: 'Renamed Author' })
                await waitFor(
                    () => expect(result.current.data[0]?.expand?.author?.name).toBe('Renamed Author'),
                    { timeout: 10000 }
                )
                expect(result.current.data[0]?.updated).toBe(before.updated)
            } finally {
                await pb.collection('books').delete(bookId)
                await pb.collection('authors').delete(authorId)
            }
        }, 20000)

        it('patches a nested copy two hops away', async () => {
            const authorId = await createAuthor()
            const bookId = await createBook(authorId)
            const metadataId = (
                await pb.collection('book_metadata').create({
                    book: bookId,
                    genre: 'Fiction',
                    language: 'en',
                    summary: '',
                    rating: 3,
                })
            ).id as string
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            const metadata = c('book_metadata', {
                syncMode: 'on-demand',
                relations: { book: books },
            })
            try {
                const { result } = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ m: metadata.expand('book.author') })
                            .where(({ m }) => eq(m.id, metadataId))
                    )
                )
                await waitForLoadFinish(result, 10000)
                await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 10000 })
                await authors.waitForSubscription(10000)

                await pb.collection('authors').update(authorId, { name: 'Nested Rename' })
                await waitFor(
                    () =>
                        expect(result.current.data[0]?.expand?.book?.expand?.author?.name).toBe(
                            'Nested Rename'
                        ),
                    { timeout: 10000 }
                )
            } finally {
                await pb.collection('book_metadata').delete(metadataId)
                await pb.collection('books').delete(bookId)
                await pb.collection('authors').delete(authorId)
            }
        }, 20000)

        it('leaves a row that never embedded the relation untouched, and writes exactly once per echo', async () => {
            const authorId = await createAuthor()
            const embeddedBookId = await createBook(authorId)
            const plainBookId = await createBook(authorId)
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            try {
                const expanded = renderHook(() =>
                    useLiveQuery(q =>
                        q
                            .from({ b: books.expand('author') })
                            .where(({ b }) => eq(b.id, embeddedBookId))
                    )
                )
                const plain = renderHook(() =>
                    useLiveQuery(q =>
                        q.from({ b: books }).where(({ b }) => eq(b.id, plainBookId))
                    )
                )
                await waitForLoadFinish(expanded.result, 10000)
                await waitForLoadFinish(plain.result, 10000)
                await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 10000 })
                await authors.waitForSubscription(10000)

                const booksWrites = vi.spyOn(books.utils, 'writeUpsert')
                const authorsWrites = vi.spyOn(authors.utils, 'writeUpsert')
                let notifications = 0
                const subscription = books.subscribeChanges(() => {
                    notifications++
                })
                try {
                    await pb.collection('authors').update(authorId, { name: 'Once' })
                    await waitFor(
                        () =>
                            expect(expanded.result.current.data[0]?.expand?.author?.name).toBe('Once'),
                        { timeout: 10000 }
                    )
                    const store = (
                        books as unknown as {
                            _state: { syncedData: Map<string, { expand?: unknown }> }
                        }
                    )._state.syncedData
                    expect(store.get(plainBookId)?.expand).toBeUndefined()

                    // exactly one patch batch containing only the embedded row
                    const patchBatches = patchBatchesFor(booksWrites, embeddedBookId)
                    expect(patchBatches).toHaveLength(1)
                    expect((patchBatches[0][0] as Array<{ id: string }>).map(r => r.id)).toEqual([
                        embeddedBookId,
                    ])
                    expect(authorsWrites).toHaveBeenCalledTimes(1)
                    expect(notifications).toBe(1)

                    // Quiet after settle, proven by ordering rather than a
                    // sleep: a second echo must be the very next write. Any
                    // loop spinning after the first patch would have pushed
                    // these counts past 2 before the second name lands.
                    await pb.collection('authors').update(authorId, { name: 'Once again' })
                    await waitFor(
                        () =>
                            expect(expanded.result.current.data[0]?.expand?.author?.name).toBe(
                                'Once again'
                            ),
                        { timeout: 10000 }
                    )
                    expect(patchBatchesFor(booksWrites, embeddedBookId)).toHaveLength(2)
                    expect(authorsWrites).toHaveBeenCalledTimes(2)
                    expect(notifications).toBe(2)
                } finally {
                    subscription.unsubscribe()
                }
            } finally {
                await pb.collection('books').delete(embeddedBookId)
                await pb.collection('books').delete(plainBookId)
                await pb.collection('authors').delete(authorId)
            }
        }, 30000)

        it('a redelivered echo produces no second write', async () => {
            const authorId = await createAuthor()
            const bookId = await createBook(authorId)
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            try {
                const { result } = renderHook(() =>
                    useLiveQuery(q =>
                        q.from({ b: books.expand('author') }).where(({ b }) => eq(b.id, bookId))
                    )
                )
                await waitForLoadFinish(result, 10000)
                await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 10000 })

                const record = await pb.collection('authors').getOne(authorId)
                const booksWrites = vi.spyOn(books.utils, 'writeUpsert')
                const apply = (
                    books as unknown as {
                        applyRelatedChange: (
                            field: string,
                            action: 'update',
                            record: { id: string },
                            visited: Set<string>
                        ) => void
                    }
                ).applyRelatedChange
                apply('author', 'update', { ...record, name: 'Twice' }, new Set())
                apply('author', 'update', { ...record, name: 'Twice' }, new Set())
                expect(booksWrites).toHaveBeenCalledTimes(1)
                await waitFor(() =>
                    expect(result.current.data[0]?.expand?.author?.name).toBe('Twice')
                )
            } finally {
                await pb.collection('books').delete(bookId)
                await pb.collection('authors').delete(authorId)
            }
        }, 20000)

        it('deleting an unreferenced author produces no parent writes', async () => {
            const authorId = await createAuthor()
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            const { result } = renderHook(() =>
                useLiveQuery(q =>
                    q
                        .from({ b: books.expand('author') })
                        .orderBy(({ b }) => b.id)
                        .limit(2)
                )
            )
            await waitForLoadFinish(result, 10000)
            await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 10000 })
            await authors.waitForSubscription(10000)

            const booksWrites = vi.spyOn(books.utils, 'writeUpsert')
            const authorsDeletes = vi.spyOn(authors.utils, 'writeDelete')
            await pb.collection('authors').delete(authorId)
            await waitFor(() => expect(authorsDeletes).toHaveBeenCalled(), { timeout: 10000 })
            expect(booksWrites).not.toHaveBeenCalled()
        }, 20000)

        it('keeps a pending optimistic update while the author is patched', async () => {
            const authorId = await createAuthor()
            const bookId = await createBook(authorId)
            let releaseUpdate: () => void = () => {}
            const updateGate = new Promise<void>(resolve => {
                releaseUpdate = resolve
            })
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', {
                syncMode: 'on-demand',
                relations: { author: authors },
                onUpdate: async ({ transaction }) => {
                    await updateGate
                    await Promise.all(
                        transaction.mutations.map(mutation => {
                            const original = mutation.original as { id: string }
                            return pb.collection('books').update(original.id, mutation.changes)
                        })
                    )
                    return { refetch: false }
                },
            })
            try {
                const { result } = renderHook(() =>
                    useLiveQuery(q =>
                        q.from({ b: books.expand('author') }).where(({ b }) => eq(b.id, bookId))
                    )
                )
                await waitForLoadFinish(result, 10000)
                await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 10000 })
                await authors.waitForSubscription(10000)

                const tx = books.update(bookId, draft => {
                    draft.title = 'Optimistic'
                })
                await waitFor(() => expect(result.current.data[0]?.title).toBe('Optimistic'))

                await pb.collection('authors').update(authorId, { name: 'While Pending' })
                await waitFor(
                    () =>
                        expect(result.current.data[0]?.expand?.author?.name).toBe('While Pending'),
                    { timeout: 10000 }
                )
                expect(result.current.data[0]?.title).toBe('Optimistic')

                releaseUpdate()
                await tx.isPersisted.promise
                await waitFor(() => expect(result.current.data[0]?.title).toBe('Optimistic'))
                expect(result.current.data[0]?.expand?.author?.name).toBe('While Pending')
            } finally {
                releaseUpdate()
                await pb.collection('books').delete(bookId)
                await pb.collection('authors').delete(authorId)
            }
        }, 30000)

        it('runs the target handler once per event while dependents are patched', async () => {
            const authorId = await createAuthor()
            const bookId = await createBook(authorId)
            const c = createCollection<Schema>(pb, queryClient)
            const authors = c('authors', { syncMode: 'on-demand' })
            const books = c('books', { syncMode: 'on-demand', relations: { author: authors } })
            try {
                const { result } = renderHook(() =>
                    useLiveQuery(q =>
                        q.from({ b: books.expand('author') }).where(({ b }) => eq(b.id, bookId))
                    )
                )
                await waitForLoadFinish(result, 10000)
                await waitFor(() => expect(authors.isSubscribed()).toBe(true), { timeout: 10000 })
                await authors.waitForSubscription(10000)

                const authorsWrites = vi.spyOn(authors.utils, 'writeUpsert')
                await pb.collection('authors').update(authorId, { name: 'Handler Once' })
                await waitFor(
                    () =>
                        expect(result.current.data[0]?.expand?.author?.name).toBe('Handler Once'),
                    { timeout: 10000 }
                )
                expect(authorsWrites).toHaveBeenCalledTimes(1)
            } finally {
                await pb.collection('books').delete(bookId)
                await pb.collection('authors').delete(authorId)
            }
        }, 20000)
```

The `authors` fixture requires `name` and `email`; check `test/schema.ts` `Authors` for any other required field and add it to `createAuthor`. If `books.utils` is typed without `writeUpsert` on the public type, spy through `(books as unknown as { utils: { writeUpsert: (rows: object[]) => void } }).utils`.

- [ ] **Step 3: Run to verify they fail**

Run: `TEST="test/expand-helpers.test.ts test/expand-views.test.tsx" npm run test`

Expected: FAIL. `propagateRelatedChange` not exported; the integration tests time out waiting for the patched name.

- [ ] **Step 4: Types**

In `src/types.ts` add, next to `ExpandTargetCollection`:

```ts
import type { RelatedAction } from './expand-patch'

/** A collection that embeds this one under `field` and must be patched on echoes. */
export interface RelationDependent {
    field: string
    parent: ExpandTargetCollection
}
```

and extend `ExpandTargetCollection` with:

```ts
    collectionName?: string
    /** Collections that declared this one in their `relations`. */
    relationDependents?: RelationDependent[]
    /** Patch this collection's rows for a change in the relation target under `field`. */
    applyRelatedChange?: (
        field: string,
        action: RelatedAction,
        record: { id: string },
        visited: Set<string>
    ) => void
```

`src/expand-patch.ts` must not import from `./types` at runtime to avoid a cycle; the type-only import above is fine.

- [ ] **Step 5: `propagateRelatedChange` in `src/expand-patch.ts`**

Append:

```ts
import type { ExpandTargetCollection } from './types'
import { logger } from './logger'

/**
 * Fan a relation target's change out to every collection that embeds it.
 * Each dependent patches its own rows and recurses with the same `visited`
 * set, so a cyclic relation graph terminates and a row is patched at most
 * once per originating echo.
 */
export function propagateRelatedChange(
    source: ExpandTargetCollection,
    action: RelatedAction,
    record: Embedded,
    visited: Set<string>
): void {
    for (const { field, parent } of source.relationDependents ?? []) {
        try {
            parent.applyRelatedChange?.(field, action, record, visited)
        } catch (error) {
            logger.error('Failed to patch a relation dependent', {
                collectionName: source.collectionName,
                dependent: parent.collectionName,
                field,
                error,
            })
        }
    }
}
```

(Move the imports to the top of the file; keep `Embedded` as defined in Task 1.)

- [ ] **Step 6: Register dependents and implement `applyRelatedChange` in `src/build-collection.ts`**

After `const relationTargets = ...` at the top of `buildCollection`, nothing yet: registration needs `collection`, so place it right after `const collection = createTanStackCollection(collectionOptions)`:

```ts
    const relationDependents: RelationDependent[] = []
    for (const [field, target] of Object.entries(relationTargets ?? {})) {
        target.relationDependents ??= []
        target.relationDependents.push({ field, parent: collection as unknown as ExpandTargetCollection })
    }
```

`collection` will expose `applyRelatedChange`, `relationDependents`, and `collectionName` through the `Object.assign` at the bottom, so the cast is honest at runtime. Then add, near `writeExpandedRows`:

```ts
    // Patch this collection's rows for a change in a relation target. Runs
    // synchronously from the target's realtime handler; writes go through the
    // authoritative path because the rows are the current synced rows with only
    // `expand` (or, on delete, the reference) changed.
    function applyRelatedChange(
        field: string,
        action: RelatedAction,
        record: { id: string },
        visited: Set<string>
    ): void {
        if (!collection.utils || !collection.isReady()) return
        const patched: RecordType[] = []
        for (const row of collection._state.syncedData.values()) {
            const id = (row as { id?: unknown }).id
            if (typeof id !== 'string') continue
            const key = `${collectionName}:${id}`
            if (visited.has(key)) continue
            const next = patchEmbedded(row as RecordType, field, action, record)
            if (!next) continue
            visited.add(key)
            patched.push(next)
        }
        if (patched.length === 0) return
        writeOwn(() => collection.utils.writeUpsert(patched))
        for (const row of patched) {
            propagateRelatedChange(
                collection as unknown as ExpandTargetCollection,
                'update',
                row as { id: string },
                visited
            )
        }
    }
```

Import `patchEmbedded`, `propagateRelatedChange`, and `type RelatedAction` from `./expand-patch`, and `type RelationDependent` from `./types`.

- [ ] **Step 7: Trigger from the realtime handler**

At the end of `handleRealtimeEvent`, after the existing `if (event.action !== 'delete') { upsertExpanded(...) }` block, add:

```ts
        propagateRelatedChange(
            collection as unknown as ExpandTargetCollection,
            event.action,
            event.record as { id: string },
            new Set()
        )
```

This runs for delete echoes too, including the swallowed already-removed case, because embedded copies may still exist. It must not run when the handler rethrew (it is after the `try`/`catch`, which only swallows the delete-not-found case, so that holds).

- [ ] **Step 8: Expose the internals**

In the `Object.assign` block add `relationDependents` and `applyRelatedChange`. In `src/collection.ts` `PbView` add:

```ts
    /** @internal collections that declared this one in their `relations` */
    readonly relationDependents: readonly { field: string; parent: unknown }[]
    /** @internal patch rows for a relation target change; used by the target's realtime handler */
    readonly applyRelatedChange: (
        field: string,
        action: 'create' | 'update' | 'delete',
        record: { id: string },
        visited: Set<string>
    ) => void
```

- [ ] **Step 9: Run the tests**

Run: `TEST="test/expand-helpers.test.ts test/expand-views.test.tsx test/subscriptions.test.ts" npm run test`

Expected: PASS. If the nested test fails, check that the `books` echo path also runs `propagateRelatedChange` (a patched books row is propagated by `applyRelatedChange` itself, not by a books echo). If the "writes exactly once" test counts two books writes, check that `writeExpandedRows` is not firing (it only runs for fetches, not echoes) and that `upsertExpanded` on the authors echo is not writing into books (it writes into authors' own targets, which have none).

- [ ] **Step 10: Checks, full suite, commit**

```bash
npm run lint:fix && npm run checks && npm test
git add src/types.ts src/expand-patch.ts src/build-collection.ts src/collection.ts test/expand-helpers.test.ts test/expand-views.test.tsx
git commit -m "feat: patch embedded expand copies from relation target echoes"
```

---

### Task 4: Docs

**Files:**
- Modify: `README.md` ("Per-query expand" subsection)
- Modify: `CHANGELOG.md` (`[0.8.0]` block)
- Modify: `docs/superpowers/specs/2026-09-11-per-query-expand-design.md` ("Realtime")
- Modify: `test/README.md`

- [ ] **Step 1: README**

At the end of the "Per-query expand" subsection (after the paragraph beginning "Rows fetched through a view keep their `expand` data"), add:

```markdown
Relation targets stay live too. While a query expands into `tags` (or through
it into `colors`), those collections keep their realtime subscriptions, and a
change to a tag or a color updates the embedded copy on affected rows in
place, so `book.expand?.tags?.[0].name` refreshes without a write to the book.
Deleting a related record clears the reference and the copy, matching what
PocketBase does server-side. Targets are released when the last query on the
parent unmounts.
```

- [ ] **Step 2: CHANGELOG**

Under `## [0.8.0]` → `### Added`, append:

```markdown
- Relation targets stay subscribed while a query expands into them, and
  their realtime changes patch the embedded `expand` copies on parent rows
  in place (nested paths included). Delete echoes clear the reference and
  the copy. Unchanged echoes never write.
```

- [ ] **Step 3: Spec pointer**

In `docs/superpowers/specs/2026-09-11-per-query-expand-design.md`, section "### Realtime", append one sentence:

```markdown
Relation targets are held live and their echoes patch embedded copies; see
`2026-09-11-relation-targets-live-design.md`.
```

- [ ] **Step 4: test/README**

Update the `expand-views.test.tsx` entry to mention "held target subscriptions and echo patching", and the `expand-helpers.test.ts` entry to mention `patchEmbedded` and propagation.

- [ ] **Step 5: Verify and commit**

```bash
npm run checks && npm test && npm run build
git add README.md CHANGELOG.md docs/superpowers/specs/2026-09-11-per-query-expand-design.md test/README.md
git commit -m "docs: relation targets stay live"
git push
```

Then update PR #12's description with one paragraph on this addition (`gh pr edit 12 --body-file` on the current body plus the paragraph).
