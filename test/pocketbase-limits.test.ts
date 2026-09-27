import { describe, expect, it } from 'vitest'
import { subsetFilters } from '../src/pocketbase-limits'

describe('subsetFilters', () => {
    it('joins a short subset into one filter, escaping quotes', () => {
        expect(subsetFilters({ field: 'id', values: ['a', 'b"c'] })).toEqual([
            'id = "a" || id = "b\\"c"',
        ])
    })

    it('returns no filters for an empty subset', () => {
        expect(subsetFilters({ field: 'id', values: [] })).toEqual([])
    })

    it('splits a subset PocketBase would refuse into filters it accepts, losing nothing', () => {
        const values = Array.from({ length: 300 }, (_, i) => `id${String(i).padStart(13, '0')}`)
        const filters = subsetFilters({ field: 'id', values })
        expect(filters.length).toBeGreaterThan(1)
        for (const filter of filters) expect(filter.length).toBeLessThanOrEqual(2500)
        expect(filters.flatMap(filter => filter.split(' || '))).toEqual(
            values.map(value => `id = "${value}"`)
        )
    })
})
