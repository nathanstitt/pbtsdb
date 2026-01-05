import { renderHook, waitFor } from '@testing-library/react';
import { eq, useLiveQuery } from '@tanstack/react-db';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';

import { createCollection } from '../src/collection';
import { createReactProvider } from '../src/react';
import type { Schema } from './schema';
import {
    pb,
    createTestQueryClient,
    authenticateTestUser,
    clearAuth,
    createTestLogger,
    setLogger,
    resetLogger,
    waitForLoadFinish,
} from './helpers';

describe('Per-Collection Expand Feature', () => {
    let queryClient: QueryClient;
    const testLogger = createTestLogger();

    beforeAll(async () => {
        await authenticateTestUser();
        setLogger(testLogger);
    });

    afterAll(() => {
        clearAuth();
        resetLogger();
    });

    beforeEach(() => {
        queryClient = createTestQueryClient();
        testLogger.clear();
    });

    afterEach(() => {
        queryClient.clear();
    });

    describe('createCollection() with expand config', () => {
        it('should create collection with expand config', () => {
            const authorsCollection = createCollection<Schema>(pb, queryClient)('authors', {});
            const booksCollection = createCollection<Schema>(pb, queryClient)('books', {
                expand: {
                    author: authorsCollection
                }
            });

            expect(booksCollection).toBeDefined();
        });

        it('should create collection without expand config', () => {
            const booksCollection = createCollection<Schema>(pb, queryClient)('books', {});
            expect(booksCollection).toBeDefined();
        });
    });

    describe('Auto-expand with single relation', () => {
        it('should auto-expand configured relations', async () => {
            const authorsCollection = createCollection<Schema>(pb, queryClient)('authors', { syncMode: 'on-demand' });
            const booksCollection = createCollection<Schema>(pb, queryClient)('books', {
                syncMode: 'on-demand',
                expand: {
                    author: authorsCollection,
                }
            });

            const { result } = renderHook(
                () => {
                    return useLiveQuery((q) => q
                        .from({ books: booksCollection })
                        .where(({ books }) => eq(books.title, 'Animal Farm'))
                    )
                },
                { wrapper: ({ children }) => <>{children}</> }
            );

            await waitFor(
                () => {
                    expect(result.current.isLoading).toBe(false);
                    expect(result.current.data.length).toBeGreaterThan(0);
                },
                { timeout: 10000 }
            );

            const books = result.current.data;
            expect(books).toBeDefined();
            if (!books) throw new Error('no books?');

            const firstBook = books[0];
            expect(firstBook.expand).toBeDefined();
            if (!firstBook) throw new Error('no book');

            expect(firstBook.expand?.author).toBeDefined();

            // Key part: expanded data should also be upserted into authors collection
            const authors = Array.from(authorsCollection.values());
            expect(authors.length).toBe(1);
            expect(authors[0]).toBe(firstBook.expand!.author);
        }, 15000);

        it('should type expanded fields correctly', async () => {
            const authorsCollection = createCollection<Schema>(pb, queryClient)('authors', {});
            const booksCollection = createCollection<Schema>(pb, queryClient)('books', {
                expand: {
                    author: authorsCollection
                }
            });

            const { result } = renderHook(
                () => useLiveQuery((q) => q.from({ books: booksCollection })),
                { wrapper: ({ children }) => <>{children}</> }
            );

            await waitForLoadFinish(result, 10000);

            const books = result.current.data;
            if (books && books[0]) {
                const authorName: string | undefined = books[0].expand?.author?.name;
                expect(authorName).toBeTypeOf('string');
            }
        }, 15000);
    });

    describe('Collection without expand config', () => {
        it('should not include expand when no expand config', async () => {
            const booksCollection = createCollection<Schema>(pb, queryClient)('books', {
                syncMode: 'eager',
            });

            const { result } = renderHook(
                () => useLiveQuery((q) => q.from({ books: booksCollection })),
                { wrapper: ({ children }) => <>{children}</> }
            );

            await waitForLoadFinish(result, 10000);

            const books = result.current.data;
            expect(books).toBeDefined();
            expect(books!.length).toBeGreaterThan(0);

            // Without expand config, records should not have expand property
            const firstBook = books![0];
            expect(firstBook.title).toBeDefined();
            expect(firstBook.author).toBeTypeOf('string');
            // expand should be undefined since no expand config was set
            expect((firstBook as any).expand).toBeUndefined();
        }, 15000);
    });

    describe('React Integration with createReactProvider', () => {
        it('should work with useStore and auto-expand', async () => {
            const c = createCollection<Schema>(pb, queryClient);
            const authorsStore = c('authors', { syncMode: 'on-demand' });
            const booksStore = c('books', {
                syncMode: 'eager',
                expand: {
                    author: authorsStore,
                }
            });

            const { Provider, useStore } = createReactProvider({ authors: authorsStore, books: booksStore });

            const { result } = renderHook(
                () => {
                    const [booksCollection] = useStore('books');
                    return useLiveQuery((q) => q.from({ books: booksCollection }));
                },
                { wrapper: ({ children }) => <Provider>{children}</Provider> }
            );

            await waitFor(
                () => {
                    expect(result.current.isLoading).toBe(false);
                    expect(result.current.data).toBeDefined();
                    expect(result.current.data!.length).toBeGreaterThan(0);
                    expect(result.current.data![0].expand?.author).toBeDefined();
                },
                { timeout: 10000 }
            );
        }, 15000);
    });
});
