import { describe, expectTypeOf, it } from 'vitest'
import { createCollection } from '../src'
import type { ExpandShape } from '../src/types'
import { createTestQueryClient, pb } from './helpers'
import type { Authors, Books, Schema } from './schema'

const c = createCollection<Schema>(pb, createTestQueryClient())

describe('expand types', () => {
    it('types alwaysExpand on the base rows', () => {
        const authors = c('authors', {})
        const books = c('books', { relations: { author: authors }, alwaysExpand: ['author'] })
        type Row = NonNullable<ReturnType<typeof books.get>>
        expectTypeOf<Row['expand']>().toEqualTypeOf<{ author?: Authors } | undefined>()
    })

    it('rejects alwaysExpand paths not declared in relations', () => {
        const authors = c('authors', {})
        // @ts-expect-error nope is not a declared relation
        c('books', { relations: { author: authors }, alwaysExpand: ['nope'] })
        // @ts-expect-error alwaysExpand without relations
        c('books', { alwaysExpand: ['author'] })
    })

    it('widens expand on a view and rejects undeclared paths', () => {
        const authors = c('authors', {})
        const books = c('books', { relations: { author: authors } })
        const view = books.expand('author')
        type Row = NonNullable<ReturnType<typeof view.get>>
        expectTypeOf<Row['expand']>().toEqualTypeOf<{ author?: Authors } | undefined>()
        // @ts-expect-error nope is not a declared relation
        books.expand('nope')
        // @ts-expect-error views are leaves
        view.expand('author')
    })

    it('types nested paths through the target collection', () => {
        const authors = c('authors', {})
        const books = c('books', { relations: { author: authors } })
        const metadata = c('book_metadata', { relations: { book: books } })
        const view = metadata.expand('book.author')
        type Row = NonNullable<ReturnType<typeof view.get>>
        expectTypeOf<Row['expand']>().toEqualTypeOf<
            { book?: Books & { expand?: { author?: Authors } } } | undefined
        >()
        // @ts-expect-error nope is not a relation of books
        metadata.expand('book.nope')
    })

    it('rejects a nested path when the target declares no relations', () => {
        const books = c('books', {})
        const metadata = c('book_metadata', { relations: { book: books } })
        // @ts-expect-error books declares no relations
        metadata.expand('book.author')
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
        const view = books.expand('author')
        expectTypeOf(view.collectionName).toEqualTypeOf<'books'>()
        expectTypeOf(view.waitForSubscription).toBeFunction()
        type Insert = Parameters<typeof view.insert>[0]
        expectTypeOf<Insert>().toMatchTypeOf<
            Omit<Books, 'created' | 'updated'> | Omit<Books, 'created' | 'updated'>[]
        >()
    })
})
