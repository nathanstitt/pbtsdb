import { describe, expect, it, vi } from 'vitest'
import { createExpandFiler } from '../src/expand-filing'
import { idOf } from '../src/records'
import type { RelationTarget } from '../src/types'

function target(): RelationTarget & { writeFiled: ReturnType<typeof vi.fn> } {
    const writeFiled = vi.fn(async (_records: object[], _holder: object) => true)
    return {
        relationTargets: undefined,
        writeFiled,
        releaseFiled: () => undefined,
        expectFiling: () => () => undefined,
        markSubsetLoaded: () => undefined,
        holdLive: () => ({ setFilters: () => undefined, release: () => undefined }),
    }
}

describe('expand filer', () => {
    const holder = { parent: 'books' }

    it('reconciles filings for fresh parents only and files none of a stale parent', async () => {
        const authors = target()
        const setFiled = vi.fn()
        const filer = createExpandFiler({
            collectionName: 'books',
            setFiled,
            holder,
            isStale: record => idOf(record) === 'stale',
        })
        await filer.upsertExpanded(
            [
                { id: 'fresh', expand: { author: { id: 'a1' } } },
                { id: 'stale', expand: { author: { id: 'a0' } } },
            ],
            { author: authors },
            ['author']
        )
        expect(authors.writeFiled).toHaveBeenCalledTimes(1)
        expect((authors.writeFiled.mock.calls[0][0] as object[]).map(idOf)).toEqual(['a1'])
        expect(setFiled).toHaveBeenCalledTimes(1)
        expect(setFiled).toHaveBeenCalledWith('fresh', authors, 'author', ['a1'])
    })

    it('ends a filing for a requested key the record no longer carries, and leaves unrequested keys alone', async () => {
        const authors = target()
        const tags = target()
        const setFiled = vi.fn()
        const filer = createExpandFiler({
            collectionName: 'books',
            setFiled,
            holder,
            isStale: () => false,
        })
        await filer.upsertExpanded([{ id: 'b1' }], { author: authors, tags }, ['author'])
        expect(setFiled).toHaveBeenCalledTimes(1)
        expect(setFiled).toHaveBeenCalledWith('b1', authors, 'author', [])
    })
})
