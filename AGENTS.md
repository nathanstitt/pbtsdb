# pbtsdb: PocketBase TanStack Database Integration

## Project Overview

pbtsdb is a TypeScript library that integrates PocketBase (backend-as-a-service) with TanStack's reactive database and query management tools. It provides type-safe collection management with real-time data synchronization capabilities.

**Core Purpose:** Bridge PocketBase collections with TanStack DB's reactive collections while maintaining full TypeScript type safety.

## Prerequisites

Before working with pbtsdb, ensure the following are installed and configured:

### Required Dependencies
```bash
npm install pocketbase @tanstack/query-core @tanstack/react-query @tanstack/db @tanstack/query-db-collection @tanstack/react-db
```

### Runtime Requirements
- **Node.js 18+** - For async/await and ESM support
- **React 18+** - Required for hooks and reactive features (`useLiveQuery`)
- **TypeScript 5.0+** - For type safety and schema validation
- **PocketBase Server** - Running and accessible (local or remote)

### PocketBase Server Setup (Production)
1. PocketBase server must be running for your application
2. Collections created in PocketBase matching your TypeScript schema
3. Authentication configured if using auth features
4. Server URL accessible from your application

**For Testing:** Server auto-starts/stops via `npm test` - no manual setup required

### Development Environment
- **Biome** - Linter (configured in `biome.json`)
- **Vitest** - Test runner (configured in `vitest.config.ts`)

### Environment Variables (Optional)
Create a `.env` file in project root (tests use defaults if not provided):
```env
TESTING_PB_ADDR=http://127.0.0.1:8210  # Optional: Test server URL
TEST_USER_EMAIL=test@example.com        # Optional: Auto-created if missing
TEST_USER_PW=your_password_here         # Optional: Auto-created if missing
```

## When NOT to Use pbtsdb

This library may NOT be suitable if:

**1. Non-React Environments:**
- **Server-side only (no React)** → Use PocketBase SDK directly
- **Vue/Svelte/Angular applications** → Use TanStack Query adapters for those frameworks
- **Node.js backend services** → Use PocketBase SDK for server-side operations

**2. Simple CRUD Without Real-time:**
- If you don't need reactive updates → PocketBase SDK alone is simpler
- One-time data fetches → Standard `fetch()` or `axios` calls suffice
- Background jobs or cron tasks → Direct PocketBase SDK calls

**3. Very Large Collections:**
- Collections with 10,000+ records → Use pagination with `getList()`, not `getFullList()`
- In-memory limitations → Consider PocketBase pagination or server-side filtering
- Performance-critical applications → Evaluate memory usage of full collection caching

**4. Complex Server-Side Joins:**
- If PocketBase expand is insufficient → Create database views or use separate backend
- Multi-level nested relations → Consider denormalizing data or using GraphQL
- Aggregations and computed fields → Better handled on backend

**5. Non-PocketBase Backends:**
- This library is PocketBase-specific and tightly coupled to PocketBase API
- For Firebase, Supabase, or other backends → Use TanStack Query directly
- For REST APIs → Use standard TanStack Query hooks

**When to use pbtsdb:**
- ✅ React applications needing real-time PocketBase data
- ✅ Type-safe PocketBase collection management
- ✅ Automatic subscription lifecycle management
- ✅ Small to medium collections (< 10,000 records)
- ✅ Client-side reactive state with PocketBase backend

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

### Understanding CollectionFactory vs Collection

**CollectionFactory** (class):
- Factory that creates Collection instances
- One instance per PocketBase + QueryClient pair
- Provides `.create()` method to instantiate collections
- Manages subscription lifecycle across all collections

**Collection** (type/instance):
- Reactive data structure returned by `factory.create()`
- Represents a single PocketBase collection (e.g., 'jobs', 'users')
- Provides query methods (`getFullList`, `subscribe`, etc.)
- Used with `useLiveQuery` for reactive data

**Example Workflow:**
```typescript
// Step 1: Create factory (ONCE per app)
const factory = new CollectionFactory(pb, queryClient);

// Step 2: Create collections (ONCE per collection type)
const jobsCollection = factory.create('jobs');     // Returns Collection<Jobs>
const usersCollection = factory.create('users');   // Returns Collection<Users>

// Step 3: Use collections in components (MANY times)
const { data } = useLiveQuery((q) => q.from({ jobs: jobsCollection }));
```

**IMPORTANT - Single Factory Pattern:**
```typescript
// ✅ GOOD: One factory, multiple collections
const factory = new CollectionFactory(pb, queryClient);
const jobs = factory.create('jobs');
const customers = factory.create('customers');
const users = factory.create('users');

// ❌ BAD: Multiple factories for same PocketBase instance
const factory1 = new CollectionFactory(pb, queryClient);
const jobs = factory1.create('jobs');
const factory2 = new CollectionFactory(pb, queryClient);  // Wasteful!
const customers = factory2.create('customers');
```

