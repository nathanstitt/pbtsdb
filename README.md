# pocketbase-tanstack-db

> Type-safe PocketBase integration with TanStack Query and TanStack DB

A TypeScript library that seamlessly integrates [PocketBase](https://pocketbase.io) with [TanStack Query](https://tanstack.com/query) and [TanStack DB](https://tanstack.com/db), providing:

- 🔥 **Real-time subscriptions** with automatic synchronization
- 🎯 **Full TypeScript type safety** for queries and relations
- ⚡ **Reactive collections** with TanStack DB
- 🔄 **Automatic caching** via TanStack Query
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

Collections automatically subscribe to PocketBase real-time updates:

```typescript
// Automatic subscription (default behavior)
const booksCollection = factory.create('books');
// ✅ Now subscribed to all book changes

// Disable auto-subscription
const booksCollection = factory.create('books', {
    enableSubscriptions: false
});

// Manually control subscriptions
await booksCollection.subscribe(); // Subscribe to all
await booksCollection.subscribe('record_id'); // Subscribe to specific record
booksCollection.unsubscribe(); // Unsubscribe from all
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
- `enableSubscriptions?: boolean` - Enable/disable auto-subscriptions (default: `true`)

**Examples:**

Basic collection:
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

Disable auto-subscriptions:
```typescript
const booksCollection = factory.create('books', {
    enableSubscriptions: false
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

Collections automatically receive real-time updates:

```typescript
function BooksList() {
    const { data } = useLiveQuery((q) =>
        q.from({ books: booksCollection })
    );

    // Component re-renders automatically when:
    // - A book is created
    // - A book is updated
    // - A book is deleted

    return <ul>{/* ... */}</ul>;
}
```

#### Manual Subscription Control

```typescript
const booksCollection = factory.create('books', {
    enableSubscriptions: false // Disable auto-subscriptions
});

// Later, subscribe when needed
await booksCollection.subscribe();

// Unsubscribe when done
booksCollection.unsubscribe();
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
- You trust PocketBase access control

```typescript
// ✅ Fast, simple, type-safe
const books = factory.create('books', {
    expand: 'author' as const
});
```

**Use TanStack Joins when:**
- You need inner/right/full joins
- Complex client-side filtering after joins
- Building computed fields from multiple collections

```typescript
// ✅ Flexible, powerful, type-safe
const { data } = useLiveQuery((q) =>
    q.from({ book: booksCollection })
        .join({ author: authorsCollection }, ..., 'inner')
);
```

### 2. Disable Subscriptions for Static Data

```typescript
// Metadata rarely changes - no need for real-time updates
const configCollection = factory.create('config', {
    enableSubscriptions: false
});
```

### 3. Use Provider for App-Wide Collections

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

### 4. Type Your Hooks

```typescript
// ✅ Explicit typing
const booksCollection = useStore<Book>('books');

// ✅ Tuple typing for multiple collections
const [books, authors] = useStores<[Book, Author]>(['books', 'authors']);
```

### 5. Handle Loading and Error States

```typescript
const { data, isLoading, error } = useLiveQuery((q) =>
    q.from({ books: booksCollection })
);

if (isLoading) return <Spinner />;
if (error) return <ErrorMessage error={error} />;
if (!data?.length) return <EmptyState />;

return <BooksList books={data} />;
```

### 6. Cleanup Subscriptions

```typescript
useEffect(() => {
    // Subscribe on mount
    booksCollection.subscribe();

    // Cleanup on unmount
    return () => {
        booksCollection.unsubscribe();
    };
}, []);
```

### 7. Use QueryClient Configuration

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

## License

ISC

## Contributing

Contributions welcome! Please open an issue or PR.

---

**Built with:**
- [PocketBase](https://pocketbase.io) - Backend-as-a-Service
- [TanStack Query](https://tanstack.com/query) - Powerful data fetching
- [TanStack DB](https://tanstack.com/db) - Reactive database
- [TypeScript](https://www.typescriptlang.org) - Type safety
