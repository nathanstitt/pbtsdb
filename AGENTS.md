# pbtsdb: PocketBase TanStack Database Integration

## Project Overview

pbtsdb is a TypeScript library that integrates PocketBase (backend-as-a-service) with TanStack's reactive database and query management tools. It provides type-safe collection management with real-time data synchronization capabilities.

**Core Purpose:** Bridge PocketBase collections with TanStack DB's reactive collections while maintaining full TypeScript type safety.

## Core Technologies

### PocketBase (v0.26.3)
- Backend-as-a-service platform providing database, authentication, and real-time subscriptions
- Collections-based data model (similar to tables in traditional databases)
- Built-in authentication and authorization
- Real-time subscriptions via Server-Sent Events (SSE)
- **Documentation:** https://pocketbase.io/docs/

**Key Concepts:**
- **Collections:** Database tables with defined schemas
- **Records:** Individual entries in collections with auto-generated `id`, `created`, and `updated` fields
- **Relations:** Foreign key relationships between collections
- **Expand:** Query parameter to populate related records (similar to SQL joins)
- **Auth:** Built-in user authentication with collection-based user management

### TanStack Query (v5.90.10)
- Powerful data fetching and state management library
- Handles caching, background updates, and stale data
- **Documentation:** https://tanstack.com/query/latest

**Key Concepts:**
- **QueryClient:** Central manager for all queries and mutations
- **Query Keys:** Unique identifiers for cached data (use record IDs as keys)
- **Stale-While-Revalidate:** Serve cached data while fetching fresh data in background
- **Automatic Refetching:** Configurable refetch on window focus, reconnect, etc.

### TanStack DB (v0.1.49) & Query DB Collection (v1.0.4)
- Client-side reactive database built on TanStack Query
- Provides collections with automatic reactivity
- **Documentation:** https://tanstack.com/db/latest

**Key Concepts:**
- **Collections:** In-memory reactive data structures
- **createCollection:** Factory function that connects TanStack Query to TanStack DB
- **Key Functions:** Specify how to extract unique identifiers from records
- **Live Queries:** React hooks that automatically update when data changes

## Architecture

### CollectionFactory Pattern

The `CollectionFactory` class (`src/collection.ts`) is the core abstraction that connects PocketBase to TanStack DB:

```typescript
class CollectionFactory<Schema extends SchemaDeclaration, TMaxDepth extends 0 | 1 | 2 | 3 | 4 | 5 | 6 = 2>
```

**Responsibilities:**
1. Create type-safe TanStack DB collections from PocketBase collections
2. Integrate with React Query's QueryClient for state management
3. Fetch full collection lists from PocketBase (lazy - only when queried)
4. Provide automatic key management based on record IDs
5. Manage real-time subscriptions automatically based on query lifecycle

**Usage Pattern:**
```typescript
const collection = new CollectionFactory(pb, queryClient)
    .create<JobsRecord, Schema>('jobs');
```

### Type Safety Requirements

**CRITICAL:** All code must maintain strict TypeScript type safety:

1. **Schema Definitions** (`test/schema.ts`):
   - Define all collection schemas using `SchemaDeclaration` interface
   - Include both forward relations (foreign keys) and back-relations (reverse lookups)
   - Keep schemas synchronized with PocketBase collection definitions

2. **Generic Constraints:**
   - Schema must extend `SchemaDeclaration` (from @tanstack/query-db-collection)
   - Never use `any` type (enforced by Biome linter)

3. **Record Types:**
   - All record types include base fields: `id`, `created`, `updated` (strings)
   - Relation fields are typed as IDs (strings) or arrays of IDs
   - Use PocketBase's `expand` to get populated relations with full type safety

## Development Guidelines

### Code Quality Standards (Biome)

Configuration in `biome.json` enforces:
- **No explicit `any` types** - Use proper TypeScript types
- **No `console` statements** - Remove debug code before committing
- **No `var` declarations** - Use `const` or `let`
- **Template literals required** - Use backticks for string interpolation
- **Organized imports** - Biome automatically sorts imports
- **Formatting:** 4-space indents, 100-char line width, single quotes