**Why?** Each factory manages its own subscription lifecycle. Multiple factories create duplicate SSE connections to the same PocketBase server, wasting resources and causing race conditions.

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
- **PocketBase test server auto-starts/stops** - No manual server management required
- **Database auto-resets** before each test run for consistent test environment

**Running Tests:**
```bash
npm test  # Automatically: resets DB → starts server → runs tests → stops server
```

The `npm test` command automatically:
1. Resets the test database to a clean state
2. Starts a PocketBase server on port 8210
3. Runs all Vitest tests
4. Stops the server when tests complete

**Environment Variables** (optional, `.env` file):
- `TESTING_PB_ADDR` - PocketBase server URL (default: http://127.0.0.1:8210)
- `TEST_USER_EMAIL` - Test user credentials (auto-created if not exists)
- `TEST_USER_PW` - Test user password (auto-created if not exists)

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

## Key Patterns and Best Practices

### Working with Schemas

**IMPORTANT:** Schema structure must match the format in `test/schema.ts` exactly.

**1. Define Collection Schema:**
```typescript
export type Schema = {
    collection_name: {
        type: CollectionRecord;     // The record type interface
        relations: {
            // Single relations (foreign keys)
            related_field: RelatedRecord;
            // Array relations (one-to-many)
            items?: ItemRecord[];
        };
    };
}
```

**Real Example from test/schema.ts:**
```typescript
export type Schema = {
    jobs: {
        type: Jobs;
        relations: {
            address?: Addresses;
            org?: Orgs;
            customer?: Customers;
            tags?: Tags[];
        };
    };
    customers: {
        type: Customers;
        relations: {
            org?: Orgs;
            address?: Addresses;
        };
    };
}
```

**2. Keep Schema Synchronized:**
- When the PocketBase database schema changes, manually update the corresponding TypeScript interfaces in `test/schema.ts`
- If using PocketBase SDK type generation tools, regenerate the type files after schema changes
- Run `npm test` to verify TypeScript types match PocketBase collection definitions
- Schema mismatches will cause TypeScript compilation errors or runtime type issues

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

// REACT REQUIRED: useLiveQuery is a React hook from @tanstack/react-db
// Your component must be wrapped in <QueryClientProvider> from @tanstack/react-query
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

// REACT REQUIRED: useLiveQuery is a React hook
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
   const jobs = collections.create('jobs', {
       expand: 'customer,address' as const
   });
   // TypeScript now knows: data[0].expand.customer and data[0].expand.address exist
   // Provides autocomplete for expanded fields
   // Type errors if you access data[0].expand.invalid_field

   // Using the collection:
   const { data } = useLiveQuery((q) => q.from({ jobs }));
   if (data[0]?.expand) {
       const name = data[0].expand.customer.name;  // ✅ TypeScript knows this exists
       const city = data[0].expand.address.city;   // ✅ Fully type-safe
   }

   // ❌ BAD: Type inference limited
   const jobs = collections.create('jobs', {
       expand: 'customer,address'  // TypeScript treats as generic string
   });
   // data[0].expand is typed as `Record<string, any>` - NO type safety!
   // No autocomplete, no type checking
   if (data[0]?.expand) {
       const name = data[0].expand.customer.name;  // ⚠️ No error even if wrong!
   }
   ```

   **Why it matters:** Without `as const`, TypeScript cannot map the expand string to your schema relations, resulting in `any` types which defeats the purpose of this type-safe library.

### Working with Collections

**1. Creating Collections:**
```typescript
const collection = new CollectionFactory(pb, queryClient)
    .create<RecordType, Schema>('collection_name');
```

**2. Fetching Data (Two Approaches):**

**Approach A: Using TanStack DB Collection (Recommended - Reactive)**
```typescript
// Reactive collection with automatic updates
const { data } = useLiveQuery((q) => q.from({ jobs: jobsCollection }));

// Or fetch once (non-reactive)
const records = await jobsCollection.getFullList();
```

**Approach B: Direct PocketBase Access (Advanced - Bypasses TanStack DB)**
```typescript
// Direct fetch - NOT reactive, bypasses TanStack DB cache
// Use ONLY when you need PocketBase-specific features not available in TanStack DB
const filtered = await pb.collection('jobs')
    .getFullList({
        filter: 'status = "ACTIVE"',  // PocketBase filter syntax
        sort: '-created',
        expand: 'customer,location'
    });
```

**When to use each:**
- ✅ **Use Approach A** for all UI data that should update reactively
- ⚠️ **Use Approach B** only for: one-time fetches, server-side operations, or PocketBase-specific filters

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

## Error Handling

### PocketBase API Errors

All PocketBase operations can throw errors. Handle them in your React components:

```typescript
const { data, error, isLoading } = useLiveQuery((q) =>
    q.from({ jobs: jobsCollection })
);

if (error) {
    // PocketBase errors include: authentication, network, validation
    console.error('Failed to fetch jobs:', error);
    return <div>Error loading jobs: {error.message}</div>;
}

if (isLoading) {
    return <div>Loading jobs...</div>;
}
```

### Common Error Scenarios

**1. Authentication Errors:**
```typescript
// Check authentication before operations
if (!pb.authStore.isValid) {
    // User not logged in or token expired
    await pb.collection('users').authWithPassword(email, password);
}

// Handle auth failure
try {
    const records = await jobsCollection.getFullList();
} catch (error) {
    if (error.status === 401 || error.status === 403) {
        // Redirect to login or refresh token
    }
}
```

**2. Network Errors:**
```typescript
// PocketBase server unreachable
try {
    const records = await jobsCollection.getFullList();
} catch (error) {
    if (error.isAbort) {
        // Request was cancelled
    } else if (!navigator.onLine) {
        // No internet connection - show offline indicator
    } else {
        // Server error - implement retry logic
    }
}
```

**3. Subscription Errors:**
```typescript
// SSE connection failures are handled automatically
// Subscriptions auto-retry with exponential backoff
// To check if subscription failed:
const isSubscribed = jobsCollection.isSubscribed();

if (!isSubscribed) {
    // Subscription not active - data won't update in real-time
    // Queries still work (non-reactive fallback)
    // Manual retry if needed:
    await jobsCollection.subscribe().catch(err => {
        console.error('Failed to subscribe:', err);
    });
}
```

**4. Validation Errors:**
```typescript
// PocketBase returns validation errors for create/update
try {
    await pb.collection('jobs').create({
        name: 'New Job',
        status: 'INVALID_STATUS' // Will fail validation
    });
} catch (error) {
    if (error.data) {
        // error.data contains field-level validation errors
        console.error('Validation errors:', error.data);
        // { status: { code: 'invalid', message: 'Invalid status value' } }
    }
}
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

**Subscription Lifecycle (Detailed):**

**1. Lazy Initialization:**
- Collections created with `factory.create()` do NOT start subscriptions immediately
- No network activity occurs until the first React component calls `useLiveQuery` with the collection

**2. Automatic Start:**
- When the FIRST React component renders with `useLiveQuery` using a collection
- The collection connects to PocketBase via Server-Sent Events (SSE)
- On success: Real-time updates begin flowing to the collection
- On failure: Error is logged, and the system retries connection with exponential backoff (1s, 2s, 4s, up to 5 attempts)

**3. Shared Subscriptions (Efficiency):**
- Multiple `useLiveQuery` calls share ONE subscription per collection
- Subscription remains active while ANY component uses it
- No duplicate connections are created

**4. Automatic Stop with Delayed Cleanup:**
- When the LAST component unmounts (no more active `useLiveQuery` subscribers)
- System waits 5 seconds before disconnecting (prevents reconnection thrashing)
- If a new subscriber appears within 5 seconds, the connection stays alive
- After 5 seconds with zero subscribers: SSE connection closes automatically

**5. Checking Subscription Status:**
```typescript
// Check if collection is currently subscribed
const isLive = jobsCollection.isSubscribed();

// Wait for subscription to be ready (useful for tests)
await jobsCollection.waitForSubscription(undefined, 5000); // 5s timeout
```

**6. Error Handling:**
- Subscription failures are logged automatically
- Reconnection attempts use exponential backoff (configurable in `SUBSCRIPTION_CONFIG`)
- After max attempts (default: 5), subscription stops trying but queries still work (non-reactive)
- To force reconnect: Call `collection.subscribe()` manually

**7. Manual Override (Advanced Use Cases):**
```typescript
// Force subscription (bypasses automatic lifecycle)
await jobsCollection.subscribe();

// Force subscribe to specific record only
await jobsCollection.subscribe('record_id_123');

// Must manually cleanup if you manually subscribe
jobsCollection.unsubscribeAll();
```

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
- **Run lint and typecheck** - Use `npm run checks` before committing

### ⚠️ Testing
- **Write integration tests** - Test against real PocketBase instance (auto-started by `npm test`)
- **Maintain coverage** - Add tests for new features
- **Run tests before commit** - Use `npm test` (auto-resets DB, starts server, runs tests, stops server)
- **No manual server setup** - Test infrastructure is fully automated

### ⚠️ Code Quality
- **Follow Biome rules** - Run `npm run lint:fix` before committing
- **No debug code** - Remove `console.log` statements
- **Organized imports** - Let Biome handle import sorting
- **Consistent formatting** - 4 spaces, 100 chars, single quotes

### ⚠️ Comments (LLM-Specific Guidance)
**CRITICAL for AI Assistants:** Code should be self-documenting. Reserve comments for critical or hard-to-understand situations only, and keep them brief. Explain WHY, not WHAT. Avoid obvious comments like section headers or restating what code does. Prefer clear variable/function names over explanatory comments.

### ⚠️ Documentation
- **Update llms.txt after significant changes** - When adding new features, changing APIs, or modifying core patterns, update `llms.txt` to reflect these changes
- **Keep llms.txt concise** - Focus on essential patterns, new APIs, and critical concepts
- **Update examples** - Ensure code examples in llms.txt match current API and best practices
- **Significant changes include:** New hooks, changed function signatures, new patterns, API breaking changes, or major feature additions

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
