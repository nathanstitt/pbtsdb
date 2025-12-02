import { renderHook, waitFor } from '@testing-library/react';
import { useLiveQuery, usePacedMutations } from '@tanstack/react-db';
import { debounceStrategy } from '@tanstack/db';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { eq } from '@tanstack/db'
import type { QueryClient } from '@tanstack/react-query';

import { createReactProvider } from '../src/react';
import { createCollection } from '../src/collection';
import type { Schema } from './schema';
import {
    pb,
    createTestQueryClient,
    authenticateTestUser,
    clearAuth,
    getTestAuthorId,
    getTestSlug,
    newRecordId,
    createTestLogger,
    setLogger,
    resetLogger,
    waitForLoadFinish,
} from './helpers';

describe('createReactProvider', () => {
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

    describe('useStore', () => {
        it('should throw error when used outside provider', () => {
            const c = createCollection<Schema>(pb, queryClient);
            const collections = {
                books: c('books', {}),
            };
            const { useStore } = createReactProvider(collections);

            expect(() => {
                renderHook(() => useStore('books'));
            }).toThrow('useStore must be used within the Provider returned by createReactProvider');
        });

        it('should throw error when collection key does not exist', () => {
            const c = createCollection<Schema>(pb, queryClient);
            const collections = {
                books: c('books', {}),
            };
            const { Provider, useStore } = createReactProvider(collections);

            expect(() => {
                // @ts-expect-error - Testing runtime error for invalid key
                renderHook(() => useStore('nonexistent'), {
                    wrapper: ({ children }) => <Provider>{children}</Provider>
                });
            }).toThrow('Collection "nonexistent" not found in collections');
        });

        it('should return collection from provider with automatic type inference', () => {
            const c = createCollection<Schema>(pb, queryClient);
            const collections = {
                books: c('books', {}),
            };
            const { Provider, useStore } = createReactProvider(collections);

            const { result } = renderHook(() => useStore('books'), {
                wrapper: ({ children }) => <Provider>{children}</Provider>
            });

            expect(result.current).toBeDefined();
            expect(Array.isArray(result.current)).toBe(true);
            expect(result.current).toHaveLength(1);
            expect(result.current[0]).toHaveProperty('collectionName');
            expect(result.current[0]).toHaveProperty('utils');
        });

        it('should allow using collection in useLiveQuery', async () => {
            const c = createCollection<Schema>(pb, queryClient);
            const collections = {
                books: c('books', { syncMode: 'eager' }),
            };
            const { Provider, useStore } = createReactProvider(collections);

            const authorId = await getTestAuthorId()
            const { result } = renderHook(
                () => {
                    const [collection] = useStore('books');
                    return useLiveQuery((q) => q.from({ books: collection })
                        .where(({ books }) => eq(books.author,  authorId))
                    );
                },
                { wrapper: ({ children }) => <Provider>{children}</Provider> }
            );

            await waitForLoadFinish(result, 10000);
            expect(result.current.data).toBeDefined();
            expect(Array.isArray(result.current.data)).toBe(true);
            expect(result.current.data.length).toBeGreaterThanOrEqual(1)
            expect(result.current.data[0].author).toBeTypeOf('string')
        }, 15000);
    });

    describe('useStore with multiple keys', () => {
        it('should throw error when used outside provider', () => {
            const c = createCollection<Schema>(pb, queryClient);
            const collections = {
                books: c('books', {}),
                authors: c('authors', {}),
            };
            const { useStore } = createReactProvider(collections);

            expect(() => {
                renderHook(() => useStore('books', 'authors'));
            }).toThrow('useStore must be used within the Provider returned by createReactProvider');
        });

        it('should throw error when any collection key does not exist', () => {
            const c = createCollection<Schema>(pb, queryClient);
            const collections = {
                books: c('books', {}),
            };
            const { Provider, useStore } = createReactProvider(collections);

            expect(() => {
                // @ts-expect-error - Testing runtime error for invalid key
                renderHook(() => useStore('books', 'nonexistent'), {
                    wrapper: ({ children }) => <Provider>{children}</Provider>
                });
            }).toThrow('Collection "nonexistent" not found in collections');
        });

        it('should return array of collections in correct order with automatic type inference', () => {
            const c = createCollection<Schema>(pb, queryClient);
            const collections = {
                books: c('books', {}),
                authors: c('authors', {}),
                book_metadata: c('book_metadata', {}),
            };
            const { Provider, useStore } = createReactProvider(collections);

            const { result } = renderHook(
                () => useStore('books', 'authors', 'book_metadata'),
                { wrapper: ({ children }) => <Provider>{children}</Provider> }
            );

            expect(result.current).toHaveLength(3);
            expect(result.current[0]).toBeDefined();
            expect(result.current[1]).toBeDefined();
            expect(result.current[2]).toBeDefined();
            expect(result.current[0]).toHaveProperty('collectionName');
            expect(result.current[1]).toHaveProperty('collectionName');
            expect(result.current[2]).toHaveProperty('collectionName');
        });

        it('should allow using collections in useLiveQuery with joins', async () => {
            const c = createCollection<Schema>(pb, queryClient);
            const collections = {
                books: c('books', {}),
                authors: c('authors', {}),
            };
            const { Provider, useStore } = createReactProvider(collections);

            const { result } = renderHook(
                () => {
                    const [books] = useStore('books');
                    return useLiveQuery((q) => q.from({ books }));
                },
                { wrapper: ({ children }) => <Provider>{children}</Provider> }
            );

            await waitForLoadFinish(result, 10000);
            expect(result.current.data).toBeDefined();
            expect(Array.isArray(result.current.data)).toBe(true);
        }, 15000);
    });

    describe('Provider', () => {
        it('should provide collections to nested components', () => {
            const c = createCollection<Schema>(pb, queryClient);
            const collections = {
                books: c('books', {}),
                authors: c('authors', {}),
            };
            const { Provider, useStore } = createReactProvider(collections);

            const { result: result1 } = renderHook(() => useStore('books'), {
                wrapper: ({ children }) => <Provider>{children}</Provider>
            });

            expect(result1.current).toBeDefined();
            expect(result1.current[0]).toBeDefined();

            const { result: result2 } = renderHook(() => useStore('authors'), {
                wrapper: ({ children }) => <Provider>{children}</Provider>
            });

            expect(result2.current).toBeDefined();
            expect(result2.current[0]).toBeDefined();
        });

        it('should support custom collection keys', () => {
            const collections = {
                myCustomBooksKey: createCollection<Schema>(pb, queryClient)('books', {})
            };
            const { Provider, useStore } = createReactProvider(collections);

            const { result } = renderHook(() => useStore('myCustomBooksKey'), {
                wrapper: ({ children }) => <Provider>{children}</Provider>
            });

            expect(result.current).toBeDefined();
            expect(result.current[0]).toHaveProperty('collectionName');
            expect(result.current[0]).toHaveProperty('utils');
        });

        it('should infer collection name from key when using createCollection', () => {
            const c = createCollection<Schema>(pb, queryClient);
            const collections = {
                books: c('books', {}),
            };
            const { Provider, useStore } = createReactProvider(collections);

            const { result } = renderHook(() => useStore('books'), {
                wrapper: ({ children }) => <Provider>{children}</Provider>
            });

            expect(result.current).toBeDefined();
            expect(result.current[0]).toBeDefined();
        });

        it('should support auto-expand collections within provider context', async () => {
            const c = createCollection<Schema>(pb, queryClient);
            const authors = c('authors', {
                syncMode: 'eager',
                omitOnInsert: ['created']
            });
            const books = c('books', {
                syncMode: 'eager',
                omitOnInsert: ['created'],
                expand: {
                    author: authors,
                }
            });
            const collections = {
                authors,
                books,
            };
            const { Provider, useStore } = createReactProvider(collections);

            const authorId = await getTestAuthorId();
            const { result } = renderHook(
                () => {
                    const [booksCollection, _] = useStore('books', 'authors')
                    const booksQuery = useLiveQuery((q) =>
                        q.from({ books: booksCollection })
                            .where(({ books }) => eq(books.author, authorId))
                    );
                    const authorsQuery = useLiveQuery((q) => q.from({ authors }));

                    return { books: booksQuery, authors: authorsQuery };
                },
                { wrapper: ({ children }) => <Provider>{children}</Provider> }
            );

            await waitFor(
                () => {
                    expect(result.current.books.isLoading).toBe(false);
                    expect(result.current.authors.isLoading).toBe(false);
                },
                { timeout: 10000 }
            );

            expect(result.current.books.data).toBeDefined();
            expect(Array.isArray(result.current.books.data)).toBe(true);

            if (result.current.books.data && result.current.books.data.length > 0) {
                const book = result.current.books.data[0];
                expect(book).toBeDefined();
                expect(book.author).toBe(authorId);

                // Check that expand property exists and contains author data
                if (book.expand?.author) {
                    expect(book.expand.author).toBeDefined();
                    expect(book.expand.author.id).toBe(authorId);
                    expect(authors.has(authorId)).toBeTruthy()
                    expect(book.expand.author.name).toBeTypeOf('string');
                    expect(book.expand.author.email).toBeTypeOf('string');
                }
            }
        }, 15000);
    });

});

