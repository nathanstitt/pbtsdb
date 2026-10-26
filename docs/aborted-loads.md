# Why an aborted load resolves instead of rejecting

Date: 2026-10-25. Applies to pbtsdb 2.0.x on `@tanstack/db` 0.12.1.

## Summary

`loadSubset` used to reject an aborted load with `LoadSubsetOperationAbortedError`
when the caller waited for visibility. It now resolves with no rows and installs
nothing. The reason is a defect in `@tanstack/db`: a live query can await a load
that it later aborts itself, and the rejection puts the live query into the error
state, from which it never recovers.

This document records the evidence, so a reader can check the reasoning, and
the upstream fix, in case a later version of `@tanstack/db` makes this change
unnecessary.

## The symptom in an application

A screen shows a live query over a parent collection with a `leftJoin` (or a
`materialize()` subquery) into a pbtsdb collection. The joined side is lazy:
`@tanstack/db` loads it in segments keyed by the parent rows it has seen
(`account in [ids]`). The screen sometimes ends in the error state with this
console message:

```
[Live Query Error] Subset demand 'lazy-demand-77' failed: Load subset operation was aborted before its result became visible
```

It is intermittent. It needs a segment load that is still in flight when the
parent keys change in a way that makes `@tanstack/db` replace its segments.

## The mechanism in `@tanstack/db`

File: `packages/db/src/query/live/subset-demand-controller.ts`, class
`SubsetDemandController`. The same code is on upstream `main` as of 2026-10-25.

1. `setDemand(subscription, plan, keys)` is called with the current key set of
   the lazy side. When keys were removed and either keys were added or more
   than one segment is live, it chooses `replace`: it starts one replacement
   segment `R` for the whole key set and records `R.replaces = [old segments]`.
   The old segments stay in `state.segments` so their coverage stays live
   while `R` loads.
2. It then returns `ready: Promise.all(pending)`, where `pending` is every
   segment in `state.segments` whose state is `pending`. That list includes the
   old segments `R` replaces.
3. `collection-subscriber.ts` `setDemand` awaits that `ready` for the current
   demand generation. A rejection calls `failDemand`, which calls
   `transitionToError`: the live query collection is marked `error`.
4. When `R` settles, `finishReplacement` releases every segment in `R.replaces`.
   `releaseSegment` calls `abortController.abort()` on each.
5. An old segment whose load is still in flight is now aborted. pbtsdb's
   `stopped()` threw `LoadSubsetOperationAbortedError` for it, as its contract
   said. That rejection reaches the `Promise.all` from step 2, which rejects,
   and step 3 puts the live query into the error state.

So the controller awaits a promise that it rejects itself. `@tanstack/db`'s own
`CollectionSubscription.recordLoadSubsetError` already states the intended
rule: "Aborted subset requests are obsolete demand, not load failures." The
demand controller does not follow it.

## Evidence

A vitest against `@tanstack/db` 0.12.1 alone, with no pbtsdb, reproduces the
error. It builds a local parent collection and an on-demand joined collection
whose `loadSubset` returns one promise per request and rejects it when its
`signal` aborts (what pbtsdb did). Steps:

1. Insert parents `a1`, `a2`. One segment `O1` for `[a1, a2]` starts.
2. In one commit delete `a2` and insert `a3`. The controller starts `R` for
   `[a1, a3]` with `R.replaces = [O1]`, and returns `Promise.all([O1, R])`.
3. Resolve `R` first. `finishReplacement` aborts `O1`. `O1` rejects.

Result on stock 0.12.1: the live query goes `ready -> error` and logs the
message above. The same test passes with either of these changes:

- `@tanstack/db`: exclude segments listed in any `segment.replaces` from
  `pending` in `setDemand` (two lines).
- the adapter: resolve an aborted load instead of rejecting it.

pbtsdb's own regression test is `test/lazy-join-abort.test.ts`. It runs the
same sequence through a real pbtsdb collection over a fake PocketBase whose
responses are released by hand.

## Why the change is safe

- `@tanstack/db` discards the result of an aborted load at the subscription
  level: `CollectionSubscription` checks `signal.aborted` before it applies a
  result (`subscription.ts`, `isCurrent()` and the `signal?.aborted` guards).
  A quiet resolve installs nothing extra.
- pbtsdb installs nothing for an aborted load, as before: `install` runs
  `membership.confirm` only when the load is not stopped, and `load` undoes the
  filings of an aborted result.
- The only `@tanstack/db` caller that reads a rejection is the imperative window
  move (`collection-config-builder.ts` `setWindow`, through
  `beginLoadSubsetOperation`). An aborted window move is one that a newer move
  superseded; the newer move settles its own operation. No tinycld package
  calls `setWindow` or `fetchMore` today.

## What this does not cover

`@tanstack/db` also rejects an aborted demand itself, with the same error, when
the demand started while the collection had no loader yet (a "detached"
demand, `subscription.ts` `startSubsetDemand`). pbtsdb is not involved in that
rejection and cannot prevent it. The window is the moment between a live
query's start and the first `loadSubset` of its source. It did not appear in
the instrumentation that found this defect.

## The upstream fix, if wanted later

In `subset-demand-controller.ts`, `setDemand`, before the `pending` list:

```ts
const replaced = new Set(state.segments.flatMap((segment) => segment.replaces ?? []))
const pending = state.segments
  .filter(
    (segment) =>
      segment.state === `pending` &&
      !replaced.has(segment) &&
      intersects(segment.keys, nextKeys),
  )
  .map((segment) => segment.ready)
  .filter((ready): ready is Promise<void> => ready instanceof Promise)
```

Readiness then waits only on segments that will stay live. Related upstream
work: TanStack/db PR #2231 changes how a demand failure during a truncate
replay is handled, but it keeps `pending` as it is.

## Files changed in pbtsdb

- `src/sync-adapter.ts`: `stopped()` is gone; `isStopped()` decides what an
  aborted load confirms, and `load` resolves `[]` for an aborted result.
- `test/sync-adapter.test.ts`: the nine abort assertions now expect a resolve.
- `test/lazy-join-abort.test.ts`: the regression test.
- `docs/internals.md`: the `loadSubset` paragraph.
- `CHANGELOG.md`: the Unreleased entry.
