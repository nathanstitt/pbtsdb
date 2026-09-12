# Test Suite Organization

This directory contains the test suite for pbtsdb, organized by testing concern for better maintainability and clarity.

## Test Files

### Core Test Suites

#### `collection-basic.test.ts` (3 tests)
Basic collection operations and creation.

**Tests:**
- Fetching jobs using PocketBase API directly
- Fetching jobs using TanStack DB collection
- Type-safe relations configuration

**Use this file for:**
- Tests of fundamental collection creation and fetching
- Basic API surface validation
- Type safety verification

---

#### `collection-queries.test.ts` (10 tests)
Query operators and filtering capabilities.

**Tests:**
- Equality operator (`eq`)
- Comparison operators (`gt`, `gte`, `lt`, `lte`)
- Logical operators (`and`, `or`)
- Sorting (`orderBy`)
- Complex nested queries
- Unsupported operator error handling

**Use this file for:**
- Adding new query operator tests
- Testing query combinations
- Validating filter behavior

---

#### `collection-relations.test.ts` (3 tests)
Relationship handling and data expansion.

**Tests:**
- Manual joins using TanStack DB join API
- Type-safe PocketBase expand feature
- Filtering on relation fields

**Use this file for:**
- Testing join operations
- Validating expand functionality
- Relation-based filtering tests

---

#### `collection-subscriptions.test.ts` (11 tests)
Real-time subscription and live data updates.

**Tests:**
- Automatic subscription on collection creation
- Create/update/delete event handling
- Specific record subscriptions
- Subscription lifecycle (subscribe/unsubscribe)
- Batch update handling
- Subscription opt-out functionality

**Use this file for:**
- Real-time update tests
- Subscription management tests
- WebSocket/SSE integration tests

---

#### `expand-views.test.tsx`
Per-query expand views, nested paths, shared-store coherence, eager refetch, realtime expand.

---

#### `expand-helpers.test.ts`
Pure helpers for expand paths and expand merging.

---

#### `tanstack-internals.test.ts`
Pins the two undocumented TanStack DB behaviours per-query expand relies on. If this fails after an upgrade, read the assertion message before touching anything else.

---

### Supporting Files

#### `helpers.ts`
Shared test utilities and helper functions.

**Exports:**
- `pb` - Configured PocketBase instance
- `createTestQueryClient()` - Factory for QueryClient instances
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
  - One-to-one with BookMetadata via unique constraint
- **Purpose**: Demonstrates one-to-many relationships

#### BookMetadata (One-to-One)
- **Fields**: book, summary, genre, language, rating
- **Relations**: `book` → Books (unique constraint ensures one-to-one)
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
