# pbtsdb: PocketBase TanStack Database Integration

> Type-safe PocketBase integration with TanStack DB

A TypeScript library that seamlessly integrates [PocketBase](https://pocketbase.io) with [TanStack DB](https://tanstack.com/db), providing:

- 🔥 **Real-time subscriptions** with automatic synchronization
- 🎯 **Full TypeScript type safety** for queries and relations
- ⚡ **Reactive collections** with TanStack DB
- ✨ **Optimistic mutations** with insert/update/delete support
- 🎨 **React hooks** for easy component integration
- 🔗 **Type-safe joins** and relation fetching into their own collections

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
- [API Reference](#api-reference)
  - [createCollection()](#createcollection)
  - [Related data](#related-data)
  - [React Integration](#react-integration)
  - [Subscriptions](#subscriptions)
  - [Utility Functions](#utility-functions)
- [Usage Examples](#usage-examples)
  - [Includes (Nested Subqueries)](#includes-nested-subqueries)
- [TypeScript](#typescript)
- [Best Practices](#best-practices)
- [Configuration](#configuration)

## Installation

```bash
npm install pbtsdb pocketbase @tanstack/db @tanstack/react-db
```

### Peer Dependencies

- `pocketbase` >= 0.22.0
- `@tanstack/db` >= 0.12.1
- `@tanstack/react-db` >= 0.5.5 (optional; only for `createReactProvider`)
- `react` and `react-dom` >= 18.0.0 (optional)

All peer dependencies use minimum version constraints; newer versions should work. The
non-React entry point `pbtsdb/core` needs neither `react` nor `@tanstack/react-db`.

## Quick Start

Let's build a **real-world blog** with posts, authors, and comments using pbtsdb.

### 1. Define Your Schema

First, generate your types from PocketBase. Install [pocketbase-schema-generator](https://github.com/satohshi/pocketbase-schema-generator) as a PocketBase hook to auto-generate types on schema changes.

```typescript
// schema.ts - Auto-generated from PocketBase
interface Post {
    id: string;
    title: string;
    content: string;
    author: string;      // FK to users
    published: boolean;
    created: string;
    updated: string;
}

interface User {
    id: string;
    username: string;
    email: string;
    avatar?: string;
    created: string;
    updated: string;
}

interface Comment {
    id: string;
    post: string;        // FK to posts
    author: string;      // FK to users
    text: string;
    created: string;
    updated: string;
}

// Schema declaration for pbtsdb
type BlogSchema = {
    posts: {
        type: Post;
        relations: { author?: User };
    };
    users: {
        type: User;
        relations: {};
    };
    comments: {
        type: Comment;
        relations: {
            post?: Post;
            author?: User;
        };
    };
}
```

### 2. Set Up Your App

```typescript
// app.tsx
import PocketBase from 'pocketbase';
import { createCollection, createReactProvider } from 'pbtsdb';

const pb = new PocketBase('http://localhost:8090');

// Create collections with automatic type inference
const c = createCollection<BlogSchema>(pb);
const users = c('users', {});
export const { Provider, useStore } = createReactProvider({
    users,
    posts: c('posts', {
        omitOnInsert: ['created', 'updated'] as const,
        relations: { author: users },
        alwaysFetchRelations: ['author'],
    }),
    comments: c('comments', {
        omitOnInsert: ['created', 'updated'] as const,
        relations: { author: users },
        alwaysFetchRelations: ['author'],
    }),
});

export function App() {
    return (
        <Provider>
            <BlogDashboard />
        </Provider>
    );
}
```

### 3. Build Your Components

```typescript
// BlogDashboard.tsx
import { useLiveQuery } from '@tanstack/react-db';
import { eq } from '@tanstack/db';
import { materialize } from 'pbtsdb';
import { useStore } from './app';

export function BlogDashboard() {
    const [posts, users] = useStore('posts', 'users');

    const { data: allPosts, isLoading } = useLiveQuery((q) =>
        q.from({ posts })
            .orderBy(({ posts }) => posts.created, 'desc')
            .select(({ posts }) => ({
                ...posts,
                author: materialize(
                    q.from({ u: users }).where(({ u }) => eq(u.id, posts.author)).findOne()
                ),
            }))
    );

    if (isLoading) return <div>Loading posts...</div>;

    return (
        <div>
            <h1>Blog Posts</h1>
            {allPosts?.map(post => (
                <article key={post.id}>
                    <h2>{post.title}</h2>
                    <p>{post.content}</p>
                    {/* Author was filed into the users collection by alwaysFetchRelations */}
                    <small>By {post.author?.username}</small>
                </article>
            ))}
        </div>
    );
}
```

### 4. Add Real-time Comments

```typescript
// PostWithComments.tsx
import { useLiveQuery } from '@tanstack/react-db';
import { eq } from '@tanstack/db';
import { useStore } from './app';
import { materialize, newRecordId } from 'pbtsdb';

export function PostWithComments({ postId }: { postId: string }) {
    const [comments, posts, users] = useStore('comments', 'posts', 'users');

    // Real-time comments for this post
    const { data: postComments } = useLiveQuery((q) =>
        q.from({ comments })
            .where(({ comments }) => eq(comments.post, postId))
            .orderBy(({ comments }) => comments.created, 'desc')
            .select(({ comments }) => ({
                ...comments,
                author: materialize(
                    q.from({ u: users }).where(({ u }) => eq(u.id, comments.author)).findOne()
                ),
            }))
    );

    const handleAddComment = (text: string, authorId: string) => {
        comments.insert({
            id: newRecordId(),
            post: postId,
            author: authorId,
            text
        });
        // Comment appears instantly (optimistic), syncs to PocketBase in background
    };

    return (
        <div>
            <h3>Comments ({postComments?.length || 0})</h3>
            {postComments?.map(comment => (
                <div key={comment.id}>
                    <strong>{comment.author?.username}:</strong>
                    <p>{comment.text}</p>
                </div>
            ))}
            <CommentForm onSubmit={handleAddComment} />
        </div>
    );
}
```

**That's it!** You now have a real-time blog with:
- ✅ Type-safe queries
- ✅ Automatic real-time updates
- ✅ Optimistic mutations
- ✅ Related data read from its own collection, no embedded copies

## Core Concepts

### Collections

Collections are reactive data stores that automatically sync with PocketBase:

```typescript
// Create a collection using the curried API
const c = createCollection<MySchema>(pb);
const booksCollection = c('books', {});

// Collections automatically:
// - Fetch data from PocketBase
// - Subscribe to real-time updates
// - Update React components when data changes
```

### Real-time Subscriptions

Collections manage subscriptions **automatically** based on query lifecycle:

```typescript
// Collections are lazy - no subscription until queried
const c = createCollection<MySchema>(pb);
const booksCollection = c('books', {});

// Subscription starts automatically when query becomes active
const { data } = useLiveQuery((q) =>
    q.from({ books: booksCollection })
);
// ✅ Subscribed to changes while component is mounted
// ✅ Unsubscribes automatically when component unmounts
```

**Subscription Lifecycle:**
- **Lazy:** No subscription starts until the first `useLiveQuery` using the collection renders
- **Automatic:** Subscription starts when first subscriber mounts, stops when last subscriber unmounts
- **Shared:** Multiple components using the same collection share one subscription
- **No manual control needed:** The collection handles all subscription management internally

### Reconnects

pbtsdb runs its own realtime connection. When the connection drops, it reconnects with backoff and refetches every live query, because PocketBase does not replay events missed during the gap. A server that supports pbtsdb's resume extension (`?resume=<clientId>&after=<seq>` on the SSE URL, `resumed: true` in `PB_CONNECT`, `seq` on each event) replays the gap instead, and no refetch runs.

Call `resetRealtime(pb)` after an auth change the connection cannot see on its own — login, logout, or switching users. pbtsdb's connection is independent of `pb.realtime`, so changing `pb`'s auth token does not by itself tell the server anything, and if the subscribed topics haven't changed, pbtsdb would otherwise send no POST at all and keep serving the previous user's data:

```typescript
import { resetRealtime } from 'pbtsdb';

await pb.collection('users').authWithPassword(email, password);
resetRealtime(pb); // re-subscribes every open topic under the new auth
```

This forgets the connection's server-side session and reconnects at once, re-sending every currently subscribed topic under whatever auth `pb` carries now; every ready collection refetches once that POST succeeds, the same as a non-resumed reconnect.

### Sync Modes

Every collection is either **eager** (the default) or **on-demand**:

```typescript
const authors = c('authors', {});                       // eager: one full fetch, then realtime
const books = c('books', { syncMode: 'on-demand' });    // on-demand: fetch what queries ask for
```

An eager collection loads all of its rows on first use and answers every query
from memory. An on-demand collection translates each live query's `where`,
`orderBy`, and `limit` into a PocketBase request, so only the rows a query asks
for enter the store, and different filters are cached under different keys.
Use on-demand for large collections; realtime keeps both modes current once rows
are loaded.

#### Paging

An on-demand query with `orderBy` and `limit` fetches one page of that size.
When TanStack DB needs more rows (`setWindow`, or a window past what is loaded)
it hands the sync layer a cursor on the sort field and the count of rows it
already has. pbtsdb conjoins the cursor to the fetch filter and fetches only the
delta; an offset without a cursor becomes a PocketBase page.

```typescript
const { data, collection } = useLiveQuery((q) =>
    q.from({ b: books }).where(({ b }) => eq(b.author, id)).orderBy(({ b }) => b.page_count).limit(20)
);
// fetches only the rows past what is loaded: one cursor request plus a boundary tie-check
collection.utils.setWindow({ offset: 20, limit: 20 });
```

Realtime stays on the base `where`: every page of one query shares one
subscription, and a new row that sorts into the window arrives on its own. A
query whose `where` holds its own boundary (`lt(b.page_count, cursor)`)
subscribes to that slice only, which is the shape for numbered pages: page one
has no boundary and receives every new row. A join's or include's key batch
keeps its own filter, so lazily loaded rows stay covered.

TanStack applies `offset` in memory after loading, so `.offset(n)` on the
builder still loads the first `n + limit` rows. Put a page boundary in the
`where` when a deep page must not load what comes before it.

### Mutations and Refetch

The built-in handlers write PocketBase's response into the collection before they return: server-assigned fields like `created` and `updated`, and any values rewritten by PocketBase hooks. A built-in delete removes the row the same way. TanStack DB drops a mutation's optimistic state when its handler settles, and rows written while the handler runs publish together with that drop, so the settled row is the server's row with no gap. The realtime echo that follows changes nothing.

By default, pbtsdb does **not** refetch after a successful insert, update, or delete. Set `refetchOnMutation: true` to refetch the collection's active queries before the handler settles — for example, when a server-side hook changes other rows you must read right after the mutation:

```typescript
const collection = c('books', {
    refetchOnMutation: true,
});
```

The option only affects the built-in default handlers. A custom `onInsert`, `onUpdate`, or `onDelete` controls write-back itself:

- TanStack DB drops the optimistic state when your handler returns. Until the realtime echo arrives, the row shows its previous server value: an updated row reverts, an inserted row disappears, and a deleted row comes back. To prevent that gap, `await collection.accept(serverRows)` before you return.
- The handler returns `void`. Core no longer reads a `{ refetch }` result; call `collection.reload()` yourself if the handler needs a refetch.

### Writing server rows yourself

`collection.accept(rows)` lands rows the server returned, for example the response of a custom endpoint, as confirmed state. A row older than the stored one is ignored. Use it when the screen must update before the realtime echo arrives. It resolves when the rows are accepted, so a custom mutation handler can await it.

`collection.reload()` refetches every live query's subset and drops every row the results do not confirm. Use it when the server state changed with no realtime event, such as after a user loses access to rows.

Both are also on `collection.utils`.

### Type Safety

Full TypeScript support with compile-time type checking:

```typescript
const { data } = useLiveQuery((q) =>
    q.from({ books: booksCollection })
);

// TypeScript knows:
// - data[0].title is a string
// - data[0].genre is 'Fiction' | 'Non-Fiction' | 'Science Fiction'
// - data[0].author is a string (FK)
```

## API Reference

### createCollection()

The main function for creating type-safe collections. Uses a curried API for better type inference.

```typescript
const c = createCollection<Schema>(
    pb: PocketBase,
    factoryOptions?: CreateCollectionFactoryOptions
);
const collection = c(collectionName: string, options?: CreateCollectionOptions);
```

**Parameters:**
- `pb` - PocketBase instance
- `factoryOptions` - Optional configuration applied to every collection this factory builds (see [Subscription Options](#subscription-options))
- `collectionName` - Name of the PocketBase collection
- `options` - Optional configuration

**Options:**
- `relations?: Record<string, Collection>` - Collections that receive expanded records for each relation; declares what `alwaysFetchRelations` and `collection.fetchRelations()` may name
- `alwaysFetchRelations?: readonly string[]` - Expand paths fetched with every request and filed into their `relations` targets; never kept on the row
- `omitOnInsert?: readonly string[]` - Fields to make optional during insert (e.g., `['created', 'updated'] as const`)
- `syncMode?: 'eager' | 'on-demand'` - Data fetching strategy (default: `'eager'`)
- `realtime?: 'collection' | 'query'` - Which rows the realtime subscription covers (default: `'collection'`; `'query'` requires `syncMode: 'on-demand'`; see [Realtime Scope](#realtime-scope))
- `onInsert?: InsertMutationFn | false` - Custom insert handler or `false` to disable
- `onUpdate?: UpdateMutationFn | false` - Custom update handler or `false` to disable
- `onDelete?: DeleteMutationFn | false` - Custom delete handler or `false` to disable
- `refetchOnMutation?: boolean` - Refetch the collection after a built-in insert/update/delete succeeds (default: `false`; see [Mutations and Refetch](#mutations-and-refetch))
- `collectionOptions?: object` - Additional TanStack DB collection options passed through directly (see [Collection Options Passthrough](#collection-options-passthrough))

**Returns:** Fully-typed Collection instance with subscription capabilities

**Examples:**

Basic collection (lazy, subscribes automatically on first query):
```typescript
const c = createCollection<MySchema>(pb);
const booksCollection = c('books', {});
```

#### Related data

PocketBase `expand` is used only to bring related records into their own
collections. Rows never carry `expand`; read related records from the target
collection.

```typescript
const c = createCollection<MySchema>(pb);
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
import { eq } from '@tanstack/db';
import { materialize } from 'pbtsdb';

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
served from the synced store when every id is present, except when the query
reads through a `fetchRelations()` view, whose fetch goes to PocketBase so its
paths get filed; anything else is fetched in one batched request. An empty
`inArray(id, [])` yields no rows and no request.

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

Back-relations work the same way and go one step further. PocketBase names them
`<collection>_via_<field>`; fetching one files every child that references the
parent, and pbtsdb records that the child subset for that parent is complete,
so a child query filtered by the foreign key is served from the store:

```typescript
const comments = c('comments', { syncMode: 'on-demand' });
const cards = c('cards', { syncMode: 'on-demand', relations: { comments_via_card: comments } });

const { data } = useLiveQuery((q) =>
    q.from({ card: cards.fetchRelations('comments_via_card') })
     .where(({ card }) => eq(card.id, cardId))
     .select(({ card }) => ({
         ...card,
         comments: materialize(q.from({ cm: comments }).where(({ cm }) => eq(cm.card, card.id))),
     }))
);
// one request; the comments include reads from the store
```

A subset stays marked while the child collection is subscribed (the parent holds
it live) and is forgotten when a child row is pruned from the store, when the
child's realtime subscription stops, or when the collection is cleaned up.
PocketBase caps a back-relation expand at 1000 records, and a capped expand is
never treated as complete.

#### Collection Options Passthrough

Pass any [TanStack DB `BaseCollectionConfig`](https://tanstack.com/db/latest/docs/overview) option directly via `collectionOptions`. This is useful for configuring indexing, garbage collection, and other collection-level settings:

```typescript
const c = createCollection<MySchema>(pb);
const booksCollection = c('books', {
    collectionOptions: {
        gcTime: 60000,       // 1 minute GC
        startSync: true,     // Start syncing immediately
    }
});
```

pbtsdb defaults `autoIndex` to `'eager'` with `defaultIndexType: BTreeIndex`, so
`orderBy` + `limit` queries page lazily instead of loading the whole subset (and
TanStack DB does not warn about a missing index). Pass `autoIndex: 'off'` or a
different `defaultIndexType` in `collectionOptions` to change that per collection.

The following fields are managed by pbtsdb and excluded from `collectionOptions`: `getKey`, `syncMode`, `onInsert`, `onUpdate`, `onDelete`, `schema`, `utils`.

### React Integration

#### createReactProvider()

Creates a React Provider and useStore hook from a collections map.

```typescript
const { Provider, useStore } = createReactProvider(collections: CollectionsMap);
```

**Parameters:**
- `collections` - Object mapping keys to Collection instances

**Returns:**
- `Provider` - React Context Provider component
- `useStore` - Hook to access collections (variadic args, returns typed tuple)

**Example:**
```typescript
import { createCollection, createReactProvider } from 'pbtsdb';

const c = createCollection<MySchema>(pb);
const collections = {
    authors: c('authors', {}),
    books: c('books', {
        omitOnInsert: ['created', 'updated'] as const
    }),
};

const { Provider, useStore } = createReactProvider(collections);

// Wrap your app
<Provider>
    <App />
</Provider>
```

**With custom collection key:**
```typescript
const collections = {
    myBooks: c('books', {})  // Key 'myBooks', PocketBase collection 'books'
};

const { Provider, useStore } = createReactProvider(collections);

// Access via custom key
const [myBooks] = useStore('myBooks');
```

#### useStore()

Access collections from the provider. Uses variadic arguments and returns a typed tuple.

**Single collection:**
```typescript
const [collection] = useStore('key')
```

**Multiple collections:**
```typescript
const [col1, col2, col3] = useStore('key1', 'key2', 'key3')
```

**Examples:**
```typescript
function BooksList() {
    const [books] = useStore('books');  // ✅ Typed automatically!

    const { data } = useLiveQuery((q) =>
        q.from({ books })
    );

    return <div>{/* ... */}</div>;
}

function BooksWithAuthors() {
    const [books, authors] = useStore('books', 'authors');  // ✅ Variadic!

    const { data } = useLiveQuery((q) =>
        q.from({ book: books })
            .join(
                { author: authors },
                ({ book, author }) => eq(book.author, author.id),
                'left'
            )
    );

    return <div>{/* ... */}</div>;
}
```

### Subscriptions

Collections manage real-time subscriptions to PocketBase **automatically**. No manual subscription management is needed for normal usage.

#### Automatic Subscription Lifecycle

```typescript
// Subscriptions start automatically when useLiveQuery renders
function MyComponent() {
    const [books] = useStore('books');
    const { data } = useLiveQuery((q) => q.from({ books }));
    // ✅ Subscription active while this component is mounted
    // ✅ Automatically stops when component unmounts
}
```

#### isSubscribed()

Check if a collection has an active subscription.

```typescript
const isSubbed = collection.isSubscribed(); // boolean
```

#### waitForSubscription()

Wait for subscription to be established (useful in tests).

```typescript
await collection.waitForSubscription(); // Wait with default 5s timeout
await collection.waitForSubscription(10000); // Wait with custom timeout (ms)
```

#### Realtime Scope

By default a collection subscribes to every row (`realtime: 'collection'`).
An on-demand collection can instead subscribe per active query, using the
same filter its fetch sends:

```typescript
const books = c('books', { syncMode: 'on-demand', realtime: 'query' });

// subscribes with filter genre = "Fantasy"
useLiveQuery((q) => q.from({ b: books }).where(({ b }) => eq(b.genre, 'Fantasy')));
```

One PocketBase subscription is opened per distinct filter string and closed
when the last query using it unmounts. A query with no `where` subscribes to
the whole collection. While any whole-collection subscription is open, the
filtered ones stay closed.

PocketBase caps a realtime subscription topic at 2500 characters. An id
subset is split into smaller chunks for realtime than for fetches, one
subscription per chunk. A filter whose topic is still too long (a long
non-subset `where`, or one combined with a factory `subscribeOptions` filter)
is not sent. The collection logs a warning and subscribes to every row while
that filter is in use.

A `'query'` collection held live as a relation target subscribes only to the
rows the parent filed into it: the expanded records' ids for a forward
relation (`author`), or `field = parentId` for a back-relation
(`books_via_author`), so new children still arrive. A `'collection'` target
subscribes to every row while held, as before.

Override the mode for one query with `withRealtime()`, which returns a view
and composes with `fetchRelations()` in either order:

```typescript
useLiveQuery((q) => q.from({ b: books.withRealtime('collection') }));
useLiveQuery((q) => q.from({ b: books.fetchRelations('author').withRealtime('query') }));
```

**Known limit.** PocketBase checks an update against the row's state after
the change. An update that moves a row out of every active filter sends no
event, so the row stays in the store until its query refetches. Deletes and
creates are delivered correctly. Use `'collection'` mode where that matters.

A held `'query'` target keeps the ids filed into it until the parent
collection is cleaned up, so a long session with many distinct filed ids
opens many subscriptions, one per id chunk.

#### Subscription Options

Pass `subscribeOptions` as the third `createCollection` argument to attach extra
options — `headers`, `filter`, `expand`, `fields` — to every real-time
subscription the factory creates.

```typescript
const c = createCollection<Schema>(pb, {
    subscribeOptions: () => {
        const token = getShareToken();
        return token ? { headers: { 'X-Share-Token': token } } : undefined;
    },
});
```

It is a **getter, not a static object**, and that matters. Subscriptions restart
on reconnect and whenever the subscriber count rises from zero, so a value read
once would go stale exactly when it counts — for example when a visitor
authenticates mid-session and should stop presenting an anonymous token.

Returning `undefined` subscribes with no extra options, identical to omitting
the option entirely.

The common use is authorizing anonymous access. PocketBase snakecases header
names the same way for real-time as for REST, so `X-Share-Token` is readable in
a collection rule as `@request.headers.x_share_token` — a single rule covers
both transports:

```
@request.auth.id != "" || @request.headers.x_share_token = "..."
```

Setting the matching header on REST requests remains the application's job, via
`pb.beforeSend`. Requires `pocketbase >= 0.22.0`.

An `expand` you add here is yours: pbtsdb strips only the paths it requested
through `alwaysFetchRelations` and `fetchRelations()`, so records expanded by
this option stay on the echoed rows, untyped.

### Utility Functions

#### newRecordId()

Generate a PocketBase-compatible record ID (15-character alphanumeric string).

```typescript
import { newRecordId } from 'pbtsdb';

const id = newRecordId(); // "a1b2c3d4e5f6g7h"

// Use when creating records
const newBook = {
    id: newRecordId(),
    title: 'New Book',
    // ... other fields
};

booksCollection.insert(newBook);
```

**Returns:** `string` - 15-character lowercase alphanumeric ID

#### Re-exported TanStack DB Utilities

pbtsdb re-exports commonly used TanStack DB utilities so you don't need to depend on `@tanstack/db` directly:

```typescript
import {
    // Includes helpers
    materialize,
    toArray,
    createEffect,

    // Index types (for collectionOptions.defaultIndexType)
    BasicIndex,
    BTreeIndex,
    ReverseIndex,

    // Types
    type DeltaEvent,
    type DeltaType,
    type EffectConfig,
    type EffectContext,
    type IndexConstructor,
} from 'pbtsdb';
```

## Usage Examples

### Example 1: Task Manager with Filtering

```typescript
// TaskBoard.tsx
import { useLiveQuery } from '@tanstack/react-db';
import { eq, and } from '@tanstack/db';
import { useStore } from './app';

export function TaskBoard({ userId }: { userId: string }) {
    const [tasks] = useStore('tasks');

    // Filter tasks by assignee and status - updates in real-time
    const { data: myTasks } = useLiveQuery((q) =>
        q.from({ tasks })
            .where(({ tasks }) => and(eq(tasks.assignee, userId), eq(tasks.status, 'in_progress')))
            .orderBy(({ tasks }) => tasks.due_date, 'asc')
    );

    const handleComplete = (taskId: string) => {
        tasks.update(taskId, (draft) => { draft.status = 'done'; });
    };

    return (
        <div>
            <h2>My Tasks ({myTasks?.length || 0})</h2>
            {myTasks?.map(task => (
                <div key={task.id}>
                    {task.title}
                    <button onClick={() => handleComplete(task.id)}>Complete</button>
                </div>
            ))}
        </div>
    );
}
```

### Example 2: E-commerce Product Catalog with Filtering

```typescript
// ProductCatalog.tsx
import { useLiveQuery } from '@tanstack/react-db';
import { and, eq, lte } from '@tanstack/db';
import { useStore } from './app';

export function ProductCatalog() {
    const [products] = useStore('products');
    const [category, setCategory] = useState<string | null>(null);
    const [maxPrice, setMaxPrice] = useState(1000);

    // Dynamic filtering - updates reactively
    const { data: filteredProducts } = useLiveQuery((q) => {
        let query = q.from({ products })
            .where(({ products }) => and(
                eq(products.in_stock, true),
                lte(products.price, maxPrice)
            ));

        if (category) {
            query = query.where(({ products }) => eq(products.category, category));
        }

        return query.orderBy(({ products }) => products.rating, 'desc');
    });

    return (
        <div>
            <select onChange={(e) => setCategory(e.target.value || null)}>
                <option value="">All Categories</option>
                <option value="electronics">Electronics</option>
            </select>
            <input type="range" max="1000" value={maxPrice}
                onChange={(e) => setMaxPrice(+e.target.value)} />

            {filteredProducts?.map(product => (
                <ProductCard key={product.id} product={product} />
            ))}
        </div>
    );
}
```

### Example 3: Social Media Feed with Likes

```typescript
// SocialFeed.tsx
import { useLiveQuery } from '@tanstack/react-db';
import { eq } from '@tanstack/db';
import { useStore } from './app';
import { materialize, newRecordId } from 'pbtsdb';

export function SocialFeed({ currentUserId }: { currentUserId: string }) {
    const [posts, likes, users] = useStore('posts', 'likes', 'users');

    const { data: feedPosts } = useLiveQuery((q) =>
        q.from({ posts })
            .orderBy(({ posts }) => posts.created, 'desc')
            .select(({ posts }) => ({
                ...posts,
                author: materialize(
                    q.from({ u: users }).where(({ u }) => eq(u.id, posts.author)).findOne()
                ),
            }))
    );

    const { data: userLikes } = useLiveQuery((q) =>
        q.from({ likes }).where(({ likes }) => eq(likes.user, currentUserId))
    );

    const likedPostIds = new Set(userLikes?.map(l => l.post) || []);

    const handleLike = (postId: string) => {
        if (likedPostIds.has(postId)) {
            const like = userLikes?.find(l => l.post === postId);
            if (like) likes.delete(like.id);
        } else {
            likes.insert({ id: newRecordId(), post: postId, user: currentUserId });
        }
    };

    return (
        <div>
            {feedPosts?.map(post => (
                <div key={post.id}>
                    <strong>{post.author?.username}</strong>
                    <p>{post.content}</p>
                    <button onClick={() => handleLike(post.id)}>
                        {likedPostIds.has(post.id) ? '❤️' : '🤍'} {post.likes_count}
                    </button>
                </div>
            ))}
        </div>
    );
}
```

### Example 4: Real-time Collaborative Todo List

```typescript
// CollaborativeTodoList.tsx
import { useLiveQuery } from '@tanstack/react-db';
import { eq } from '@tanstack/db';
import { useStore } from './app';
import { newRecordId } from 'pbtsdb';

export function CollaborativeTodoList({ listId, userId }: { listId: string; userId: string }) {
    const [todos] = useStore('todos');
    const [newText, setNewText] = useState('');

    // Real-time todos - updates when any user adds/edits
    const { data: allTodos } = useLiveQuery((q) =>
        q.from({ todos })
            .where(({ todos }) => eq(todos.list_id, listId))
            .orderBy(({ todos }) => todos.created, 'asc')
    );

    const handleAdd = () => {
        if (!newText.trim()) return;
        todos.insert({ id: newRecordId(), text: newText, completed: false, list_id: listId, created_by: userId });
        setNewText('');
    };

    return (
        <div>
            <input value={newText} onChange={(e) => setNewText(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleAdd()} />
            <ul>
                {allTodos?.map(todo => (
                    <li key={todo.id}>
                        <input type="checkbox" checked={todo.completed}
                            onChange={() => todos.update(todo.id, d => { d.completed = !d.completed; })} />
                        {todo.text}
                        <button onClick={() => todos.delete(todo.id)}>×</button>
                    </li>
                ))}
            </ul>
        </div>
    );
}
```

Real-time collaboration works automatically - when User A adds/edits a todo, User B sees it instantly.

### Example 5: Form with Optimistic Updates and Error Handling

```typescript
// CreateBookForm.tsx
import { useStore } from './app';
import { newRecordId } from 'pbtsdb';

export function CreateBookForm() {
    const [books] = useStore('books');
    const [title, setTitle] = useState('');
    const [error, setError] = useState<string | null>(null);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);

        try {
            // Optimistic insert - appears instantly
            const tx = books.insert({ id: newRecordId(), title, author: 'author_id' });
            await tx.when('settled');

            if (tx.state === 'completed') setTitle('');
            else setError('Failed to create book');
        } catch (err) {
            const failure = err as { data?: Record<string, unknown>; message?: string };
            setError(failure.data ? Object.values(failure.data).join(', ') : failure.message ?? 'Failed');
        }
    };

    return (
        <form onSubmit={handleSubmit}>
            {error && <div className="error">{error}</div>}
            <input value={title} onChange={(e) => setTitle(e.target.value)} required />
            <button type="submit">Add Book</button>
        </form>
    );
}
```

Optimistic updates show changes instantly; automatic rollback on server errors.

### Example 6: Dashboard with Multiple Collections and Joins

```typescript
// ProjectDashboard.tsx
import { useLiveQuery } from '@tanstack/react-db';
import { eq } from '@tanstack/db';
import { useStore } from './app';

export function ProjectDashboard({ projectId }: { projectId: string }) {
    const [projects, tasks, teamMembers, users] = useStore('projects', 'tasks', 'team_members', 'users');

    const { data: projectList } = useLiveQuery((q) =>
        q.from({ projects }).where(({ projects }) => eq(projects.id, projectId))
    );

    const { data: projectTasks } = useLiveQuery((q) =>
        q.from({ tasks }).where(({ tasks }) => eq(tasks.project, projectId))
    );

    // Join team members with users
    const { data: team } = useLiveQuery((q) =>
        q.from({ member: teamMembers })
            .where(({ member }) => eq(member.project, projectId))
            .join({ user: users }, ({ member, user }) => eq(member.user, user.id), 'left')
            .select(({ member, user }) => ({ id: member.id, role: member.role, name: user?.name }))
    );

    const completed = projectTasks?.filter(t => t.completed).length || 0;
    const total = projectTasks?.length || 0;

    return (
        <div>
            <h1>{projectList?.[0]?.name}</h1>
            <p>Progress: {completed}/{total} tasks</p>
            <p>Team: {team?.map(m => m.name).join(', ')}</p>
        </div>
    );
}
```

Demonstrates variadic `useStore()`, client-side aggregations, and TanStack DB joins.

### Includes (Nested Subqueries)

TanStack DB 0.6.0 introduces **includes** — nested subqueries within `select()` that project normalized data into hierarchical shapes. This is useful when you want to compose related data from multiple collections reactively.

#### Single relation with `findOne()`

Wrap a `findOne()` subquery in `materialize()` to get a plain `T | undefined`
value that updates when the child changes. Without it, the include is a live
sub-collection rather than a value.

```typescript
import { useLiveQuery, eq } from '@tanstack/react-db';
import { materialize } from 'pbtsdb';

const { data: booksWithAuthors } = useLiveQuery((q) =>
    q.from({ b: booksCollection }).select(({ b }) => ({
        id: b.id,
        title: b.title,
        author: materialize(
            q.from({ a: authorsCollection })
                .where(({ a }) => eq(a.id, b.author))
                .select(({ a }) => ({ id: a.id, name: a.name }))
                .findOne()
        ),
    }))
);
// booksWithAuthors[0].author?.name
```

#### Many relation with `toArray()`

```typescript
import { useLiveQuery, eq, toArray } from '@tanstack/react-db';
// Or: import { toArray } from 'pbtsdb';

const { data: booksWithTags } = useLiveQuery((q) =>
    q.from({ b: booksCollection }).select(({ b }) => ({
        id: b.id,
        title: b.title,
        tags: toArray(
            q.from({ bt: bookTagsCollection })
                .where(({ bt }) => eq(bt.book, b.id))
                .join({ t: tagsCollection }, ({ bt, t }) => eq(bt.tag, t.id))
                .select(({ t }) => ({ id: t.id, name: t.name }))
        ),
    }))
);
```

#### Includes on filed relations

Use PocketBase's `expand` to file a relation into its target collection, then use includes to query from it. Because the rows are already in the store, the include makes no request:

```typescript
const authorsCollection = c('authors', { syncMode: 'on-demand' });
const tagsCollection = c('tags', { syncMode: 'on-demand' });
const bookTagsCollection = c('book_tags', { syncMode: 'on-demand' });
const booksCollection = c('books', {
    syncMode: 'on-demand',
    relations: { author: authorsCollection },  // where expanded authors are filed
    alwaysFetchRelations: ['author'],
});

const { data } = useLiveQuery((q) =>
    q.from({ b: booksCollection }).select(({ b }) => ({
        id: b.id,
        title: b.title,
        // Reads from authorsCollection with no request; the rows are already filed
        author: materialize(
            q.from({ a: authorsCollection })
                .where(({ a }) => eq(a.id, b.author))
                .select(({ a }) => ({ id: a.id, name: a.name }))
                .findOne()
        ),
        tags: toArray(
            q.from({ bt: bookTagsCollection })
                .where(({ bt }) => eq(bt.book, b.id))
                .join({ t: tagsCollection }, ({ bt, t }) => eq(bt.tag, t.id))
                .select(({ t }) => ({ id: t.id, name: t.name }))
        ),
    }))
);
```

## TypeScript

pbtsdb is fully type-safe. Here's what you need to know:

### Define Your Schema

Use the simple schema format shown in the Quick Start:

```typescript
type MySchema = {
    collection_name: {
        type: RecordInterface;    // Your record type
        relations: {
            field_name: RelatedType;  // Related record types
        };
    };
}
```

**Pro tip:** Use [pocketbase-schema-generator](https://github.com/satohshi/pocketbase-schema-generator) to auto-generate types from your PocketBase database.

### Type-Safe Collections

Always create collections with proper type parameters:

```typescript
// ✅ Good - full type safety
const c = createCollection<MySchema>(pb);
const books = c('books', {
    omitOnInsert: ['created', 'updated'] as const
});

// ✅ Good - with always-fetched relations
const authors = c('authors', {});
const books = c('books', {
    relations: { author: authors },
    alwaysFetchRelations: ['author'],
});
```

## Best Practices

### 1. Define Collections Centrally

Define all collections once at app initialization:

```typescript
// ✅ Do this - centralized, type-safe
const c = createCollection<MySchema>(pb);

export const { Provider, useStore } = createReactProvider({
    posts: c('posts', { omitOnInsert: ['created', 'updated'] as const }),
    users: c('users', {}),
    comments: c('comments', { omitOnInsert: ['created', 'updated'] as const })
});
```

### 2. Create Dependencies Before Dependents

When declaring `relations`, create the target collection first:

```typescript
// ✅ Good - authors exists before books references it
const c = createCollection<MySchema>(pb);
const authors = c('authors', {});
const books = c('books', {
    relations: { author: authors },  // authors is already created
    alwaysFetchRelations: ['author'],
});

// ❌ Bad - can't reference what doesn't exist yet
const books = c('books', {
    relations: {
        author: ???  // Where is authors?
    },
    alwaysFetchRelations: ['author'],
});
```

### 3. Subscriptions are Automatic

Don't manually subscribe - just use `useLiveQuery`:

```typescript
// ✅ Do this
const { data } = useLiveQuery((q) => q.from({ posts }));

// ❌ Don't do this
useEffect(() => {
    posts.subscribe();
    return () => posts.unsubscribe();
}, []);
```

### 4. Handle Loading States

Always check loading and error states:

```typescript
const { data, isLoading, error } = useLiveQuery((q) => q.from({ posts }));

if (isLoading) return <div>Loading...</div>;
if (error) return <div>Error: {error.message}</div>;
if (!data?.length) return <div>No posts found</div>;

return <PostsList posts={data} />;
```

### 5. Choose Between alwaysFetchRelations and Joins

`alwaysFetchRelations` costs one request but carries the related record once
per parent row, on every fetch of the parent:

```typescript
const c = createCollection<MySchema>(pb);
const authors = c('authors', {});
const posts = c('posts', {
    relations: { author: authors },
    alwaysFetchRelations: ['author'],  // expanded on every posts request
});

const { data } = useLiveQuery((q) => q.from({ posts }));
```

A join or a `materialize()` include costs one batched request per query
(fetching each distinct related row once, however many parent rows reference
it) and, once the rows are filed, subsequent queries make no request at all.
Prefer `alwaysFetchRelations` when the parent is the only path by which those
rows enter an on-demand collection; otherwise let the query load them.

## Configuration

### Custom Logger Integration

By default, pbtsdb logs debug messages to the console in development mode. You can integrate with your own logging service (Sentry, LogRocket, etc.) using `setLogger`:

```typescript
import { setLogger } from 'pbtsdb';

// Example: Send errors to Sentry
setLogger({
    debug: (msg, context) => {
        // Custom debug handling (e.g., only log in dev)
        if (process.env.NODE_ENV === 'development') {
            console.debug('[pbtsdb]', msg, context);
        }
    },
    warn: (msg, context) => {
        console.warn('[pbtsdb]', msg, context);
        // Optional: Send to monitoring service
        myMonitoringService.warn(msg, context);
    },
    error: (msg, context) => {
        console.error('[pbtsdb]', msg, context);
        // Send errors to error tracking service
        Sentry.captureMessage(msg, {
            level: 'error',
            extra: context,
        });
    },
});
```

**Disable logging completely:**

```typescript
import { setLogger } from 'pbtsdb';

setLogger({
    debug: () => {},
    warn: () => {},
    error: () => {},
});
```

**Reset to default logger:**

```typescript
import { resetLogger } from 'pbtsdb';

resetLogger();
```

## License

MIT

## Contributing

Contributions welcome! Please open an issue or PR.

### Development Setup

**Prerequisites:**
- Node.js 20+
- Git
- The [PocketBase](https://pocketbase.io/docs/) binary on your `PATH` (the test server uses it)

**Clone and Install:**
```bash
git clone https://github.com/nathanstitt/pbtsdb
cd pbtsdb
npm install
```

### Running Tests

Tests use a real PocketBase instance with **fully automated infrastructure**:

```bash
npm test  # Auto-resets DB → Starts server → Runs tests → Stops server
```

The `npm test` command automatically:
1. Resets the test database to a clean state
2. Applies migrations and creates test collections
3. Starts PocketBase server on port 8210
4. Runs all Vitest tests
5. Stops the server when complete

**No manual server setup required!** All test infrastructure is automated.

**Advanced (for watch mode or debugging):**
```bash
# Start test server manually
npm run test:server

# Run tests against running server (in another terminal)
npm run test:run

# Just reset database without starting server
npm run db:reset
```

### Code Quality

```bash
npm run checks      # Run TypeScript type checking and linting
npm run lint:fix    # Auto-fix linting issues
npm run typecheck   # TypeScript only
```

### Documentation

- See [AGENTS.md](AGENTS.md) for comprehensive development guidelines
- See [test/README.md](test/README.md) for detailed testing documentation

---

**Built with:**
- [PocketBase](https://pocketbase.io) - Backend-as-a-Service
- [TanStack DB](https://tanstack.com/db) - Reactive database
- [TypeScript](https://www.typescriptlang.org) - Type safety
