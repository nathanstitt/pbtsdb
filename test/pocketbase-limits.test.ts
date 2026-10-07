import { describe, expect, it } from 'vitest'
import { realtimeTopic, subsetFilters } from '../src/pocketbase-limits'

describe('realtimeTopic', () => {
    it('is the bare wildcard topic with no options', () => {
        expect(realtimeTopic('books', undefined)).toBe('books/*')
    })

    it('moves unknown option keys into query and keeps headers apart', () => {
        const topic = realtimeTopic('books', {
            filter: "genre = 'Fiction'",
            expand: 'author',
            headers: { 'X-Token': 'abc' },
        })
        const encoded = encodeURIComponent(
            JSON.stringify({
                query: { filter: "genre = 'Fiction'", expand: 'author' },
                headers: { 'X-Token': 'abc' },
            })
        )
        expect(topic).toBe(`books/*?options=${encoded}`)
    })

    it('leaves reserved keys out of query', () => {
        const topic = realtimeTopic('books', { requestKey: 'k', query: { fields: 'id' } })
        expect(topic).toBe(
            `books/*?options=${encodeURIComponent(JSON.stringify({ query: { fields: 'id' } }))}`
        )
    })
})

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
