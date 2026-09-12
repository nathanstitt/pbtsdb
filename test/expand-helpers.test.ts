import { describe, expect, it } from 'vitest'
import { mergeExpand } from '../src/expand-merge'
import {
    joinPaths,
    normalizePaths,
    type RelationTargets,
    splitPaths,
    validateExpandPath,
} from '../src/expand-paths'

function target(relationTargets?: RelationTargets) {
    return {
        isReady: () => true,
        _sync: { startSync: async () => undefined },
        relationTargets,
    }
}

describe('expand paths', () => {
    it('normalizes by dropping empties, deduping and sorting', () => {
        expect(normalizePaths(['tags', '', 'author', 'tags', 'book.author'])).toEqual([
            'author',
            'book.author',
            'tags',
        ])
    })

    it('splits and joins comma lists', () => {
        expect(splitPaths(undefined)).toEqual([])
        expect(splitPaths('tags, author,,')).toEqual(['author', 'tags'])
        expect(joinPaths([])).toBeUndefined()
        expect(joinPaths(['tags', 'author'])).toBe('author,tags')
    })

    it('accepts a declared single segment', () => {
        expect(() => validateExpandPath('books', { author: target() }, 'author')).not.toThrow()
    })

    it('accepts a nested path through a target with its own map', () => {
        const authors = target()
        const books = target({ author: authors })
        expect(() =>
            validateExpandPath('book_metadata', { book: books }, 'book.author')
        ).not.toThrow()
    })

    it('rejects an undeclared first segment', () => {
        expect(() => validateExpandPath('books', { author: target() }, 'nope')).toThrow(
            'Cannot expand "nope" on collection "books": segment "nope" is not a declared relation'
        )
    })

    it('rejects a nested segment the target does not declare', () => {
        const books = target({})
        expect(() => validateExpandPath('book_metadata', { book: books }, 'book.nope')).toThrow(
            'Cannot expand "book.nope" on collection "book_metadata": segment "nope" is not a declared relation'
        )
    })

    it('rejects a nested segment when the target has no relation map', () => {
        expect(() =>
            validateExpandPath('book_metadata', { book: target() }, 'book.author')
        ).toThrow(
            'Cannot expand "book.author" on collection "book_metadata": segment "author" is not a declared relation'
        )
    })

    it('rejects when nothing is declared', () => {
        expect(() => validateExpandPath('books', undefined, 'author')).toThrow(
            'Cannot expand "author" on collection "books": no relations declared'
        )
    })
})

describe('mergeExpand', () => {
    const author = { id: 'a1', name: 'Orwell' }

    it('returns incoming unchanged when nothing is stored', () => {
        const incoming = { id: 'b1', author: 'a1' }
        expect(mergeExpand(incoming, undefined)).toBe(incoming)
    })

    it('carries an expand entry over when the relation field is unchanged', () => {
        const incoming = { id: 'b1', author: 'a1' }
        const existing = { id: 'b1', author: 'a1', expand: { author } }
        const merged = mergeExpand(incoming, existing)
        expect(merged).not.toBe(incoming)
        expect(merged).toEqual({ id: 'b1', author: 'a1', expand: { author } })
        expect(incoming).toEqual({ id: 'b1', author: 'a1' })
    })

    it('drops an entry when the relation field changed', () => {
        const incoming = { id: 'b1', author: 'a2' }
        const existing = { id: 'b1', author: 'a1', expand: { author } }
        expect(mergeExpand(incoming, existing)).toBe(incoming)
    })

    it('compares multi relations element-wise in order', () => {
        const tags = [{ id: 't1' }, { id: 't2' }]
        const existing = { id: 'b1', tags: ['t1', 't2'], expand: { tags } }
        expect(mergeExpand({ id: 'b1', tags: ['t1', 't2'] }, existing).expand).toEqual({ tags })
        expect(mergeExpand({ id: 'b1', tags: ['t2', 't1'] }, existing).expand).toBeUndefined()
        expect(mergeExpand({ id: 'b1', tags: ['t1'] }, existing).expand).toBeUndefined()
    })

    it('lets an incoming entry win over the stored one', () => {
        const fresh = { id: 'a1', name: 'George Orwell' }
        const incoming = { id: 'b1', author: 'a1', expand: { author: fresh } }
        const existing = { id: 'b1', author: 'a1', expand: { author } }
        expect(mergeExpand(incoming, existing)).toBe(incoming)
    })

    it('keeps nested expand inside a carried entry', () => {
        const book = { id: 'b1', author: 'a1', expand: { author } }
        const existing = { id: 'm1', book: 'b1', expand: { book } }
        expect(mergeExpand({ id: 'm1', book: 'b1' }, existing).expand).toEqual({ book })
    })
})
