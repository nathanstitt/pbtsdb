import { describe, expect, it } from 'vitest'
import {
    BACK_RELATION_EXPAND_CAP,
    joinPaths,
    markFiledSubset,
    normalizePaths,
    parseViaKey,
    type RelationTargets,
    splitPaths,
    validateExpandPath,
} from '../src/expand-paths'
import type { ExpandTargetCollection } from '../src/types'

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

describe('parseViaKey', () => {
    it('splits at the first _via_', () => {
        expect(parseViaKey('book_tags_via_book')).toEqual({ field: 'book' })
        expect(parseViaKey('a_via_b_via_c')).toEqual({ field: 'b_via_c' })
    })

    it('returns undefined for forward relations and empty fields', () => {
        expect(parseViaKey('author')).toBeUndefined()
        expect(parseViaKey('comments_via_')).toBeUndefined()
    })
})

describe('markFiledSubset', () => {
    function fakeTarget() {
        const marks: [string, string][] = []
        const target: ExpandTargetCollection & { marks: typeof marks } = {
            marks,
            isReady: () => true,
            _sync: { startSync: async () => undefined },
            markSubsetLoaded: (field, value) => {
                marks.push([field, value])
            },
        }
        return target
    }

    it('marks a back-relation for the parent id', () => {
        const target = fakeTarget()
        markFiledSubset(target, 'comments_via_card', [{ id: 'x' }], 'c1')
        expect(target.marks).toEqual([['card', 'c1']])
    })

    it('marks a single object (unique-index back-relation) the same way', () => {
        const target = fakeTarget()
        markFiledSubset(target, 'profile_via_user', [{ id: 'p' }], 'u1')
        expect(target.marks).toEqual([['user', 'u1']])
    })

    it('does not mark forward relations', () => {
        const target = fakeTarget()
        markFiledSubset(target, 'author', [{ id: 'a' }], 'b1')
        expect(target.marks).toEqual([])
    })

    it('marks below the cap and not at it', () => {
        const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i) }))
        const under = fakeTarget()
        markFiledSubset(under, 'comments_via_card', rows(BACK_RELATION_EXPAND_CAP - 1), 'c1')
        expect(under.marks).toEqual([['card', 'c1']])
        const at = fakeTarget()
        markFiledSubset(at, 'comments_via_card', rows(BACK_RELATION_EXPAND_CAP), 'c1')
        expect(at.marks).toEqual([])
    })

    it('skips a target without markSubsetLoaded', () => {
        const target: ExpandTargetCollection = {
            isReady: () => true,
            _sync: { startSync: async () => undefined },
        }
        expect(() =>
            markFiledSubset(target, 'comments_via_card', [{ id: 'x' }], 'c1')
        ).not.toThrow()
    })
})
