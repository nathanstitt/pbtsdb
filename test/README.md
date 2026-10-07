# Test Suite Organization

This directory contains the test suite for pbtsdb, organized by testing concern for better maintainability and clarity.

## Test Files

### Core Test Suites

#### `basic.test.ts`
Collection creation and fetching, and type-safe relations configuration.

---

#### `queries.test.ts`
Query operators: `eq`, `gt`, `gte`, `lt`, `lte`, `and`, `or`, `orderBy`, nested queries, and the unsupported-operator error.

---

#### `query-converter.test.ts`
Unit tests for the `where` and `orderBy` to PocketBase filter and sort conversion.

---

#### `server-side-filtering.test.ts`
On-demand sync mode: each query sends its own filter and sort to PocketBase.

---

#### `pagination.test.ts`
Full-list fetches past the default page size, and `limit` against on-demand collections.

---

#### `relation-filings.test.ts`
Filed relation rows follow their parent rows: a filed row leaves the target when the last parent row filing it leaves the store, when a parent echo no longer expands it, or when a delete arrives on the hold's realtime topic.

#### `held-targets.test.ts`
Per-parent-row filing bookkeeping: hold filters follow the current filings, a row is released when its last parent stops filing it, and a back-relation filter stays while the parent is filed.

#### `relations.test.ts`
Joins through the TanStack DB join API, `relations` and `alwaysFetchRelations`, and filtering on relation fields.

---

#### `includes.test.ts`
Subquery includes with `findOne()` and `toArray()`, and reading a filed relation through an include.

---

#### `mutations.test.ts`
Built-in insert, update, and delete handlers, `omitOnInsert`, an insert then a delete of one row, the write-back after a realtime echo, and the `refetchOnMutation` default.

---

#### `subscriptions.test.ts`
Realtime create, update, and delete events, several creates in quick succession, and subscription lifecycle tied to live queries.

---

#### `subscribe-options.test.ts`
The factory `subscribeOptions` callback: headers, filter, expand, and re-invocation on each subscribe.

---

#### `realtime-mode.test.ts`
The `realtime` option and `withRealtime` views: one subscription per query filter, filter ref counting, the topic-length cap and the widen-to-`'*'` fallback, and held targets subscribing to filed rows in query mode.

---

#### `realtime-delete-echo.test.ts`
A delete echo for a row already gone from the synced store is ignored.

---

#### `synced-store.test.ts`
Unit coverage for pbtsdb's sync-session writer against a fake session: insert versus update, copies, deletes of absent rows, the cache claim, and cancelling a failed transaction.

---

#### `sync-channel.test.ts`
Realtime rows are written through the sync session as copies, so a reused event record cannot change the stored row.

---

#### `settle-write-back.test.ts`
The built-in handlers land the server row before they settle, so the row never shows its previous value when TanStack DB drops the optimistic state.

---

#### `query-result-revert.test.ts`, `refetch-on-mutation-revert.test.ts`, `stale-absence-delete.test.ts`
Races between optimistic mutations, stale query results, and stale realtime echoes under on-demand sync. Each file names the race it pins.

---

#### `react.test.tsx`
`createReactProvider`, `Provider`, and `useStore`.

---

#### `fetch-relations.test.tsx`
Fetching and filing relations, stripping, views, held targets, keyed loads from the store.

**`loaded subsets`**: a back-relation subset (`book_tags_via_book`) served from
the store once the parent has filed it, one request when nothing filed it, a
plain base query does not mark the subset, a second child
(`book_metadata_via_book`), invalidation when a child row is pruned,
invalidation when the target's realtime subscription stops,
cleanup clearing every mark, a back-relation filed by a different parent
(`book_tags_via_tag`, from the tags collection), and a nested via path
(`book_tags_via_book.tag`, junction subset and its tags both served without
requests).

---

#### `keyed-where.test.ts`
Recognizing any single top-level field in `where` (`eq`, `in`, or an `or` of those) and turning it into a subset.

---

#### `expand-helpers.test.ts`
Path helpers, plus `parseViaKey` and `markFiledSubset`.

---

#### `core-sync-adapter.test.ts`
The core sync adapter end to end: a handler that calls `reload()`, `accept()` or `evict()` settles, a closed topic releases the rows only it held, and `reload()` evicts a topic-echoed row the server no longer returns.

#### `tanstack-assumptions.test.ts`
Pins the undocumented TanStack DB behaviour views rely on: the live query calls `subscribeChanges` on the object passed to `from()` and hands that subscription to `loadSubset`. If this fails after an upgrade, read the assertion message before touching anything else.

---

#### `expand-types.test.ts`
Type-level assertions for `relations`, `alwaysFetchRelations`, `fetchRelations()` views, and nested paths.

---

### Supporting Files

#### `helpers.ts`
Shared test utilities and helper functions.

**Exports:**
- `pb` - Configured PocketBase instance
- `authenticateTestUser()` - Test user authentication
- `clearAuth()` - Clear authentication state
- `getTestSlug(prefix)` - Generate unique test slugs
- `getCurrentOrg()` - Get authenticated user's organization

**When to update:**
- Adding new test utilities used across multiple files
- Extracting common test patterns
- Adding new helper functions for test data creation

---

#### `schema.ts`
TypeScript type definitions for PocketBase collections.

**Contains:**
- All collection record types
- Schema declarations for type safety
- Relation definitions

**When to update:**
- When PocketBase schema changes
- When adding new collections to tests
- When updating relation definitions

---

#### `setup.ts`
Test environment setup and global configuration.

**Contains:**
- EventSource polyfill for Node.js SSE support
- Global test environment configuration

