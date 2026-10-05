import { and, eq, IR, inArray, type LoadSubsetOptions, lt } from '@tanstack/db'
import { describe, expect, it } from 'vitest'
import { realtimeWhereFor } from '../src/realtime-where'

const ref = (field: string) => new IR.PropRef([field])

// A stand-in for TanStack's CollectionSubscription: only `options` is read.
function optsFor(where: LoadSubsetOptions['where'], subscription: unknown): LoadSubsetOptions {
    return { where, subscription } as LoadSubsetOptions
}

describe('realtimeWhereFor', () => {
    const base = eq(ref('author'), 'a1')
    const subscription = { options: { whereExpression: base } }

    it('follows the base where for the base load and a cursor page', () => {
        expect(realtimeWhereFor(optsFor(base, subscription))).toBe(base)
    })

    it('folds a tie-check into the base where', () => {
        const tieCheck = and(base, eq(ref('page_count'), 20))
        expect(realtimeWhereFor(optsFor(tieCheck, subscription))).toBe(base)
    })

    it('keeps a foreign-key batch in its own filter', () => {
        const batch = and(base, inArray(ref('author'), ['a1', 'a2']))
        expect(realtimeWhereFor(optsFor(batch, subscription))).toBe(batch)
    })

    it('keeps a batch on a subscription with no where', () => {
        const batch = inArray(ref('author'), ['a1', 'a2'])
        const noWhere = { options: { whereExpression: undefined } }
        expect(realtimeWhereFor(optsFor(batch, noWhere))).toBe(batch)
    })

    it('folds a tie-check into the whole collection when the subscription has no where', () => {
        const tieCheck = eq(ref('page_count'), 20)
        const noWhere = { options: { whereExpression: undefined } }
        expect(realtimeWhereFor(optsFor(tieCheck, noWhere))).toBeUndefined()
    })

    it('keeps the request where when the subscription has no options', () => {
        expect(realtimeWhereFor(optsFor(base, {}))).toBe(base)
    })

    it('keeps the request where when options lack the whereExpression key', () => {
        const slice = and(base, lt(ref('page_count'), 10))
        expect(realtimeWhereFor(optsFor(slice, { options: {} }))).toBe(slice)
    })
})
