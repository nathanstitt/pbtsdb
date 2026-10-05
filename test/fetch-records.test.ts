import { QueryClient } from '@tanstack/react-query'
import type PocketBase from 'pocketbase'
import { describe, expect, it, vi } from 'vitest'
import { createFetcher } from '../src/fetch-records'
import { subsetFilters } from '../src/pocketbase-limits'
import type { PbRequest } from '../src/request'

type Row = { id: string; n: number }

const rows = (count: number): Row[] =>
    Array.from({ length: count }, (_, i) => ({ id: `r${i}`, n: i }))

// A fake PocketBase whose list calls return `count` rows, enough for any
// slice the fetcher takes.
function setup(count = 100) {
    const getList = vi.fn(async (_page: number, _perPage: number, _options?: object) => ({
        items: rows(count),
    }))
    const getFullList = vi.fn(async (_options?: object) => rows(count))
    const pb = { collection: () => ({ getList, getFullList }) } as unknown as PocketBase
    const fetcher = createFetcher<Row>({
        pb,
        collectionName: 'books',
        queryClient: new QueryClient(),
        relationTargets: undefined,
        ignoreAutoCancellation: false,
        activeExpand: () => undefined,
        syncedRow: () => undefined,
        syncedRows: () => [],
        subsets: { isLoaded: () => false },
        guard: {
            trackFetch: () => ({ confirmed: new Set<string>(), done() {} }),
            withRowsConfirmedMidFlight: items => items,
        },
        filer: { markEmptyBackRelations() {}, upsertExpanded: async () => {} },
    })
    const fetch = (request: PbRequest) => fetcher.fetchRecords(request, ['books', request])
    return { getList, getFullList, fetch }
}

const pageArgs = (mock: ReturnType<typeof setup>['getList']) =>
    mock.mock.calls.map(([page, perPage]) => [page, perPage])

describe('fetchRecords offset paging', () => {
    it('turns an aligned offset into a page', async () => {
        const { getList, fetch } = setup(10)
        const result = await fetch({ sort: 'n', limit: 10, offset: 20 })
        expect(pageArgs(getList)).toEqual([[3, 10]])
        expect(result).toHaveLength(10)
    })

    it('slices an unaligned offset from a request starting at row one', async () => {
        const { getList, fetch } = setup(25)
        const result = await fetch({ sort: 'n', limit: 10, offset: 15 })
        expect(pageArgs(getList)).toEqual([[1, 25]])
        expect(result.map(r => r.n)).toEqual([15, 16, 17, 18, 19, 20, 21, 22, 23, 24])
    })

    it('slices an offset without a limit from the full list', async () => {
        const { getFullList, getList, fetch } = setup(10)
        const result = await fetch({ sort: 'n', offset: 4 })
        expect(getList).not.toHaveBeenCalled()
        expect(getFullList).toHaveBeenCalledTimes(1)
        expect(result.map(r => r.n)).toEqual([4, 5, 6, 7, 8, 9])
    })

    it('fetches the full prefix unsliced from every chunk of a split subset', async () => {
        const ids = Array.from({ length: 300 }, (_, i) => `id${String(i).padStart(13, '0')}`)
        const subset = { field: 'author', values: ids }
        const chunks = subsetFilters(subset).length
        expect(chunks).toBeGreaterThan(1)

        const { getList, fetch } = setup(25)
        const result = await fetch({ subset, sort: 'n', limit: 10, offset: 15 })
        expect(pageArgs(getList)).toEqual(Array.from({ length: chunks }, () => [1, 25]))
        expect(result).toHaveLength(25 * chunks)
    })

    it('fetches every row unsliced from every chunk of a split subset without a limit', async () => {
        const ids = Array.from({ length: 300 }, (_, i) => `id${String(i).padStart(13, '0')}`)
        const subset = { field: 'author', values: ids }
        const chunks = subsetFilters(subset).length

        const { getFullList, fetch } = setup(10)
        const result = await fetch({ subset, sort: 'n', offset: 4 })
        expect(getFullList).toHaveBeenCalledTimes(chunks)
        expect(result).toHaveLength(10 * chunks)
    })
})
