import type { IR } from '@tanstack/db'
import { and, eq, gt, lt } from '@tanstack/db'
import { describe, expect, it } from 'vitest'
import { realtimeFiltersFor, toRequest } from '../src/request'

const field = <T = unknown>(path: string[]) =>
    ({ type: 'ref', path }) as unknown as IR.BasicExpression<T>
const orderBy = (name: string, direction: 'asc' | 'desc') =>
    [
        {
            expression: { type: 'ref', path: [name] },
            compareOptions: { direction, nulls: 'first', stringSort: 'lexical' },
        },
    ] as unknown as IR.OrderBy

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
