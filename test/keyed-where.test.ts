import type { IR } from '@tanstack/db'
import { describe, expect, it } from 'vitest'
import { idsFromWhere } from '../src/keyed-where'

const ref = (...path: string[]) => ({ type: 'ref', path }) as unknown as IR.BasicExpression
const val = (value: unknown) => ({ type: 'val', value }) as unknown as IR.BasicExpression
const fn = (name: string, ...args: IR.BasicExpression[]) =>
    ({ type: 'func', name, args }) as unknown as IR.BasicExpression<boolean>

describe('idsFromWhere', () => {
    it('reads eq(id, string) in either argument order', () => {
        expect(idsFromWhere(fn('eq', ref('id'), val('a')))).toEqual(['a'])
        expect(idsFromWhere(fn('eq', val('a'), ref('id')))).toEqual(['a'])
    })

    it('reads in(id, strings) sorted and deduplicated', () => {
        expect(idsFromWhere(fn('in', ref('id'), val(['b', 'a', 'b'])))).toEqual(['a', 'b'])
    })

    it('reads in(id, []) as an empty id set, not "no ids"', () => {
        expect(idsFromWhere(fn('in', ref('id'), val([])))).toEqual([])
    })

    it('reads an or of id equalities', () => {
        const where = fn('or', fn('eq', ref('id'), val('b')), fn('eq', ref('id'), val('a')))
        expect(idsFromWhere(where)).toEqual(['a', 'b'])
    })

    it('returns undefined for anything else', () => {
        expect(idsFromWhere(undefined)).toBeUndefined()
        expect(idsFromWhere(fn('eq', ref('name'), val('a')))).toBeUndefined()
        expect(idsFromWhere(fn('eq', ref('id'), val(1)))).toBeUndefined()
        expect(
            idsFromWhere(fn('and', fn('eq', ref('id'), val('a')), fn('eq', ref('name'), val('x'))))
        ).toBeUndefined()
        expect(
            idsFromWhere(fn('or', fn('eq', ref('id'), val('a')), fn('gt', ref('id'), val('b'))))
        ).toBeUndefined()
        expect(idsFromWhere(fn('in', ref('id'), val(['a', 2])))).toBeUndefined()
        expect(idsFromWhere(fn('eq', ref('b', 'id'), val('a')))).toBeUndefined()
    })
})
