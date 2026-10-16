import { and, eq, gt, IR, inArray, lt } from '@tanstack/db'
import { describe, expect, it } from 'vitest'
import { realtimeFiltersFor, toRequest } from '../src/request'

// The builders treat a plain `{ type: 'ref' }` object as a value; only a
// constructed IR node is an expression.
const field = <T = unknown>(path: string[]) => new IR.PropRef<T>(path)
const orderBy = (name: string, direction: 'asc' | 'desc'): IR.OrderBy => [
    {
        expression: new IR.PropRef([name]),
        compareOptions: { direction, nulls: 'first', stringSort: 'lexical' },
    },
]

describe('toRequest paging', () => {
    it('conjoins nothing when no cursor is given', () => {
        const request = toRequest({ where: gt(field(['genre']), 'F'), limit: 10 })
        expect(request).toEqual({ filter: 'genre > "F"', limit: 10 })
    })

    it('carries cursor.whereFrom as a separate filter string', () => {
        const request = toRequest({
            where: gt(field(['genre']), 'F'),
            orderBy: orderBy('page_count', 'asc'),
            limit: 10,
            cursor: {
                whereFrom: gt(field(['page_count']), 100),
                whereCurrent: eq(field(['page_count']), 100),
            },
            offset: 10,
        })
        expect(request.filter).toBe('genre > "F"')
        expect(request.cursor).toBe('page_count > 100')
        expect(request.sort).toBe('page_count')
        expect(request.limit).toBe(10)
        // A cursor supersedes the offset: the cursor is exact, the offset is a count.
        expect(request.offset).toBeUndefined()
    })

    it('keeps a keyed subset and still carries the cursor', () => {
        const request = toRequest({
            where: eq(field(['author']), 'a1'),
            orderBy: orderBy('page_count', 'desc'),
            limit: 5,
            cursor: {
                whereFrom: lt(field(['page_count']), 7),
                whereCurrent: eq(field(['page_count']), 7),
            },
        })
        expect(request.subset).toEqual({ field: 'author', values: ['a1'] })
        expect(request.cursor).toBe('page_count < 7')
    })

    it('carries a positive offset when there is no cursor', () => {
        const request = toRequest({
            where: eq(field(['genre']), 'Fantasy'),
            orderBy: orderBy('page_count', 'asc'),
            limit: 10,
            offset: 20,
        })
        expect(request.offset).toBe(20)
        expect(toRequest({ limit: 10, offset: 0 }).offset).toBeUndefined()
    })

    it('realtime filters ignore cursor and offset', () => {
        const request = toRequest({
            where: and(eq(field(['genre']), 'Fantasy'), gt(field(['page_count']), 1)),
            orderBy: orderBy('page_count', 'asc'),
            limit: 10,
            cursor: {
                whereFrom: gt(field(['page_count']), 100),
                whereCurrent: eq(field(['page_count']), 100),
            },
        })
        expect(realtimeFiltersFor(request)).toEqual(['(genre = "Fantasy" && page_count > 1)'])
        const keyed = toRequest({ where: eq(field(['author']), 'a1'), offset: 30, limit: 10 })
        expect(realtimeFiltersFor(keyed)).toEqual(['author = "a1"'])
    })
})

describe('toRequest compound subset', () => {
    const ids = Array.from({ length: 500 }, (_, i) => `id${String(i).padStart(13, '0')}`)
    const where = and(eq(field(['archived']), false), inArray(field(['project']), ids))

    it('keeps the list as a subset and the other conditions as its filter', () => {
        const request = toRequest({ where })
        expect(request.subset).toEqual({ field: 'project', values: ids })
        expect(request.filter).toBe('archived = false')
    })

    it('chunks realtime filters, each carrying the other conditions', () => {
        const filters = realtimeFiltersFor(toRequest({ where })) ?? []
        expect(filters.length).toBeGreaterThan(1)
        for (const filter of filters) {
            expect(filter.length).toBeLessThanOrEqual(1000)
            expect(filter.startsWith('(archived = false) && (')).toBe(true)
        }
    })

    it('converts several other conditions as one filter', () => {
        const request = toRequest({
            where: and(
                eq(field(['archived']), false),
                inArray(field(['project']), ['p1', 'p2']),
                eq(field(['owner']), 'u1')
            ),
        })
        expect(request.filter).toBe('(archived = false && owner = "u1")')
        expect(realtimeFiltersFor(request)).toEqual([
            '((archived = false && owner = "u1")) && (project = "p1" || project = "p2")',
        ])
    })
})