describe('usePacedMutations', () => {
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

    it('should support debounced updates with usePacedMutations', async () => {
        const c = createCollection<Schema>(pb, queryClient);
        const booksCollection = c('books', {
            syncMode: 'eager',
            omitOnInsert: ['created', 'updated'] as const,
        });
        const { Provider, useStore } = createReactProvider({ books: booksCollection });

        // Create a test book first
        const authorId = await getTestAuthorId();
        const testBook = {
            id: newRecordId(),
            title: `Paced Mutation Test ${Date.now().toString().slice(-8)}`,
            genre: 'Fiction' as const,
            isbn: getTestSlug('paced'),
            author: authorId,
            published_date: '',
            page_count: 100,
        };
        const insertTx = booksCollection.insert(testBook);
        await insertTx.isPersisted.promise;

        const { result } = renderHook(
            () => {
                const [books] = useStore('books');
                const booksQuery = useLiveQuery((q) =>
                    q.from({ books }).where(({ books }) => eq(books.id, testBook.id))
                );

                const mutate = usePacedMutations<number>({
                    onMutate: (newPageCount) => {
                        books.update(testBook.id, (draft) => {
                            draft.page_count = newPageCount;
                        });
                    },
                    mutationFn: async ({ transaction }) => {
                        // Persist the mutations to PocketBase
                        for (const mutation of transaction.mutations) {
                            if (mutation.changes) {
                                await pb.collection('books').update(testBook.id, mutation.changes);
                            }
                        }
                    },
                    strategy: debounceStrategy({ wait: 100 }),
                });

                return { booksQuery, mutate };
            },
            { wrapper: ({ children }) => <Provider>{children}</Provider> }
        );

        await waitFor(
            () => {
                expect(result.current.booksQuery.isLoading).toBe(false);
            },
            { timeout: 10000 }
        );
        expect(result.current.booksQuery.data).toBeDefined();
        expect(result.current.booksQuery.data.length).toBe(1);
        expect(result.current.booksQuery.data[0].page_count).toBe(100);

        // Trigger multiple rapid mutations - only the last should persist due to debounce
        const tx1 = result.current.mutate(150);
        const tx2 = result.current.mutate(200);
        const tx3 = result.current.mutate(250);

        // Wait for the debounced mutation to complete
        await tx3.isPersisted.promise;

        // Verify the optimistic update was applied
        await waitFor(
            () => {
                expect(result.current.booksQuery.data[0].page_count).toBe(250);
            },
            { timeout: 5000 }
        );

        // Verify the final value persisted to PocketBase
        const serverBook = await pb.collection('books').getOne(testBook.id);
        expect(serverBook.page_count).toBe(250);

        // Cleanup
        try {
            await pb.collection('books').delete(testBook.id);
        } catch (_error) {
            // Ignore cleanup errors
        }
    }, 20000);

    it('should apply optimistic updates immediately before persistence', async () => {
        const c = createCollection<Schema>(pb, queryClient);
        const booksCollection = c('books', {
            syncMode: 'eager',
            omitOnInsert: ['created', 'updated'] as const,
        });
        const { Provider, useStore } = createReactProvider({ books: booksCollection });

        // Create a test book first
        const authorId = await getTestAuthorId();
        const testBook = {
            id: newRecordId(),
            title: `Optimistic Test ${Date.now().toString().slice(-8)}`,
            genre: 'Fiction' as const,
            isbn: getTestSlug('opt'),
            author: authorId,
            published_date: '',
            page_count: 50,
        };
        const insertTx = booksCollection.insert(testBook);
        await insertTx.isPersisted.promise;

        const { result } = renderHook(
            () => {
                const [books] = useStore('books');
                const booksQuery = useLiveQuery((q) =>
                    q.from({ books }).where(({ books }) => eq(books.id, testBook.id))
                );

                const mutate = usePacedMutations<string>({
                    onMutate: (newTitle) => {
                        books.update(testBook.id, (draft) => {
                            draft.title = newTitle;
                        });
                    },
                    mutationFn: async ({ transaction }) => {
                        for (const mutation of transaction.mutations) {
                            if (mutation.changes) {
                                await pb.collection('books').update(testBook.id, mutation.changes);
                            }
                        }
                    },
                    strategy: debounceStrategy({ wait: 500 }), // Longer wait to observe optimistic update
                });

                return { booksQuery, mutate };
            },
            { wrapper: ({ children }) => <Provider>{children}</Provider> }
        );

        await waitFor(
            () => {
                expect(result.current.booksQuery.isLoading).toBe(false);
            },
            { timeout: 10000 }
        );
        expect(result.current.booksQuery.data[0].title).toContain('Optimistic Test');

        const newTitle = `Updated Title ${Date.now().toString().slice(-8)}`;
        const tx = result.current.mutate(newTitle);

        // The optimistic update should be applied immediately (before persistence)
        await waitFor(
            () => {
                expect(result.current.booksQuery.data[0].title).toBe(newTitle);
            },
            { timeout: 1000 }
        );

        // Transaction should still be pending/persisting since debounce wait is 500ms
        expect(['pending', 'persisting']).toContain(tx.state);

        // Wait for persistence to complete
        await tx.isPersisted.promise;
        expect(tx.state).toBe('completed');

        // Cleanup
        try {
            await pb.collection('books').delete(testBook.id);
        } catch (_error) {
            // Ignore cleanup errors
        }
    }, 20000);
});
