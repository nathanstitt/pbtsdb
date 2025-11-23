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
  - [CollectionFactory](#collectionfactory)
  - [React Provider](#react-provider)
  - [Subscriptions](#subscriptions)
- [Usage Examples](#usage-examples)
  - [Basic Queries](#basic-queries)
  - [Filtering and Sorting](#filtering-and-sorting)
  - [Relations and Joins](#relations-and-joins)
  - [Real-time Updates](#real-time-updates)
  - [Mutations](#mutations)
- [TypeScript](#typescript)
- [Best Practices](#best-practices)

## Installation

```bash
npm install pocketbase-tanstack-db pocketbase @tanstack/react-query @tanstack/react-db @tanstack/query-db-collection
```

### Peer Dependencies

- `pocketbase` >= 0.21.0
- `@tanstack/react-query` >= 5.0.0
- `@tanstack/react-db` >= 0.1.0
- `@tanstack/query-db-collection` >= 1.0.0
- `react` >= 18.0.0
- `react-dom` >= 18.0.0

## Quick Start

### 1. Define Your Schema

Create type-safe schema definitions for your PocketBase collections.  The schema should be formed like the below, it's recommended
that you install https://github.com/satohshi/pocketbase-schema-generator as a pocketbase hook.  When configured a schema file will be auto-generated on every schema change.

```typescript
import type { SchemaDeclaration } from 'pocketbase-tanstack-db';

// Define your record types
interface Author {
    id: string;
    name: string;
    email: string;
    created: string;
    updated: string;
}

interface Book {
    id: string;
    title: string;
    author: string; // FK to authors
    genre: 'Fiction' | 'Non-Fiction' | 'Science Fiction';
    published_date: string;
    created: string;
    updated: string;
}

// Create schema declaration
interface MySchema extends SchemaDeclaration {
    authors: {
        Row: Author;
        Relations: {
            forward: {};
            back: {
                books: ['books', true]; // One-to-many relation
            };
        };
    };
    books: {
        Row: Book;
        Relations: {
            forward: {
                author: ['authors', false]; // Many-to-one relation
            };
            back: {};
        };
    };
}
```

### 2. Initialize PocketBase and Collections

```typescript
import PocketBase from 'pocketbase';
import { QueryClient } from '@tanstack/react-query';
import { CollectionFactory } from 'pocketbase-tanstack-db';

// Initialize PocketBase
const pb = new PocketBase('http://localhost:8090');

// Initialize QueryClient
const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 1000 * 60, // 1 minute
        },
    },
});

// Create collection factory
const factory = new CollectionFactory<MySchema>(pb, queryClient);

// Create collections
const authorsCollection = factory.create('authors');
const booksCollection = factory.create('books');
```

### 3. Use in React Components

```typescript
import { useLiveQuery } from '@tanstack/react-db';

function BooksList() {
    const { data: books, isLoading } = useLiveQuery((q) =>
        q.from({ books: booksCollection })
    );

    if (isLoading) return <div>Loading...</div>;

    return (
        <ul>
            {books?.map(book => (
                <li key={book.id}>{book.title}</li>
            ))}
        </ul>
    );
}
```

## Core Concepts

### Collections

Collections are reactive data stores that automatically sync with PocketBase:

```typescript
// Create a collection
const booksCollection = factory.create('books');

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
const booksCollection = factory.create('books');

// Subscription starts automatically when query becomes active
const { data } = useLiveQuery((q) =>
    q.from({ books: booksCollection })
);
// ✅ Subscribed to changes while component is mounted
// ✅ Unsubscribes automatically when component unmounts (with 5s cleanup delay)

// Advanced: Manual subscription control
await booksCollection.subscribe(); // Subscribe to all
await booksCollection.subscribe('record_id'); // Subscribe to specific record
booksCollection.unsubscribe('record_id'); // Unsubscribe from specific record
booksCollection.unsubscribeAll(); // Clear all subscriptions
```

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

### CollectionFactory

The main class for creating type-safe collections.

#### Constructor

```typescript
new CollectionFactory<Schema>(pocketbase: PocketBase, queryClient: QueryClient)
```

**Parameters:**
- `pocketbase`: PocketBase instance
- `queryClient`: TanStack Query QueryClient instance

**Example:**
```typescript
const factory = new CollectionFactory<MySchema>(pb, queryClient);
```

#### create()

Creates a reactive collection from a PocketBase collection.

```typescript
create<CollectionName>(
    collection: CollectionName,
    options?: CreateCollectionOptions
): Collection & SubscribableCollection
```

**Options:**
- `expand?: string` - Relations to expand (e.g., `'author,metadata'`)
- `relations?: Record<string, Collection>` - Collections for manual joins
- `startSync?: boolean` - Start syncing immediately (default: `false`, lazy)
- `onInsert?: InsertMutationFn | false` - Custom insert handler or `false` to disable
- `onUpdate?: UpdateMutationFn | false` - Custom update handler or `false` to disable
- `onDelete?: DeleteMutationFn | false` - Custom delete handler or `false` to disable

**Examples:**

Basic collection (lazy, subscribes automatically on first query):
```typescript
const booksCollection = factory.create('books');
```

With expand:
```typescript
const booksCollection = factory.create('books', {
    expand: 'author' as const // Type-safe expand
});

// Expanded relations available
const { data } = useLiveQuery((q) => q.from({ books: booksCollection }));
data[0].expand?.author // ✅ Typed!
```

With relations for joins:
```typescript
const authorsCollection = factory.create('authors');
const booksCollection = factory.create('books', {
    relations: {
        author: authorsCollection
    }
});
```

### React Provider

Provide collections to your React component tree.

#### CollectionsProvider

```typescript
<CollectionsProvider collections={collectionsMap}>
    {children}
</CollectionsProvider>
```

**Example:**
```typescript
import { CollectionsProvider } from 'pocketbase-tanstack-db';

const collections = {
    authors: factory.create('authors'),
    books: factory.create('books'),
};

function App() {
    return (
        <CollectionsProvider collections={collections}>
            <BooksList />
        </CollectionsProvider>
    );
}
```

#### useStore()

Access a single collection from the provider.

```typescript
const collection = useStore<RecordType>(key: string)
```

**Example:**
```typescript
function BooksList() {
    const booksCollection = useStore<Book>('books');

    const { data } = useLiveQuery((q) =>
        q.from({ books: booksCollection })
    );

    return <div>{/* ... */}</div>;
}
```

#### useStores()

Access multiple collections at once.

```typescript
const [col1, col2] = useStores<[Type1, Type2]>(keys: string[])
```

**Example:**
```typescript
function BooksWithAuthors() {
    const [booksCollection, authorsCollection] = useStores<[Book, Author]>(
        ['books', 'authors']
    );

    const { data } = useLiveQuery((q) =>
        q.from({ book: booksCollection })
            .join(
                { author: authorsCollection },
                ({ book, author }) => eq(book.author, author.id),
                'left'
            )
    );

    return <div>{/* ... */}</div>;
}
```

### Subscriptions

Collections support real-time subscriptions to PocketBase.

#### subscribe()

Subscribe to collection changes.

```typescript
// Subscribe to all records
await collection.subscribe();

// Subscribe to specific record
await collection.subscribe('record_id');
```

#### unsubscribe()

Unsubscribe from changes.

```typescript
// Unsubscribe from all
collection.unsubscribe();

// Unsubscribe from specific record
collection.unsubscribe('record_id');
```

#### unsubscribeAll()

Clear all subscriptions for a collection.

```typescript
collection.unsubscribeAll();
```

#### isSubscribed()

Check subscription status.

```typescript
// Check collection-wide subscription
const isSubbed = collection.isSubscribed(); // boolean

// Check specific record subscription
const isRecordSubbed = collection.isSubscribed('record_id'); // boolean
```

#### waitForSubscription()

Wait for subscription to be established (useful in tests).

```typescript
await collection.waitForSubscription(); // Wait for collection-wide
await collection.waitForSubscription('record_id'); // Wait for specific record
await collection.waitForSubscription(undefined, 5000); // With timeout
```

### Utility Functions

#### newRecordId()

Generate a PocketBase-compatible record ID (15-character alphanumeric string).

```typescript
import { newRecordId } from 'pocketbase-tanstack-db';

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

## Usage Examples

### Basic Queries

#### Fetch All Records

```typescript
const { data: books, isLoading, error } = useLiveQuery((q) =>
    q.from({ books: booksCollection })
);

if (isLoading) return <div>Loading...</div>;
if (error) return <div>Error: {error.message}</div>;

return (
    <ul>
        {books?.map(book => (
            <li key={book.id}>{book.title}</li>
        ))}
    </ul>
);
```

#### Fetch Single Record

```typescript
import { eq } from '@tanstack/db';

const bookId = 'abc123';

const { data: books } = useLiveQuery((q) =>
    q.from({ books: booksCollection })
        .where(({ books }) => eq(books.id, bookId))
);

const book = books?.[0];
```

### Filtering and Sorting

#### Basic Filtering

```typescript
import { eq, gt, and, or } from '@tanstack/db';

// Filter by genre
const { data } = useLiveQuery((q) =>
    q.from({ books: booksCollection })
        .where(({ books }) => eq(books.genre, 'Fiction'))
);

// Filter by date
const { data } = useLiveQuery((q) =>
    q.from({ books: booksCollection })
        .where(({ books }) =>
            gt(books.published_date, '2020-01-01')
        )
);

// Multiple conditions with AND
const { data } = useLiveQuery((q) =>
    q.from({ books: booksCollection })
        .where(({ books }) => and(
            eq(books.genre, 'Fiction'),
            gt(books.published_date, '2020-01-01')
        ))
);

// Multiple conditions with OR
const { data } = useLiveQuery((q) =>
    q.from({ books: booksCollection })
        .where(({ books }) => or(
            eq(books.genre, 'Fiction'),
            eq(books.genre, 'Science Fiction')
        ))
);
```

#### Advanced Filtering

```typescript
import { gte, lte, and } from '@tanstack/db';

// Complex nested queries
const { data } = useLiveQuery((q) =>
    q.from({ books: booksCollection })
        .where(({ books }) => and(
            eq(books.genre, 'Fiction'),
            or(
                gte(books.published_date, '2020-01-01'),
                lte(books.published_date, '2010-12-31')
            )
        ))
);
```

#### Sorting

```typescript
// Sort descending
const { data } = useLiveQuery((q) =>
    q.from({ books: booksCollection })
        .orderBy(({ books }) => books.published_date, 'desc')
);

// Sort ascending
const { data } = useLiveQuery((q) =>
    q.from({ books: booksCollection })
        .orderBy(({ books }) => books.title, 'asc')
);

// Multiple sorts
const { data } = useLiveQuery((q) =>
    q.from({ books: booksCollection })
        .orderBy(({ books }) => books.genre, 'asc')
        .orderBy(({ books }) => books.published_date, 'desc')
);
```

### Relations and Joins

#### Type-Safe Expand (Recommended)

Use PocketBase's built-in expand for fast, server-side joins:

```typescript
// Create collection with expand
const booksCollection = factory.create('books', {
    expand: 'author' as const // ← Type-safe!
});

// Use in query
const { data } = useLiveQuery((q) =>
    q.from({ books: booksCollection })
);

// Access expanded relations (fully typed!)
data?.forEach(book => {
    if (book.expand?.author) {
        console.log(book.expand.author.name); // ✅ Type-safe
    }
});
```

#### Multiple Expands

```typescript
const booksCollection = factory.create('books', {
    expand: 'author,metadata' as const
});

// Both relations expanded
data[0].expand?.author   // ✅ Author type
data[0].expand?.metadata // ✅ Metadata type
```

#### TanStack DB Joins

For complex client-side joins:

```typescript
const authorsCollection = factory.create('authors');
const booksCollection = factory.create('books', {
    relations: {
        author: authorsCollection
    }
});

// Manual join with full type safety
const { data } = useLiveQuery((q) =>
    q.from({ book: booksCollection })
        .join(
            { author: authorsCollection },
            ({ book, author }) => eq(book.author, author.id),
            'left' // Join type: 'left' | 'right' | 'inner' | 'full'
        )
        .select(({ book, author }) => ({
            ...book,
            expand: {
                author: author ? { ...author } : undefined
            }
        }))
);
```

#### Inner Join (Filter Out Missing Relations)

```typescript
const { data } = useLiveQuery((q) =>
    q.from({ book: booksCollection })
        .join(
            { author: authorsCollection },
            ({ book, author }) => eq(book.author, author.id),
            'inner' // Only books WITH authors
        )
);
```

#### Complex Multi-Collection Joins

```typescript
const authorsCollection = factory.create('authors');
const booksCollection = factory.create('books');
const metadataCollection = factory.create('book_metadata');

const { data } = useLiveQuery((q) =>
    q.from({ book: booksCollection })
        .join(
            { author: authorsCollection },
            ({ book, author }) => eq(book.author, author.id),
            'left'
        )
        .join(
            { metadata: metadataCollection },
            ({ book, metadata }) => eq(book.id, metadata.book),
            'left'
        )
        .select(({ book, author, metadata }) => ({
            ...book,
            expand: {
                author: author ? { ...author } : undefined,
                metadata: metadata ? { ...metadata } : undefined
            }
        }))
);
```

### Real-time Updates

#### Automatic Updates

Collections automatically receive real-time updates based on query lifecycle:

```typescript
function BooksList() {
    const { data } = useLiveQuery((q) =>
        q.from({ books: booksCollection })
    );

    // Subscription automatically starts when component mounts
    // Component re-renders automatically when:
    // - A book is created
    // - A book is updated
    // - A book is deleted
    // Subscription automatically stops when component unmounts (with 5s delay)

    return <ul>{/* ... */}</ul>;
}
```

**Subscription Lifecycle:**
- ✅ Collections are lazy - no network activity on creation
- ✅ Subscription starts when first `useLiveQuery` becomes active
- ✅ Multiple queries share a single subscription per collection
- ✅ Subscription stops 5 seconds after last query unmounts
- ✅ Prevents thrashing during rapid mount/unmount cycles

#### Manual Subscription Control (Advanced)

For advanced use cases, you can manually control subscriptions:

```typescript
const booksCollection = factory.create('books');

// Manually subscribe (bypasses automatic lifecycle)
await booksCollection.subscribe();

// Subscribe to specific record
await booksCollection.subscribe('record_id');

// Unsubscribe when done
booksCollection.unsubscribe('record_id');
booksCollection.unsubscribeAll();
```

#### Subscribing to Specific Records

```typescript
// Subscribe to a specific book
await booksCollection.subscribe('book_id_123');

// Check if subscribed
if (booksCollection.isSubscribed('book_id_123')) {
    console.log('Subscribed to book_id_123');
}

// Unsubscribe from specific record
booksCollection.unsubscribe('book_id_123');
```

#### Waiting for Subscription (Testing)

```typescript
// Useful in tests
await booksCollection.waitForSubscription();

// Now safe to create/update records and expect real-time updates
const newBook = await pb.collection('books').create({ /* ... */ });

// Wait for update to propagate
await waitFor(() => {
    expect(data?.some(b => b.id === newBook.id)).toBe(true);
});
```

### Mutations

Collections support insert, update, and delete operations with automatic PocketBase synchronization and optimistic updates.

#### Insert Records

```typescript
import { newRecordId } from 'pocketbase-tanstack-db';

const { data } = useLiveQuery((q) =>
    q.from({ books: booksCollection })
);

// Insert a new book
const newBook: Book = {
    id: newRecordId(), // Generate PocketBase-compatible ID
    title: 'The Great Gatsby',
    author: 'author_id_123',
    genre: 'Fiction',
    published_date: '1925-04-10',
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
};

const transaction = booksCollection.insert(newBook);

// Transaction states: 'pending' → 'persisting' → 'completed'
console.log(transaction.state); // 'pending' or 'persisting'

// Wait for persistence
await transaction.isPersisted.promise;
console.log(transaction.state); // 'completed'

// Optimistic update: newBook appears in UI immediately
// Real sync: newBook saved to PocketBase
```

#### Update Records

```typescript
// Update a book's title
const transaction = booksCollection.update('book_id_123', (draft) => {
    draft.title = 'Updated Title';
    draft.genre = 'Science Fiction';
});

// Optimistic update: Changes appear immediately in UI
// Real sync: Changes saved to PocketBase

await transaction.isPersisted.promise;
```

#### Non-Optimistic Updates

By default, mutations are optimistic (UI updates immediately). Disable for server-first updates:

```typescript
// Update config goes BEFORE the callback
const transaction = booksCollection.update(
    'book_id_123',
    { optimistic: false }, // ← Config parameter
    (draft) => {
        draft.title = 'Server-First Update';
    }
);

// UI won't update until server confirms
await transaction.isPersisted.promise;
// Now UI updates with server response
```

#### Delete Records

```typescript
const transaction = booksCollection.delete('book_id_123');

// Optimistic update: Record removed from UI immediately
// Real sync: Record deleted from PocketBase

await transaction.isPersisted.promise;
```

#### Batch Mutations

Batch multiple mutations together for better performance:

```typescript
booksCollection.utils.writeBatch(() => {
    // Multiple mutations in one batch
    booksCollection.update('book_1', (draft) => {
        draft.title = 'Updated Title 1';
    });

    booksCollection.update('book_2', (draft) => {
        draft.title = 'Updated Title 2';
    });

    booksCollection.update('book_3', (draft) => {
        draft.genre = 'Mystery';
    });
});

// All mutations:
// - Execute optimistically together
// - Merge updates to the same record
// - Sync to PocketBase in a single transaction
```

#### Mutation Merging

Multiple updates to the same record within a batch are automatically merged:

```typescript
booksCollection.utils.writeBatch(() => {
    booksCollection.update('book_1', (draft) => {
        draft.title = 'First Update';
    });

    booksCollection.update('book_1', (draft) => {
        draft.title = 'Final Title'; // Overwrites previous
    });

    booksCollection.update('book_1', (draft) => {
        draft.genre = 'Mystery'; // Merged with title update
    });
});

// Result: Only ONE mutation sent to PocketBase with:
// { title: 'Final Title', genre: 'Mystery' }
```

#### Transaction States

Mutations return a `Transaction` object with state tracking:

```typescript
const tx = booksCollection.insert(newBook);

// States: 'pending' | 'persisting' | 'completed' | 'error'
console.log(tx.state);

// Wait for completion
await tx.isPersisted.promise;

if (tx.state === 'completed') {
    console.log('Mutation succeeded!');
}
```

#### Custom Mutation Handlers

Override default behavior for insert/update/delete operations:

```typescript
const booksCollection = factory.create('books', {
    // Custom insert handler
    onInsert: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
            await customInsertLogic(mutation.modified);
        }
        await queryClient.invalidateQueries({ queryKey: ['books'] });
    },

    // Custom update handler
    onUpdate: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
            const recordId = (mutation.original as { id: string }).id;
            await customUpdateLogic(recordId, mutation.changes);
        }
        await queryClient.invalidateQueries({ queryKey: ['books'] });
    },

    // Custom delete handler
    onDelete: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
            const recordId = (mutation.original as { id: string }).id;
            await customDeleteLogic(recordId);
        }
        await queryClient.invalidateQueries({ queryKey: ['books'] });
    },
});
```

#### Disable Mutations (Read-Only Collections)

Set mutation handlers to `false` to disable specific operations:

```typescript
const booksCollection = factory.create('books', {
    onInsert: false, // Inserts will throw an error
    onUpdate: false, // Updates will throw an error
    onDelete: false, // Deletes will throw an error
});

// This will throw an error:
booksCollection.insert(newBook); // ❌ Error: Inserts disabled
```

#### Mutations with Expand

Mutations work seamlessly with expanded relations:

```typescript
const booksCollection = factory.create('books', {
    expand: 'author' as const
});

// Insert includes expanded relation
const newBook = {
    id: newRecordId(),
    title: 'New Book',
    author: 'author_id_123',
    // ... other fields
};

booksCollection.insert(newBook);

// After sync, the collection will re-fetch with expand
// so the new book will have book.expand.author populated
```

## TypeScript

### Schema Declaration

Define your schema with full type safety:

```typescript
import type { SchemaDeclaration } from 'pocketbase-tanstack-db';

interface MySchema extends SchemaDeclaration {
    collection_name: {
        Row: RecordType;      // Your record type
        Relations: {
            forward: {
                // Forward relations (FK fields)
                field_name: [
                    'target_collection',
                    is_array // false for single, true for array
                ];
            };
            back: {
                // Back relations (reverse lookups)
                relation_name: ['source_collection', is_array];
            };
        };
    };
}
```

### Example: Blog Schema

```typescript
interface Post {
    id: string;
    title: string;
    content: string;
    author: string; // FK to users
    tags: string[]; // FK array to tags
    created: string;
    updated: string;
}

interface User {
    id: string;
    username: string;
    email: string;
    created: string;
    updated: string;
}

interface Tag {
    id: string;
    name: string;
    created: string;
    updated: string;
}

interface BlogSchema extends SchemaDeclaration {
    posts: {
        Row: Post;
        Relations: {
            forward: {
                author: ['users', false];  // Single relation
                tags: ['tags', true];      // Array relation
            };
            back: {};
        };
    };
    users: {
        Row: User;
        Relations: {
            forward: {};
            back: {
                posts: ['posts', true];    // One user, many posts
            };
        };
    };
    tags: {
        Row: Tag;
        Relations: {
            forward: {};
            back: {
                posts: ['posts', true];    // One tag, many posts
            };
        };
    };
}
```

### Type-Safe Expand

Use `as const` for type-safe expand strings:

```typescript
const postsCollection = factory.create('posts', {
    expand: 'author,tags' as const
    // ✅ TypeScript validates these are real relations
});

// Expanded fields are typed
data[0].expand?.author.username  // ✅ string
data[0].expand?.tags[0].name     // ✅ string
```

## Best Practices

### 1. Choose the Right Approach for Relations

**Use Type-Safe Expand when:**
- You need fast, single-query performance
- Relations are straightforward


```typescript
// ✅ Fast, simple, type-safe
const books = factory.create('books', {
    expand: 'author' as const
});
```

**Use TanStack Joins when:**
- You need inner/right/full joins
- You want the related records to update in response to sync
- Complex client-side filtering after joins
- Building computed fields from multiple collections


```typescript
// ✅ Flexible, powerful, type-safe
const { data } = useLiveQuery((q) =>
    q.from({ book: booksCollection })
        .join({ author: authorsCollection }, ..., 'inner')
);
```

### 2. Use Provider for App-Wide Collections

```typescript
// ✅ Define collections once
const collections = {
    books: factory.create('books'),
    authors: factory.create('authors'),
};

// Use throughout app
<CollectionsProvider collections={collections}>
    <App />
</CollectionsProvider>
```

### 3. Type Your Hooks

```typescript
// ✅ Explicit typing
const booksCollection = useStore<Book>('books');

// ✅ Tuple typing for multiple collections
const [books, authors] = useStores<[Book, Author]>(['books', 'authors']);
```

### 4. Handle Loading and Error States

```typescript
const { data, isLoading, error } = useLiveQuery((q) =>
    q.from({ books: booksCollection })
);

if (isLoading) return <Spinner />;
if (error) return <ErrorMessage error={error} />;
if (!data?.length) return <EmptyState />;

return <BooksList books={data} />;
```

### 5. Subscriptions are Automatic

No need to manually subscribe/unsubscribe - the library handles it:

```typescript
// ❌ Don't do this (unless you have advanced use case)
useEffect(() => {
    booksCollection.subscribe();
    return () => booksCollection.unsubscribe();
}, []);

// ✅ Do this instead - automatic lifecycle management
const { data } = useLiveQuery((q) =>
    q.from({ books: booksCollection })
);
```

### 6. Use QueryClient Configuration

```typescript
const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 1000 * 60 * 5, // 5 minutes
            gcTime: 1000 * 60 * 10,   // 10 minutes
            retry: 3,
            refetchOnWindowFocus: false,
        },
    },
});
```

## Configuration

### Custom Logger Integration

By default, pbtsdb logs debug messages to the console in development mode. You can integrate with your own logging service (Sentry, LogRocket, etc.) using `setLogger`:

```typescript
import { setLogger } from 'pocketbase-tanstack-db';

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
import { setLogger } from 'pocketbase-tanstack-db';

setLogger({
    debug: () => {},
    warn: () => {},
    error: () => {},
});
```

**Reset to default logger:**

```typescript
import { resetLogger } from 'pocketbase-tanstack-db';

resetLogger();
```

## License

ISC

## Contributing

Contributions welcome! Please open an issue or PR.

### Development Setup

**Prerequisites:**
- Node.js 18+
- Git

**Clone and Install:**
```bash
git clone https://github.com/yourusername/pocketbase-tanstack-db
cd pocketbase-tanstack-db
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