**When to update:**
- Adding new global test setup
- Configuring test environment polyfills
- Global mock setup

---

## Running Tests

**Recommended (Fully Automated):**
```bash
npm test  # Resets DB → Starts server → Runs tests → Stops server
```

The `npm test` command automatically:
1. Resets the database and applies migrations
2. Creates/updates test superuser from `.env` credentials
3. Starts PocketBase server on port 8210
4. Waits for server health check
5. Runs all Vitest tests
6. Stops the server when complete

**Advanced Options:**
```bash
# Run specific test file
npm run test:run -- test-collections.test.ts

# Run with verbose output
npm run test:run -- --reporter=verbose

# Manual server control (for watch mode or debugging)
npm run test:server  # Start server manually
npm run test:run -- --watch  # In another terminal
```

## Test Organization Principles

1. **Separation of Concerns**: Each file tests a specific aspect of functionality
2. **Shared Utilities**: Common test helpers live in `helpers.ts`
3. **Type Safety**: All tests maintain strict TypeScript type checking
4. **Real Integration**: Tests use real PocketBase connections (not mocked)
5. **Cleanup**: Tests clean up after themselves (delete created records)

## Adding New Tests

When adding new tests, consider which file they belong in:

- **Basic operations** → `collection-basic.test.ts`
- **Query/filter logic** → `collection-queries.test.ts`
- **Joins/expand** → `collection-relations.test.ts`
- **Real-time features** → `collection-subscriptions.test.ts`

If a test doesn't fit existing categories, consider creating a new focused test file following the `collection-*.test.ts` naming pattern.

## Local PocketBase Test Server Setup

The test suite now includes a local PocketBase server with test collections and seed data. This eliminates the need for an external PocketBase instance.

### Quick Start

**Run tests** (everything is automated):
```bash
npm test
```

The `npm test` command uses `start-server-and-test` to automatically:
1. Reset the database and run migrations
2. Create/update the superuser from `.env` credentials
3. Start the PocketBase server on port 8210
4. Wait for the health check endpoint to respond
5. Run the test suite with Vitest
6. Shut down the server when tests complete

**Manual Control** (rarely needed - only for debugging or watch mode):
```bash
# Reset database only (no server start)
npm run db:reset

# Start server manually (for watch mode)
npm run test:server

# Run tests against manually-started server
npm run test:run
```

**Most users should just use `npm test` and let automation handle everything.**

### Test Server Script

The test server is managed by `scripts/start-test-server.sh`, which:
- Reads credentials from `.env` file
- Runs `npm run db:reset` to reset database and apply migrations
- Creates/updates a superuser using `pocketbase superuser create`
- Starts PocketBase server on the configured port

**Environment Variables Required:**
- `TEST_USER_EMAIL` - Superuser email (default: tester@test.com)
- `TEST_USER_PW` - Superuser password (default: PocketbaseTanstackDBPass123)
- `TESTING_PB_ADDR` - Server address (default: http://127.0.0.1:8210)

### Test Collections

The local server includes three interrelated test collections demonstrating different relationship patterns:

#### Authors (Base Collection)
- **Fields**: name, bio, email
- **Purpose**: Demonstrates base collection without relations

#### Books (One-to-Many & One-to-One)
- **Fields**: title, isbn, published_date, page_count, author
- **Relations**:
  - `author` → Authors (many books → one author)
  - One-to-one with BookMetadata by seed data (no unique index; PocketBase
    expands `book_metadata_via_book` as an array)
- **Purpose**: Demonstrates one-to-many relationships

#### BookMetadata (One-to-One)
- **Fields**: book, summary, genre, language, rating
- **Relations**: `book` → Books (one-to-one by seed data, not by index; the
  back-relation `book_metadata_via_book` expands as an array)
- **Purpose**: Demonstrates one-to-one relationships

#### TestTags (Many-to-Many Base)
- **Fields**: name, color
- **Purpose**: Tag collection for many-to-many demonstration

#### BookTags (Junction Collection)
- **Fields**: book, tag
- **Relations**:
  - `book` → Books
  - `tag` → TestTags
- **Purpose**: Junction table enabling many-to-many between Books and Tags

### Seed Data

The migrations include comprehensive seed data:
- **4 authors** (J.K. Rowling, George Orwell, Jane Austen, Isaac Asimov)
- **6 books** with proper ISBN numbers and publication dates
- **6 metadata records** (one per book with genre, summary, rating)
- **7 tags** (Magic, Adventure, Dystopian, Classic, Young Adult, Space Opera, Political)
- **15+ book-tag relationships** demonstrating many-to-many connections

### Migrations

Migrations are located in `pb_migrations/`:

1. **`1763864661_create_test_collections.js`** - Creates collection schemas
2. **`1763864662_seed_test_data.js`** - Populates test data

### Test Files

#### `test-collections.test.ts`
Comprehensive tests for the test collections demonstrating:
- Basic collection fetching
- One-to-many relationships (Books → Authors)
- One-to-one relationships (Books → BookMetadata)
- Many-to-many relationships (Books ↔ Tags via BookTags)
- Type-safe expand operations
- Complex relationship queries

### Environment Variables

Tests require these environment variables in `.env`:

```bash
TESTING_PB_ADDR=http://127.0.0.1:8210
TEST_USER_EMAIL=test@example.com
TEST_USER_PW=testpassword123
```

### Database Files

PocketBase database files are stored in `pb_data/` and are **excluded from git** (in `.gitignore`). This allows each developer to have their own local test database.

To reset your local database:
2. Delete the `pb_data/` directory
1. run: `npm run test:reset`
