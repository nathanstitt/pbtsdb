# pbtsdb: PocketBase TanStack Database Integration

> Type-safe PocketBase integration with TanStack Query and TanStack DB

A TypeScript library that seamlessly integrates [PocketBase](https://pocketbase.io) with [TanStack Query](https://tanstack.com/query) and [TanStack DB](https://tanstack.com/db), providing:

- 🔥 **Real-time subscriptions** with automatic synchronization
- 🎯 **Full TypeScript type safety** for queries and relations
- ⚡ **Reactive collections** with TanStack DB
- 🔄 **Automatic caching** via TanStack Query
- ✨ **Optimistic mutations** with insert/update/delete support
- 🎨 **React hooks** for easy component integration
- 🔗 **Type-safe joins** and relation expansion

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
- [API Reference](#api-reference)
  - [createCollection()](#createcollection)
  - [React Integration](#react-integration)
  - [Subscriptions](#subscriptions)
- [Usage Examples](#usage-examples)
  - [Basic Queries](#basic-queries)
  - [Filtering and Sorting](#filtering-and-sorting)
  - [Relations and Joins](#relations-and-joins)
  - [Includes (Nested Subqueries)](#includes-nested-subqueries)
  - [Real-time Updates](#real-time-updates)
  - [Mutations](#mutations)
- [TypeScript](#typescript)
- [Best Practices](#best-practices)

## Installation

```bash
npm install pbtsdb pocketbase @tanstack/react-query @tanstack/react-db @tanstack/query-db-collection
```

### Peer Dependencies

- `pocketbase` >= 0.21.0
- `@tanstack/react-query` >= 5.0.0
- `@tanstack/react-db` >= 0.1.0
- `@tanstack/query-db-collection` >= 1.0.0
- `react` >= 18.0.0
- `react-dom` >= 18.0.0

All peer dependencies use minimum version constraints - newer versions should work.

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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createCollection, createReactProvider } from 'pbtsdb';

const pb = new PocketBase('http://localhost:8090');
const queryClient = new QueryClient({
    defaultOptions: {
        queries: { staleTime: 60_000 } // Cache for 1 minute
    }
});

// Create collections with automatic type inference
const c = createCollection<BlogSchema>(pb, queryClient);
export const { Provider, useStore } = createReactProvider({
    posts: c('posts', {
        omitOnInsert: ['created', 'updated'] as const
    }),
    users: c('users', {}),
    comments: c('comments', {
        omitOnInsert: ['created', 'updated'] as const
    })
});

export function App() {
    return (
        <QueryClientProvider client={queryClient}>
            <Provider>
                <BlogDashboard />
            </Provider>
        </QueryClientProvider>
    );
}
```

### 3. Build Your Components

```typescript
// BlogDashboard.tsx
import { useLiveQuery } from '@tanstack/react-db';
import { useStore } from './app';

export function BlogDashboard() {
    const [posts] = useStore('posts');

    const { data: allPosts, isLoading } = useLiveQuery((q) =>
        q.from({ posts })
            .orderBy(({ posts }) => posts.created, 'desc')
    );

    if (isLoading) return <div>Loading posts...</div>;

    return (
        <div>
            <h1>Blog Posts</h1>
            {allPosts?.map(post => (
                <article key={post.id}>
                    <h2>{post.title}</h2>
                    <p>{post.content}</p>
                    {/* Expanded author is fully typed! */}
                    <small>By {post.expand?.author?.username}</small>
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
import { newRecordId } from 'pbtsdb';

export function PostWithComments({ postId }: { postId: string }) {
    const [comments, posts] = useStore('comments', 'posts');

    // Real-time comments for this post
    const { data: postComments } = useLiveQuery((q) =>
        q.from({ comments })
            .where(({ comments }) => eq(comments.post, postId))
            .orderBy(({ comments }) => comments.created, 'desc')
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
                    <strong>{comment.expand?.author?.username}:</strong>
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
- ✅ Expanded relations

## Core Concepts

### Collections

Collections are reactive data stores that automatically sync with PocketBase:

```typescript
// Create a collection using the curried API
const c = createCollection<MySchema>(pb, queryClient);
const booksCollection = c('books', {});

// Collections automatically:
// - Fetch data from PocketBase
// - Subscribe to real-time updates
// - Update React components when data changes
// - Cache data via TanStack Query
```

### Real-time Subscriptions

Collections manage subscriptions **automatically** based on query lifecycle:

```typescript
// Collections are lazy - no subscription until queried
const c = createCollection<MySchema>(pb, queryClient);
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

### Mutations and Refetch

By default, pbtsdb does **not** refetch the entire collection after a successful insert, update, or delete. The realtime subscription delivers server-confirmed rows — including server-assigned fields like `id`, `created`, `updated`, and any values rewritten by PocketBase hooks — and TanStack DB's optimistic write keeps the UI consistent in the meantime. The post-mutation refetch is therefore redundant.

Set `refetchOnMutation: true` to opt back into the previous behavior — for example, when realtime is unreliable in your environment, or when a server-side hook produces a field you must read synchronously after the mutation resolves:

```typescript
const collection = c('books', {
    refetchOnMutation: true,
});
```

The option only affects the built-in default handlers. If you supply your own `onInsert`, `onUpdate`, or `onDelete`, you control its return value yourself — return `{ refetch: false }` (or omit a return) to skip the refetch, return `{ refetch: true }` to force one.

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
const c = createCollection<Schema>(pb: PocketBase, queryClient: QueryClient);
const collection = c(collectionName: string, options?: CreateCollectionOptions);
```

**Parameters:**
- `pb` - PocketBase instance
- `queryClient` - TanStack Query QueryClient instance
- `collectionName` - Name of the PocketBase collection
- `options` - Optional configuration

**Options:**
- `expand?: Record<string, Collection>` - Relations to auto-expand and auto-upsert on every fetch
- `omitOnInsert?: readonly string[]` - Fields to make optional during insert (e.g., `['created', 'updated'] as const`)
- `syncMode?: 'eager' | 'on-demand'` - Data fetching strategy (default: `'eager'`)
- `onInsert?: InsertMutationFn | false` - Custom insert handler or `false` to disable
- `onUpdate?: UpdateMutationFn | false` - Custom update handler or `false` to disable
- `onDelete?: DeleteMutationFn | false` - Custom delete handler or `false` to disable
- `ignoreAutoCancellation?: boolean` - Ignore PocketBase auto-cancellation errors (default: `true`)
- `collectionOptions?: object` - Additional TanStack DB collection options passed through directly (see [Collection Options Passthrough](#collection-options-passthrough))

**Returns:** Fully-typed Collection instance with subscription capabilities

**Examples:**

Basic collection (lazy, subscribes automatically on first query):
```typescript
const c = createCollection<MySchema>(pb, queryClient);
const booksCollection = c('books', {});
```

With auto-expand relations:
```typescript
const c = createCollection<MySchema>(pb, queryClient);
const authorsCollection = c('authors', {});
const booksCollection = c('books', {
    expand: {
        author: authorsCollection  // Auto-expand and auto-upsert
    }
});

// Expand is automatic on every fetch
const { data } = useLiveQuery((q) => q.from({ books: booksCollection }));

// Expanded records auto-inserted into authorsCollection
```

#### Collection Options Passthrough

Pass any [TanStack DB `BaseCollectionConfig`](https://tanstack.com/db/latest/docs/overview) option directly via `collectionOptions`. This is useful for configuring indexing, garbage collection, and other collection-level settings:

```typescript
import { BasicIndex } from 'pbtsdb';

const c = createCollection<MySchema>(pb, queryClient);
const booksCollection = c('books', {
    collectionOptions: {
        autoIndex: 'eager',
        defaultIndexType: BasicIndex,
        gcTime: 60000,       // 1 minute GC
        startSync: true,     // Start syncing immediately
    }
});
```

The following fields are managed by pbtsdb and excluded from `collectionOptions`: `getKey`, `syncMode`, `onInsert`, `onUpdate`, `onDelete`, `schema`.

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

const c = createCollection<MySchema>(pb, queryClient);
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
import { and, gte, lte } from '@tanstack/db';
import { useStore } from './app';

export function ProductCatalog() {
    const [products] = useStore('products');
    const [category, setCategory] = useState<string | null>(null);
    const [maxPrice, setMaxPrice] = useState(1000);

    // Dynamic filtering - updates reactively
    const { data: filteredProducts } = useLiveQuery((q) => {
        let query = q.from({ products })
            .where(({ products }) => and(
                products.in_stock === true,
                lte(products.price, maxPrice)
            ));

        if (category) {
            query = query.where(({ products }) => products.category === category);
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
import { newRecordId } from 'pbtsdb';

export function SocialFeed({ currentUserId }: { currentUserId: string }) {
    const [posts, likes] = useStore('posts', 'likes');

    const { data: feedPosts } = useLiveQuery((q) =>
        q.from({ posts }).orderBy(({ posts }) => posts.created, 'desc')
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
                    <strong>{post.expand?.author?.username}</strong>
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
            await tx.isPersisted.promise;

            if (tx.state === 'completed') setTitle('');
            else setError('Failed to create book');
        } catch (err: any) {
            setError(err.data ? Object.values(err.data).join(', ') : err.message);
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

```typescript
import { useLiveQuery, eq } from '@tanstack/react-db';

const { data: booksWithAuthors } = useLiveQuery((q) =>
    q.from({ b: booksCollection }).select(({ b }) => ({
        id: b.id,
        title: b.title,
        author: q
            .from({ a: authorsCollection })
            .where(({ a }) => eq(a.id, b.author))
            .select(({ a }) => ({ id: a.id, name: a.name }))
            .findOne(),
    }))
);
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

#### Combining expand with includes

Use PocketBase's `expand` to auto-populate a related collection, then use includes to query from it:

```typescript
const authorsCollection = c('authors', { syncMode: 'on-demand' });
const booksCollection = c('books', {
    syncMode: 'on-demand',
    expand: { author: authorsCollection },  // Auto-populates authorsCollection
});

const { data } = useLiveQuery((q) =>
    q.from({ b: booksCollection }).select(({ b }) => ({
        id: b.id,
        title: b.title,
        // Query from the expand-populated authorsCollection
        author: q.from({ a: authorsCollection })
            .where(({ a }) => eq(a.id, b.author))
            .select(({ a }) => ({ id: a.id, name: a.name }))
            .findOne(),
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
const c = createCollection<MySchema>(pb, queryClient);
const books = c('books', {
    omitOnInsert: ['created', 'updated'] as const
});

// ✅ Good - with auto-expand relations
const authors = c('authors', {});
const books = c('books', {
    expand: {
        author: authors
    }
});
```

## Best Practices

### 1. Define Collections Centrally

Define all collections once at app initialization:

```typescript
// ✅ Do this - centralized, type-safe
const c = createCollection<MySchema>(pb, queryClient);

export const { Provider, useStore } = createReactProvider({
    posts: c('posts', { omitOnInsert: ['created', 'updated'] as const }),
    users: c('users', {}),
    comments: c('comments', { omitOnInsert: ['created', 'updated'] as const })
});
```

### 2. Create Dependencies Before Dependents

When using expand collections, create the target collection first:

```typescript
// ✅ Good - authors exists before books references it
const c = createCollection<MySchema>(pb, queryClient);
const authors = c('authors', {});
const books = c('books', {
    expand: {
        author: authors  // authors is already created
    }
});

// ❌ Bad - can't reference what doesn't exist yet
const books = c('books', {
    expand: {
        author: ???  // Where is authors?
    }
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

### 5. Use Expand for Performance

Use PocketBase's expand feature for better performance:

```typescript
// ✅ Fast - single query with server-side expand
const c = createCollection<MySchema>(pb, queryClient);
const authors = c('authors', {});
const posts = c('posts', {
    expand: {
        author: authors  // Auto-expand on every fetch
    }
});

const { data } = useLiveQuery((q) => q.from({ posts }));

// ⚠️ Slower - multiple queries + client-side join
// Only use TanStack DB joins for inner/right/full join behavior
```

### 6. Configure QueryClient Defaults

```typescript
const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 60_000,      // 1 minute
            gcTime: 300_000,        // 5 minutes
            refetchOnWindowFocus: false
        }
    }
});
```

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
- Node.js 18+
- Git

**Clone and Install:**
```bash
git clone https://github.com/yourusername/pbtsdb
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
- [TanStack Query](https://tanstack.com/query) - Powerful data fetching
- [TanStack DB](https://tanstack.com/db) - Reactive database
- [TypeScript](https://www.typescriptlang.org) - Type safety
