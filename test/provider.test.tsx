import React, { type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { useLiveQuery } from '@tanstack/react-db';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';

import type { QueryClient } from '@tanstack/react-query';

import { CollectionsProvider, useStore, useStores } from '../src/provider';
import type { BooksRecord, AuthorsRecord, BookMetadataRecord } from './schema';
import { pb, createTestQueryClient, authenticateTestUser, clearAuth, createCollectionFactory } from './helpers';

describe('CollectionsProvider and Hooks', () => {
    let queryClient: QueryClient;

    beforeAll(async () => {
        await authenticateTestUser();
    });

    afterAll(() => {
        clearAuth();
    });

    beforeEach(() => {
        queryClient = createTestQueryClient();
    });

    afterEach(() => {
        queryClient.clear();
    });

    describe('useStore', () => {
        it('should throw error when used outside provider', () => {
            // renderHook will catch the error in result.error on first render
            expect(() => {
                renderHook(() => useStore('books'));
            }).toThrow('useStore must be used within a CollectionsProvider');
        });

        it('should throw error when collection key does not exist', () => {
            const factory = createCollectionFactory(queryClient);
            const stores = {
                books: factory.create('books', { enableSubscriptions: false }),
            };

            const wrapper = ({ children }: { children: ReactNode }) => (
                <CollectionsProvider collections={stores}>{children}</CollectionsProvider>
            );

            expect(() => {
                renderHook(() => useStore('nonexistent'), { wrapper });
            }).toThrow('Collection "nonexistent" not found in CollectionsProvider');
        });

        it('should return collection from provider', () => {
            const factory = createCollectionFactory(queryClient);
            const booksCollection = factory.create('books', { enableSubscriptions: false });

            const stores = {
                books: booksCollection,
            };

            const wrapper = ({ children }: { children: ReactNode }) => (
                <CollectionsProvider collections={stores}>{children}</CollectionsProvider>
            );

            const { result } = renderHook(() => useStore<BooksRecord>('books'), { wrapper });

            expect(result.current).toBe(booksCollection);
        });

        it('should allow using collection in useLiveQuery', async () => {
            const factory = createCollectionFactory(queryClient);
            const booksCollection = factory.create('books', { enableSubscriptions: false });

            const stores = {
                books: booksCollection,
            };

            const wrapper = ({ children }: { children: ReactNode }) => (
                <CollectionsProvider collections={stores}>{children}</CollectionsProvider>
            );

            const { result } = renderHook(
                () => {
                    const collection = useStore<BooksRecord>('books');
                    return useLiveQuery((q) => q.from({ books: collection }));
                },
                { wrapper }
            );

            // Wait for data to load
            await waitFor(
                () => {
                    expect(result.current.isLoading).toBe(false);
                },
                { timeout: 10000 }
            );

            expect(result.current.data).toBeDefined();
            expect(Array.isArray(result.current.data)).toBe(true);
        }, 15000);
    });

    describe('useStores', () => {
        it('should throw error when used outside provider', () => {
            expect(() => {
                renderHook(() => useStores(['books', 'authors']));
            }).toThrow('useStores must be used within a CollectionsProvider');
        });

        it('should throw error when any collection key does not exist', () => {
            const factory = createCollectionFactory(queryClient);
            const stores = {
                books: factory.create('books', { enableSubscriptions: false }),
            };

            const wrapper = ({ children }: { children: ReactNode }) => (
                <CollectionsProvider collections={stores}>{children}</CollectionsProvider>
            );

            expect(() => {
                renderHook(() => useStores(['books', 'nonexistent']), { wrapper });
            }).toThrow('Collection "nonexistent" not found in CollectionsProvider');
        });

        it('should return array of collections in correct order', () => {
            const factory = createCollectionFactory(queryClient);
            const booksCollection = factory.create('books', { enableSubscriptions: false });
            const authorsCollection = factory.create('authors', { enableSubscriptions: false });
            const metadataCollection = factory.create('book_metadata', { enableSubscriptions: false });

            const stores = {
                books: booksCollection,
                authors: authorsCollection,
                metadata: metadataCollection,
            };

            const wrapper = ({ children }: { children: ReactNode }) => (
                <CollectionsProvider collections={stores}>{children}</CollectionsProvider>
            );

            const { result } = renderHook(
                () => useStores<[BooksRecord, AuthorsRecord, BookMetadataRecord]>(
                    ['books', 'authors', 'metadata']
                ),
                { wrapper }
            );

            expect(result.current).toHaveLength(3);
            expect(result.current[0]).toBe(booksCollection);
            expect(result.current[1]).toBe(authorsCollection);
            expect(result.current[2]).toBe(metadataCollection);
        });

        it('should allow using collections in useLiveQuery with joins', async () => {
            const factory = createCollectionFactory(queryClient);
            const booksCollection = factory.create('books', { enableSubscriptions: false });
            const authorsCollection = factory.create('authors', { enableSubscriptions: false });

            const stores = {
                books: booksCollection,
                authors: authorsCollection,
            };

            const wrapper = ({ children }: { children: ReactNode }) => (
                <CollectionsProvider collections={stores}>{children}</CollectionsProvider>
            );

            const { result } = renderHook(
                () => {
                    const [books] = useStores<[BooksRecord]>(['books']);
                    return useLiveQuery((q) => q.from({ books }));
                },
                { wrapper }
            );

            // Wait for data to load
            await waitFor(
                () => {
                    expect(result.current.isLoading).toBe(false);
                },
                { timeout: 10000 }
            );

            expect(result.current.data).toBeDefined();
            expect(Array.isArray(result.current.data)).toBe(true);
        }, 15000);
    });

    describe('CollectionsProvider', () => {
        it('should provide collections to nested components', () => {
            const factory = createCollectionFactory(queryClient);
            const booksCollection = factory.create('books', { enableSubscriptions: false });
            const authorsCollection = factory.create('authors', { enableSubscriptions: false });

            const stores = {
                books: booksCollection,
                authors: authorsCollection,
            };

            const wrapper = ({ children }: { children: ReactNode }) => (
                <CollectionsProvider collections={stores}>{children}</CollectionsProvider>
            );

            const { result } = renderHook(() => useStore<BooksRecord>('books'), { wrapper });

            expect(result.current).toBe(booksCollection);

            const { result: result2 } = renderHook(() => useStore<AuthorsRecord>('authors'), {
                wrapper,
            });

            expect(result2.current).toBe(authorsCollection);
        });

        it('should support custom collection keys', () => {
            const factory = createCollectionFactory(queryClient);
            const booksCollection = factory.create('books', { enableSubscriptions: false });

            const stores = {
                myCustomBooksKey: booksCollection,
            };

            const wrapper = ({ children }: { children: ReactNode }) => (
                <CollectionsProvider collections={stores}>{children}</CollectionsProvider>
            );

            const { result } = renderHook(() => useStore<BooksRecord>('myCustomBooksKey'), { wrapper });

            expect(result.current).toBe(booksCollection);
        });
    });
});
