import { describe, expect, it } from 'vitest'
import { mergeExpand } from '../src/expand-merge'
import { patchEmbedded } from '../src/expand-patch'
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
        type Row = { id: string; tags: string[]; expand?: { tags: typeof tags } }
        const existing: Row = { id: 'b1', tags: ['t1', 't2'], expand: { tags } }
        expect(mergeExpand({ id: 'b1', tags: ['t1', 't2'] } as Row, existing).expand).toEqual({
            tags,
        })
        expect(
            mergeExpand({ id: 'b1', tags: ['t2', 't1'] } as Row, existing).expand
        ).toBeUndefined()
        expect(mergeExpand({ id: 'b1', tags: ['t1'] } as Row, existing).expand).toBeUndefined()
    })

    it('lets an incoming entry win over the stored one', () => {
        const fresh = { id: 'a1', name: 'George Orwell' }
        const incoming = { id: 'b1', author: 'a1', expand: { author: fresh } }
        const existing = { id: 'b1', author: 'a1', expand: { author } }
        expect(mergeExpand(incoming, existing)).toBe(incoming)
    })

    it('keeps nested expand inside a carried entry', () => {
        const book = { id: 'b1', author: 'a1', expand: { author } }
        type Row = { id: string; book: string; expand?: { book: typeof book } }
        const existing: Row = { id: 'm1', book: 'b1', expand: { book } }
        expect(mergeExpand({ id: 'm1', book: 'b1' } as Row, existing).expand).toEqual({
            book,
        })
    })
})

describe('patchEmbedded', () => {
    const author = { id: 'a1', name: 'Orwell', updated: '1' }
    const renamed = { id: 'a1', name: 'George Orwell', updated: '2' }

    describe('update, single relation', () => {
        it('replaces the embedded copy', () => {
            const row = { id: 'b1', author: 'a1', expand: { author } }
            const patched = patchEmbedded(row, 'author', 'update', renamed)
            expect(patched).toEqual({ id: 'b1', author: 'a1', expand: { author: renamed } })
            expect(patched).not.toBe(row)
            expect(row.expand.author).toBe(author)
        })

        it('returns undefined when the embedded id differs', () => {
            const row = { id: 'b1', author: 'a1', expand: { author } }
            expect(patchEmbedded(row, 'author', 'update', { id: 'a2' })).toBeUndefined()
        })

        it('returns undefined when the row has no embedded copy', () => {
            expect(
                patchEmbedded({ id: 'b1', author: 'a1' }, 'author', 'update', renamed)
            ).toBeUndefined()
            expect(
                patchEmbedded({ id: 'b1', author: 'a1', expand: {} }, 'author', 'update', renamed)
            ).toBeUndefined()
        })

        it('returns undefined when the record is unchanged', () => {
            const row = { id: 'b1', author: 'a1', expand: { author } }
            expect(patchEmbedded(row, 'author', 'update', { ...author })).toBeUndefined()
        })

        it('treats create like update', () => {
            const row = { id: 'b1', author: 'a1', expand: { author } }
            expect(patchEmbedded(row, 'author', 'create', renamed)?.expand.author).toEqual(renamed)
        })

        it('carries a nested expand the echo lacks', () => {
            const org = { id: 'o1', name: 'Org' }
            const embedded = { id: 'a1', name: 'Orwell', org: 'o1', expand: { org } }
            const row = { id: 'b1', author: 'a1', expand: { author: embedded } }
            const echo = { id: 'a1', name: 'George Orwell', org: 'o1' }
            expect(patchEmbedded(row, 'author', 'update', echo)?.expand.author).toEqual({
                ...echo,
                expand: { org },
            })
        })
    })

    describe('update, multi relation', () => {
        const t1 = { id: 't1', name: 'one' }
        const t2 = { id: 't2', name: 'two' }
        const t3 = { id: 't3', name: 'three' }

        it('replaces the matching element in place, preserving order', () => {
            const row = { id: 'b1', tags: ['t1', 't2', 't3'], expand: { tags: [t1, t2, t3] } }
            const patched = patchEmbedded(row, 'tags', 'update', { id: 't2', name: 'TWO' })
            expect(patched?.expand.tags).toEqual([t1, { id: 't2', name: 'TWO' }, t3])
            expect(row.expand.tags[1]).toBe(t2)
        })

        it('returns undefined when the id is not embedded', () => {
            const row = { id: 'b1', tags: ['t1'], expand: { tags: [t1] } }
            expect(patchEmbedded(row, 'tags', 'update', { id: 't9', name: 'x' })).toBeUndefined()
        })

        it('returns undefined when the element is unchanged', () => {
            const row = { id: 'b1', tags: ['t1', 't2'], expand: { tags: [t1, t2] } }
            expect(patchEmbedded(row, 'tags', 'update', { ...t2 })).toBeUndefined()
        })
    })

    describe('delete, single relation', () => {
        it('clears the reference and removes the copy', () => {
            const row = { id: 'b1', author: 'a1', expand: { author } }
            const patched = patchEmbedded(row, 'author', 'delete', { id: 'a1' })
            expect(patched).toEqual({ id: 'b1', author: '', expand: {} })
            expect(row.author).toBe('a1')
            expect(row.expand.author).toBe(author)
        })

        it('clears the reference on a row with no copy', () => {
            expect(
                patchEmbedded({ id: 'b1', author: 'a1' }, 'author', 'delete', { id: 'a1' })
            ).toEqual({
                id: 'b1',
                author: '',
            })
        })

        it('returns undefined when the row does not reference the id', () => {
            const row = { id: 'b1', author: 'a2', expand: { author: { id: 'a2' } } }
            expect(patchEmbedded(row, 'author', 'delete', { id: 'a1' })).toBeUndefined()
        })
    })

    describe('delete, multi relation', () => {
        const t1 = { id: 't1' }
        const t2 = { id: 't2' }

        it('filters the id out of the field and the copy, preserving order', () => {
            const row = { id: 'b1', tags: ['t1', 't2'], expand: { tags: [t1, t2] } }
            const patched = patchEmbedded(row, 'tags', 'delete', { id: 't1' })
            expect(patched).toEqual({ id: 'b1', tags: ['t2'], expand: { tags: [t2] } })
            expect(row.tags).toEqual(['t1', 't2'])
        })

        it('filters the field on a row with no copy', () => {
            expect(
                patchEmbedded({ id: 'b1', tags: ['t1', 't2'] }, 'tags', 'delete', { id: 't2' })
            ).toEqual({
                id: 'b1',
                tags: ['t1'],
            })
        })

        it('returns undefined when the array lacks the id', () => {
            const row = { id: 'b1', tags: ['t1'], expand: { tags: [t1] } }
            expect(patchEmbedded(row, 'tags', 'delete', { id: 't9' })).toBeUndefined()
        })
    })
})
