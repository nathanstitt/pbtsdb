import type { WithoutVirtualProps } from '@tanstack/db'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { createCollection, materialize } from '../src'
import { createTestQueryClient, pb } from './helpers'
import type { Books, Schema } from './schema'

const c = createCollection<Schema>(pb, createTestQueryClient())

describe('fetch relations types', () => {
    it('never puts expand on a row', () => {
        const authors = c('authors', {})
        const books = c('books', {
            relations: { author: authors },
            alwaysFetchRelations: ['author'],
        })
        type Row = WithoutVirtualProps<NonNullable<ReturnType<typeof books.get>>>
        expectTypeOf<Row>().toEqualTypeOf<Books>()
        const view = books.fetchRelations('author')
        type ViewRow = WithoutVirtualProps<NonNullable<ReturnType<typeof view.get>>>
        expectTypeOf<ViewRow>().toEqualTypeOf<Books>()
    })

    it('rejects paths not declared in relations', () => {
        const authors = c('authors', {})
        expect(() =>
            // @ts-expect-error nope is not a declared relation
            c('books', { relations: { author: authors }, alwaysFetchRelations: ['nope'] })
        ).toThrow()
        expect(() =>
            // @ts-expect-error alwaysFetchRelations without relations
            c('books', { alwaysFetchRelations: ['author'] })
        ).toThrow()
        const books = c('books', { relations: { author: authors } })
        expect(() =>
            // @ts-expect-error nope is not a declared relation
            books.fetchRelations('nope')
        ).toThrow()
        const view = books.fetchRelations('author')
        expect(() =>
            // @ts-expect-error views are leaves
            view.fetchRelations('author')
        ).toThrow()
    })

    it('validates nested paths through the target collection', () => {
        const authors = c('authors', {})
        const books = c('books', { relations: { author: authors } })
        const metadata = c('book_metadata', { relations: { book: books } })
        metadata.fetchRelations('book.author')
        expect(() =>
            // @ts-expect-error nope is not a relation of books
            metadata.fetchRelations('book.nope')
        ).toThrow()
        const plainBooks = c('books', {})
        const plainMetadata = c('book_metadata', { relations: { book: plainBooks } })
        expect(() =>
            // @ts-expect-error books declares no relations
            plainMetadata.fetchRelations('book.author')
        ).toThrow()
    })

    it('keeps the insert type and helpers on views', () => {
        const authors = c('authors', {})
        const books = c('books', {
            relations: { author: authors },
            omitOnInsert: ['created', 'updated'],
        })
        const view = books.fetchRelations('author')
        expectTypeOf(view.collectionName).toEqualTypeOf<'books'>()
        expectTypeOf(view.waitForSubscription).toBeFunction()
        type Insert = Parameters<typeof view.insert>[0]
        expectTypeOf<Insert>().toMatchTypeOf<
            Omit<Books, 'created' | 'updated'> | Omit<Books, 'created' | 'updated'>[]
        >()
    })

    it('re-exports materialize', () => {
        expectTypeOf(materialize).toBeFunction()
    })
})
