import type { IR } from '@tanstack/db'
import { describe, expect, it } from 'vitest'
import { matchesSubset, subsetFromWhere } from '../src/keyed-where'

const ref = (...path: string[]) => ({ type: 'ref', path }) as unknown as IR.BasicExpression
const val = (value: unknown) => ({ type: 'val', value }) as unknown as IR.BasicExpression
const fn = (name: string, ...args: IR.BasicExpression[]) =>
    ({ type: 'func', name, args }) as unknown as IR.BasicExpression<boolean>

describe('subsetFromWhere', () => {
    it('reads eq(id, string) in either argument order', () => {
        expect(subsetFromWhere(fn('eq', ref('id'), val('a')))).toEqual({
            field: 'id',
            values: ['a'],
        })
        expect(subsetFromWhere(fn('eq', val('a'), ref('id')))).toEqual({
            field: 'id',
            values: ['a'],
        })
    })

    it('reads a non-id field', () => {
        expect(subsetFromWhere(fn('eq', ref('card'), val('c1')))).toEqual({
            field: 'card',
            values: ['c1'],
        })
    })

    it('reads in(field, strings) sorted and deduplicated', () => {
        expect(subsetFromWhere(fn('in', ref('card'), val(['b', 'a', 'b'])))).toEqual({
            field: 'card',
            values: ['a', 'b'],
        })
    })

    it('reads in(field, []) as an empty set, not "no subset"', () => {
        expect(subsetFromWhere(fn('in', ref('card'), val([])))).toEqual({
            field: 'card',
            values: [],
        })
    })

    it('reads an or of equalities on one field', () => {
        const where = fn('or', fn('eq', ref('card'), val('b')), fn('eq', ref('card'), val('a')))
        expect(subsetFromWhere(where)).toEqual({ field: 'card', values: ['a', 'b'] })
    })

    it('returns undefined for anything else', () => {
        expect(subsetFromWhere(undefined)).toBeUndefined()
        expect(subsetFromWhere(fn('eq', ref('card'), val(1)))).toBeUndefined()
        expect(subsetFromWhere(fn('eq', ref('b', 'card'), val('a')))).toBeUndefined()
        expect(subsetFromWhere(fn('gt', ref('card'), val('a')))).toBeUndefined()
        expect(
            subsetFromWhere(
                fn('and', fn('eq', ref('card'), val('a')), fn('eq', ref('name'), val('x')))
            )
        ).toBeUndefined()
        expect(
            subsetFromWhere(
                fn('or', fn('eq', ref('card'), val('a')), fn('eq', ref('list'), val('b')))
            )
        ).toBeUndefined()
        expect(
            subsetFromWhere(
                fn('or', fn('eq', ref('card'), val('a')), fn('gt', ref('card'), val('b')))
            )
        ).toBeUndefined()
        expect(subsetFromWhere(fn('in', ref('card'), val(['a', 2])))).toBeUndefined()
    })
})

describe('matchesSubset', () => {
    const wanted = new Set(['c1', 'c2'])

    it('matches a string field in the set and misses one outside it', () => {
        expect(matchesSubset({ card: 'c1' }, 'card', wanted)).toBe(true)
        expect(matchesSubset({ card: 'c9' }, 'card', wanted)).toBe(false)
    })

    it('matches an array field by containment', () => {
        expect(matchesSubset({ cards: ['x', 'c2'] }, 'cards', wanted)).toBe(true)
        expect(matchesSubset({ cards: ['x'] }, 'cards', wanted)).toBe(false)
    })

    it('does not match a missing or non-string field', () => {
        expect(matchesSubset({}, 'card', wanted)).toBe(false)
        expect(matchesSubset({ card: 1 }, 'card', wanted)).toBe(false)
    })
})
