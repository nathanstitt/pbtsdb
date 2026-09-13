import { describe, expect, expectTypeOf, it } from 'vitest'
import { createCollection } from '../src'
import type { ExpandShape } from '../src/types'
import { createTestQueryClient, pb } from './helpers'
import type { Authors, Books, Schema } from './schema'

const c = createCollection<Schema>(pb, createTestQueryClient())

describe('expand types', () => {
    it('types alwaysFetchRelations on the base rows', () => {
        const authors = c('authors', {})
        const books = c('books', {
            relations: { author: authors },
            alwaysFetchRelations: ['author'],
        })
        type Row = NonNullable<ReturnType<typeof books.get>>
        expectTypeOf<Row['expand']>().toEqualTypeOf<{ author?: Authors } | undefined>()
    })

    it('rejects alwaysFetchRelations paths not declared in relations', () => {
        const authors = c('authors', {})
        expect(() =>
            // @ts-expect-error nope is not a declared relation
            c('books', { relations: { author: authors }, alwaysFetchRelations: ['nope'] })
        ).toThrow('Cannot expand "nope" on collection "books"')
        expect(() =>
            // @ts-expect-error alwaysFetchRelations without relations
            c('books', { alwaysFetchRelations: ['author'] })
        ).toThrow('no relations declared')
    })

    it('widens expand on a view and rejects undeclared paths', () => {
        const authors = c('authors', {})
        const books = c('books', { relations: { author: authors } })
        const view = books.fetchRelations('author')
        type Row = NonNullable<ReturnType<typeof view.get>>
        expectTypeOf<Row['expand']>().toEqualTypeOf<{ author?: Authors } | undefined>()
        expect(() =>
            // @ts-expect-error nope is not a declared relation
            books.fetchRelations('nope')
        ).toThrow('Cannot expand "nope" on collection "books"')
        expect(() =>
            // @ts-expect-error views are leaves
            view.fetchRelations('author')
        ).toThrow('view of "books" cannot fetch further relations')
    })

    it('types nested paths through the target collection', () => {
        const authors = c('authors', {})
        const books = c('books', { relations: { author: authors } })
        const metadata = c('book_metadata', { relations: { book: books } })
        const view = metadata.fetchRelations('book.author')
        type Row = NonNullable<ReturnType<typeof view.get>>
        expectTypeOf<Row['expand']>().toEqualTypeOf<
            { book?: Books & { expand?: { author?: Authors } } } | undefined
        >()
        expect(() =>
            // @ts-expect-error nope is not a relation of books
            metadata.fetchRelations('book.nope')
        ).toThrow('Cannot expand "book.nope" on collection "book_metadata"')
    })

    it('rejects a nested path when the target declares no relations', () => {
        const books = c('books', {})
        const metadata = c('book_metadata', { relations: { book: books } })
        expect(() =>
            // @ts-expect-error books declares no relations
            metadata.fetchRelations('book.author')
        ).toThrow('Cannot expand "book.author" on collection "book_metadata"')
    })

    it('merges paths that share a head', () => {
        type A = { id: string; n: number }
        type B = { id: string; s: string }
        type Mid = { id: string; a: string; b: string[] }
        type S = {
            top: { type: { id: string; mid: string }; relations: { mid: Mid } }
            mid: { type: Mid; relations: { a: A; b: B[] } }
            a: { type: A }
            b: { type: B }
        }
        type MidCollection = {
            readonly __pbtsdb: { schema: S; name: 'mid'; relations: { a: unknown; b: unknown } }
        }
        type Shape = ExpandShape<S, 'top', { mid: MidCollection }, 'mid.a' | 'mid.b'>
        expectTypeOf<Shape>().toEqualTypeOf<{
            mid?: Mid & { expand?: { a?: A; b?: B[] } }
        }>()
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
})
