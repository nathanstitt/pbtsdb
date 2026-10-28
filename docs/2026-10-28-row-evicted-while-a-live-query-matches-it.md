# A row is evicted while a mounted live query matches it

Date: 2026-10-28. pbtsdb 2.0.5. Found by the tinycld mail e2e suite.

## Summary

A component reads a row through a mounted live query, as the ownership rule
requires. The row is still removed from the store when a different query that
also held it expires. The component then stops showing the row, and no request
loads it again.

User impact in tinycld mail: an owner creates a shared inbox in settings,
then leaves settings. About 5 seconds later the new inbox disappears from the
sidebar. A reload shows it again.

## The component follows the rule

The sidebar reads the person's mailboxes with one live query. The query
filters `mail_mailbox_members` by the person's own user id, and reads each
mailbox with `materialize()`
(`tinycld/mail/tinycld/mail/hooks/useMailboxes.ts`):

```ts
useMyLiveQuery((query, { userId }) =>
    query
        .from({ member: membersCollection })
        .where(({ member }) => eq(member.user, userId))
        .select(({ member }) => ({
            id: member.id,
            mailbox: materialize(
                query.from({ mailbox: mailboxesCollection })
                    .where(({ mailbox }) => eq(mailbox.id, member.mailbox))
                    .findOne()
            ),
        })),
    { queryKey: ['mail_mailboxes'] }
)
```

This query stays mounted for the whole test. The new membership row matches
its `where` (`user = me`).

## What the trace shows

Source: the Playwright trace of
`mail/tests/mail-inbox.spec.ts:51` ("a thread delivered while viewing Archive
bumps the Inbox badge"), run 2026-10-28 21:22 UTC. All times are seconds past
21:22.

| Time | Event |
|---|---|
| 38.197 | The last GET of `mail_mailbox_members` for the sidebar query. There is no later GET for it. |
| 39.38 | The test clicks "New shared inbox" on the settings screen. |
| 40.121 | POST creates the new `mail_mailbox_members` row (and its mailbox). The settings screen's queries hold it: an unfiltered members query, and a mailbox query scoped to the domain. |
| 43.11 | Screencast frame: the new inbox section is in the sidebar. |
| 44.265–44.436 | The settings screen's queries leave the realtime subscription set. This is about 5s after the settings screen unmounted, which is `subsetGcTime` (default 5000, `build-collection.ts:208`). |
| 44.316 | The sidebar query sends a new realtime subscription, but no GET. |
| 44.48 | Screencast frame: the new inbox section is gone from the sidebar. |
| 49.545 | The subscription for the 5 mailbox ids expires too. |

The test passes when it runs alone: the inbound delivery returns quickly, so
the test reads the badge before 44.4. In the full suite the inbound POST took
3.04s, so the assertion ran after the eviction.

Trace extracts (local to this machine):
`/private/tmp/claude-501/-Users-nas-code-tinycld/c08bb2d6-8ce4-4359-aec3-a29aea4f4310/scratchpad/trace-analysis/t2/`
and `rt2.tsv` (the realtime subscription POSTs with times).

## Cause

Confirmed by a test (`test/topic-release-rehome.test.ts`). The analysis
in the first version of this report was not correct: `expire()` did not
remove the row, because the expired demand never held it.

1. The settings screen mounts an unfiltered members query. Its realtime
   filters are `undefined`, so it wants the `'*'` entry. While `'*'` is
   open, every filter entry is closed (`realtime-subscription.ts`,
   `doReconcile`). The sidebar's `user = me` entry is closed too.
2. The create event for the new member row comes only on `'*'`. The row
   lands with the `'*'` topic as its holder. The `ACCEPTED` holder of the
   write-back is dropped when the event lands, or the row never gets it.
   No other holder links the row to the sidebar demand.
3. About 5s after the settings screen unmounts, its demand expires. No
   query wants `'*'` now, so `doReconcile` opens the `user = me` entry
   again (the subscription POST at 44.316) and closes `'*'`.
4. `releaseClosedTopics` calls `releaseTopic('*')`, which drops the
   `'*'` holder. The row has no holder left, so it leaves the store
   (44.48). The reopened filter entry sends no fetch, so the row does not
   come back.

This answers the open question in the first version: the event did not
come on the sidebar's filter, because that entry was closed.

## Fix

`releaseTopic` (`build-collection.ts`) gives each row of the topic to every
live, landed demand whose `where` matches it, and then drops the topic. The
step is `rehome()`. `settleAccepted` uses the same step for write-backs.

- The fix sends no request. The row does not leave the store and come back.
- The rows under a topic came from the server's realtime feed, so no row
  that the server does not have can enter a demand this way.
- After the hand-off, the reopened filter entry delivers updates and
  deletes for the row. A delete on that topic drops the demand's holder
  through `adapter.subsetsFor(topic)`.
- A row that matches no live demand still leaves with the topic.

Limit: `holdersFor` skips parked demands, as before. A parked demand that
matches the row does not get it. If a query later adopts that parked
demand, it does not fetch, so the row is missing until the next load.
`settleAccepted` has the same limit.

## Test

`test/topic-release-rehome.test.ts`, with `realtime: 'query'` and
`subsetGcTime: 300`:

1. Mount query A: `from(books).where(isbn = X)`. Let it land.
2. Mount query B: `from(books)` (no `where`). Let it land.
3. On the server, create one book with `isbn = X` and one with a different
   isbn.
4. Unmount B. Wait until the second book leaves the store.
5. Expected: A still returns the first book.

The test fails without the fix and passes with it.