**Commands:**
```bash
npm run lint        # Check for linting issues
npm run lint:fix    # Auto-fix linting issues
npm run typecheck   # TypeScript type checking
npm run checks      # Run both typecheck and lint
```

### TypeScript Configuration

`tsconfig.json` uses strict mode with:
- `strict: true` - All strict type-checking options enabled
- `noEmit: true` - Type checking only (no compilation)
- `esModuleInterop: true` - Better ES module compatibility
- Target: ESNext with bundler module resolution

### Testing Requirements

**CRITICAL:** Maintain and expand test coverage when making changes.

**Test Setup:**
- Vitest with JSDOM environment for DOM simulation
- Integration tests use real PocketBase connection (not mocked)
- Environment variables required in `.env`:
  - `TESTING_PB_ADDR` - PocketBase server URL (default: http://127.0.0.1:8210)
  - `TEST_USER_EMAIL` - Test user credentials
  - `TEST_USER_PW` - Test user password

**Test Pattern:**
```typescript
// Authenticate with PocketBase
await pb.collection('users').authWithPassword(email, password);

// Create collection
const collection = new CollectionFactory(pb, queryClient)
    .create<Record, Schema>('collection_name');

// Fetch and assert
const records = await collection.getFullList();
expect(records.length).toBeGreaterThan(0);
```

**When to Write Tests:**
- Adding new collection types
- Modifying CollectionFactory logic
- Changing query behavior
- Adding new methods or features

**Running Tests:**
```bash
npm test  # Run all tests with Vitest
```

## Key Patterns and Best Practices

### Working with Schemas

**1. Define Collection Schema:**
```typescript
interface Schema extends SchemaDeclaration {
    collection_name: {
        Row: CollectionRecord;     // The record type
        Relations: {
            forward: {
                related_field: ['other_collection', false];  // Single relation
                multiple_field: ['other_collection', true];  // Array relation
            };
            back: {
                reverse_name: ['source_collection', false];
            };
        };
    };
}
```

**2. Keep Schema in Sync:**
- When PocketBase schema changes, update `test/schema.ts`
- Regenerate types if using PocketBase SDK type generation
- Run tests to catch type mismatches

### Working with Relationships: Type-Safe Expand vs TanStack Joins

**IMPORTANT:** pbtsdb provides TWO fully type-safe approaches for working with related data. Choose based on your use case:

#### Approach 1: Type-Safe PocketBase Expand (Recommended for most cases)

Use when you need **server-side performance** with a single query.

```typescript
const collections = new CollectionFactory<Schema>(pb, queryClient);

// Type-safe expand with full autocomplete
const jobsCollection = collections.create('jobs', {
    expand: 'customer,address' as const
});

// In your React component
const { data } = useLiveQuery((q) =>
    q.from({ jobs: jobsCollection })
);

// The expand property is now FULLY TYPED - no `any` types!
if (data[0]?.expand) {
    // TypeScript knows these exist and their types
    const customerName: string = data[0].expand.customer.name;  // ✅ Type-safe
    const addressCity: string = data[0].expand.address.city;    // ✅ Type-safe
}
```

**Advantages:**
- ✅ Single query to PocketBase (fast)
- ✅ Server-side expansion (efficient)
- ✅ Fully type-safe expand property
- ✅ Works with PocketBase access control

**When to use:**
- Fetching records with their relations for display
- Need performance-critical single queries
- Want PocketBase to handle access control on relations

#### Approach 2: TanStack DB Joins (For complex client-side operations)

Use when you need **client-side join flexibility** or complex query logic.

```typescript
const collections = new CollectionFactory<Schema>(pb, queryClient);

// Create collections with relations config
const customersCollection = collections.create('customers');
const jobsCollection = collections.create('jobs', {
    relations: {
        customer: customersCollection  // ✅ Type-checked
    }
});

// Use TanStack DB joins
const { data } = useLiveQuery((q) =>
    q.from({ job: jobsCollection })
        .join(
            { customer: customersCollection },
            ({ job, customer }) => eq(job.customer, customer.id),
            'left'  // or 'inner', 'right', 'full'
        )
        .select(({ job, customer }) => ({
            ...job,
            expand: {
                customer: customer ? { ...customer } : undefined
            }
        }))
);

// Fully typed joined data
const customerName: string | undefined = data[0]?.expand?.customer?.name;  // ✅ Type-safe
```

**Advantages:**
- ✅ Full join type support (left, right, inner, full)
- ✅ Client-side filtering after join
- ✅ Complex multi-collection queries
- ✅ Fully type-safe results

**When to use:**
- Need inner joins to filter out records without relations
- Complex multi-step client-side data transformations
- Building aggregations or computed fields from multiple collections

#### Comparison Table

| Feature | Type-Safe Expand | TanStack Joins |
|---------|-----------------|----------------|
| **Performance** | ⚡ Fast (1 query) | 🐌 Slower (multiple queries) |
| **Type Safety** | ✅ Full | ✅ Full |
| **Join Types** | ❌ Left join only | ✅ All (left/right/inner/full) |
| **Server Load** | ✅ Low | ⚠️ Higher (multiple fetches) |
| **Access Control** | ✅ PocketBase enforced | ⚠️ Manual filtering needed |
| **Complexity** | ✅ Simple | ⚠️ More verbose |

#### Best Practices

1. **Default to Type-Safe Expand:**
   ```typescript
   // ✅ GOOD: Simple, fast, type-safe
   const jobs = collections.create('jobs', {
       expand: 'customer,address' as const
   });
   ```

2. **Use Joins for Filtering:**
   ```typescript
   // ✅ GOOD: When you need inner join behavior
   q.from({ job: jobsCollection })
       .join(
           { customer: customersCollection },
           ({ job, customer }) => eq(job.customer, customer.id),
           'inner'  // Only jobs WITH customers
       )
   ```

3. **Combine Both Approaches:**
   ```typescript
   // ✅ GOOD: Expand for some, join for complex logic
   const jobs = collections.create('jobs', {
       expand: 'address' as const,  // Simple expansion
       relations: {
           customer: customersCollection  // For manual joins
       }
   });
   ```

4. **Use `as const` for Expand Strings:**
   ```typescript
   // ✅ GOOD: Enables proper type inference
   expand: 'customer,address' as const

   // ❌ BAD: Type inference limited
   expand: 'customer,address'
   ```

### Working with Collections

**1. Creating Collections:**
```typescript
const collection = new CollectionFactory(pb, queryClient)
    .create<RecordType, Schema>('collection_name');
```

**2. Fetching Data:**
```typescript
// Full list (no pagination)
const records = await collection.getFullList();

// With filters and sorting
const filtered = await pb.collection('jobs')
    .getFullList({
        filter: 'status = "ACTIVE"',
        sort: '-created',
        expand: 'customer,location'
    });
```

**3. Using Relations:**
- Relations are stored as IDs in the record
- Use `expand` parameter to populate related records
- Expanded data appears in `record.expand` object

### Integration with React Query

**Query Keys:**
- TanStack DB uses record IDs as query keys automatically
- The `getFullList()` method populates the QueryClient cache
- Individual records can be accessed reactively via query keys

**React Usage (if adding React components):**
```typescript
import { useLiveQuery } from '@tanstack/react-db';

// In component
const jobs = useLiveQuery(collection, selector => selector.getAll());
```

## PocketBase Integration Details

### Authentication

```typescript
// Authenticate before making requests
await pb.collection('users').authWithPassword(email, password);

// Auth state is stored in pb.authStore
const currentUser = pb.authStore.model;
const isAuthenticated = pb.authStore.isValid;
```

### Collection Methods

```typescript
// Get full list (no pagination)
await pb.collection('name').getFullList(options);

// Get paginated list
await pb.collection('name').getList(page, perPage, options);

// Get single record
await pb.collection('name').getOne(id, options);

// Create record
await pb.collection('name').create(data);

// Update record
await pb.collection('name').update(id, data);

// Delete record
await pb.collection('name').delete(id);
```

### Real-time Subscriptions

PocketBase supports real-time updates via SSE, which pbtsdb automatically manages based on query lifecycle:

```typescript
// Subscriptions are automatic - just use useLiveQuery
const { data } = useLiveQuery((q) =>
  q.from({ jobs: jobsCollection })
);
// Subscription starts automatically when query becomes active
// Subscription stops automatically when component unmounts (with cleanup delay)
```

**Manual subscription control** (advanced use cases):
```typescript
// Manually subscribe to all changes
await jobsCollection.subscribe();

// Subscribe to specific record
await jobsCollection.subscribe('record_id_123');

// Check subscription status
const isSubscribed = jobsCollection.isSubscribed();

// Manually unsubscribe
jobsCollection.unsubscribe('record_id_123');
jobsCollection.unsubscribeAll();
```

**Subscription Lifecycle:**
- Collections are lazy by default - no network activity until queried
- Real-time subscriptions automatically start when first query becomes active
- Subscriptions automatically stop 5 seconds after last query unmounts (prevents thrashing)
- Multiple queries share a single subscription per collection (efficient)

## TanStack DB Integration Details

### Collection Creation

The `createCollection` function from `@tanstack/query-db-collection` bridges TanStack Query and TanStack DB:

```typescript
const collection = createCollection({
    queryClient,
    fetcher: async () => await pb.collection(name).getFullList(),
    getKey: (record: T) => record.id,
});
```

**Key Parameters:**
- `queryClient` - React Query client for caching
- `fetcher` - Async function that returns array of records
- `getKey` - Function to extract unique identifier from each record

### Reactivity

TanStack DB collections are reactive:
- Changes to QueryClient cache automatically update collection
- `useLiveQuery` hook provides reactive queries in React components
- Updates propagate automatically to all consumers

## Critical Reminders

### ⚠️ Type Safety
- **NEVER use `any` types** - Always define proper TypeScript interfaces
- **Keep schemas synchronized** - Update `test/schema.ts` when PocketBase schema changes
- **Use generic constraints** - Ensure schema extends `SchemaDeclaration`
- **Run typecheck** - Use `npm run typecheck` before committing

### ⚠️ Testing
- **Write integration tests** - Test against real PocketBase instance
- **Maintain coverage** - Add tests for new features
- **Run tests before commit** - Use `npm test` to ensure nothing breaks
- **Environment setup** - Ensure `.env` has correct PocketBase connection details

### ⚠️ Code Quality
- **Follow Biome rules** - Run `npm run lint:fix` before committing
- **No debug code** - Remove `console.log` statements
- **Organized imports** - Let Biome handle import sorting
- **Consistent formatting** - 4 spaces, 100 chars, single quotes

## Common Tasks

### Adding a New Collection

1. **Define the type** in `test/schema.ts`:
```typescript
interface NewCollectionRecord {
    id: string;
    name: string;
    // ... your custom fields
    created: string;
    updated: string;
}
```

2. **Add to schema declaration**:
```typescript
interface Schema extends SchemaDeclaration {
    new_collection: {
        Row: NewCollectionRecord;
        Relations: {
            forward: {
                // Add any relations here
            };
        };
    };
}
```

3. **Write integration test** in `test/collection.test.ts`:
```typescript
it('should fetch new_collection records', async () => {
    const collection = new CollectionFactory(pb, queryClient)
        .create<NewCollectionRecord, Schema>('new_collection');

    const records = await collection.getFullList();
    expect(records).toBeDefined();
});
```

4. **Run tests**: `npm test`

### Modifying CollectionFactory

1. Read `src/collection.ts` first
2. Understand the generic constraints
3. Make changes while preserving type safety
4. Update tests in `test/collection.test.ts`
5. Run `npm run checks && npm test`

## Project Commands

```bash
# Development
npm run typecheck     # TypeScript type checking
npm run lint          # Run Biome linter
npm run lint:fix      # Auto-fix linting issues
npm run checks        # Run typecheck + lint

# Testing
npm test              # Run Vitest tests

# Build (if added)
npm run build         # TypeScript compilation (not configured yet)
```

## Additional Resources

- **PocketBase Docs:** https://pocketbase.io/docs/
- **TanStack Query Docs:** https://tanstack.com/query/latest
- **TanStack DB Docs:** https://tanstack.com/db/latest
- **TypeScript Docs:** https://www.typescriptlang.org/docs/
- **Biome Docs:** https://biomejs.dev/

---

**Remember:** This is a library focused on type-safe integration between PocketBase and TanStack tools. Always maintain strict type safety, comprehensive testing, and clean code quality standards.
