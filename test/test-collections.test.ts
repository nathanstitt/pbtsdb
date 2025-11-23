import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';

import { pb, createTestQueryClient, authenticateTestUser, clearAuth } from './helpers';

describe('Test Collections - Relationship Testing', () => {
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

    describe('Authors Collection (Base Collection)', () => {
        it('should fetch authors from the database', async () => {
            const authors = await pb.collection('authors').getFullList();
            expect(authors).toBeDefined();
            expect(Array.isArray(authors)).toBe(true);
            expect(authors.length).toBeGreaterThan(0);
        });

        it('should have proper author fields', async () => {
            const authors = await pb.collection('authors').getFullList();
            const author = authors[0];
            expect(author).toHaveProperty('id');
            expect(author).toHaveProperty('name');
            expect(author).toHaveProperty('bio');
            expect(author).toHaveProperty('email');
            expect(author).toHaveProperty('created');
            expect(author).toHaveProperty('updated');
        });
    });

    describe('Books Collection (One-to-Many with Authors)', () => {
        it('should fetch books from the database', async () => {
            const books = await pb.collection('books').getFullList();
            expect(books).toBeDefined();
            expect(Array.isArray(books)).toBe(true);
            expect(books.length).toBeGreaterThan(0);
        });

        it('should have author relation field', async () => {
            const books = await pb.collection('books').getFullList();
            const book = books[0];

            expect(book).toHaveProperty('author');
            expect(typeof book.author).toBe('string'); // Should be author ID
        });

        it('should expand author relation', async () => {
            const books = await pb.collection('books').getFullList({
                expand: 'author'
            });
            const book = books[0];

            expect(book.expand?.author).toBeDefined();
            expect(book.expand?.author).toHaveProperty('name');
            expect(book.expand?.author).toHaveProperty('email');
        });
    });

    describe('Book Metadata Collection (One-to-One with Books)', () => {
        it('should fetch book metadata from the database', async () => {
            const metadata = await pb.collection('book_metadata').getFullList();
            expect(metadata).toBeDefined();
            expect(Array.isArray(metadata)).toBe(true);
            expect(metadata.length).toBeGreaterThan(0);
        });

        it('should have unique book relation', async () => {
            const metadata = await pb.collection('book_metadata').getFullList();

            // Check for unique book IDs (one-to-one constraint)
            const bookIds = metadata.map((m) => m.book);
            const uniqueBookIds = new Set(bookIds);
            expect(bookIds.length).toBe(uniqueBookIds.size);
        });

        it('should expand book relation', async () => {
            const metadata = await pb.collection('book_metadata').getFullList({
                expand: 'book'
            });
            const item = metadata[0];

            expect(item.expand?.book).toBeDefined();
            expect(item.expand?.book).toHaveProperty('title');
            expect(item.expand?.book).toHaveProperty('isbn');
        });
    });

    describe('Tags Collection (Many-to-Many via Junction)', () => {
        it('should fetch tags from the database', async () => {
            const tags = await pb.collection('tags').getFullList();
            expect(tags).toBeDefined();
            expect(Array.isArray(tags)).toBe(true);
            expect(tags.length).toBeGreaterThan(0);
        });

        it('should have proper tag fields', async () => {
            const tags = await pb.collection('tags').getFullList();
            const tag = tags[0];

            expect(tag).toHaveProperty('name');
            expect(tag).toHaveProperty('color');
        });
    });

    describe('Book Tags Junction Collection (Many-to-Many)', () => {
        it('should fetch book-tag relationships', async () => {
            const bookTags = await pb.collection('book_tags').getFullList();
            expect(bookTags).toBeDefined();
            expect(Array.isArray(bookTags)).toBe(true);
            expect(bookTags.length).toBeGreaterThan(0);
        });

        it('should have both book and tag relations', async () => {
            const bookTags = await pb.collection('book_tags').getFullList();
            const bookTag = bookTags[0];

            expect(bookTag).toHaveProperty('book');
            expect(bookTag).toHaveProperty('tag');
            expect(typeof bookTag.book).toBe('string');
            expect(typeof bookTag.tag).toBe('string');
        });

        it('should expand both book and tag relations', async () => {
            const bookTags = await pb.collection('book_tags').getFullList({
                expand: 'book,tag'
            });
            const bookTag = bookTags[0];

            expect(bookTag.expand?.book).toBeDefined();
            expect(bookTag.expand?.book).toHaveProperty('title');
            expect(bookTag.expand?.tag).toBeDefined();
            expect(bookTag.expand?.tag).toHaveProperty('name');
        });

        it('should verify many-to-many relationship integrity', async () => {
            const bookTags = await pb.collection('book_tags').getFullList();

            // Check that same book can have multiple tags
            const bookGrouped = bookTags.reduce((acc, bt) => {
                acc[bt.book] = (acc[bt.book] || 0) + 1;
                return acc;
            }, {} as Record<string, number>);

            const booksWithMultipleTags = Object.values(bookGrouped).filter((count) => count > 1);
            expect(booksWithMultipleTags.length).toBeGreaterThan(0);
        });
    });

    describe('Complex Relationship Queries', () => {
        it('should fetch books with all relations expanded', async () => {
            const books = await pb.collection('books').getFullList({
                expand: 'author'
            });
            expect(books.length).toBeGreaterThan(0);

            // Verify author expansion
            const bookWithAuthor = books.find((b) => b.expand?.author);
            expect(bookWithAuthor).toBeDefined();
            expect(bookWithAuthor?.expand?.author?.name).toBeDefined();
        });

        it('should query specific author and their books', async () => {
            // First get an author
            const authors = await pb.collection('authors').getFullList();
            const author = authors[0];

            // Then query books by that author
            const books = await pb.collection('books').getFullList({
                filter: `author = "${author.id}"`
            });

            expect(books.length).toBeGreaterThan(0);
            books.forEach((book) => {
                expect(book.author).toBe(author.id);
            });
        });

        it('should query book with metadata', async () => {
            const books = await pb.collection('books').getFullList();
            const book = books[0];

            // Query metadata for this book
            const metadata = await pb.collection('book_metadata').getFullList({
                filter: `book = "${book.id}"`
            });

            expect(metadata.length).toBe(1); // One-to-one relationship
            expect(metadata[0].book).toBe(book.id);
        });
    });
});
