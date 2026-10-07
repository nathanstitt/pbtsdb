import { describe, expect, it, vi } from 'vitest'
import { createExpandFiler } from '../src/expand-filing'
import { idOf } from '../src/records'
import type { RelationTarget } from '../src/types'

function target(ready = true): RelationTarget & { writeFiled: ReturnType<typeof vi.fn> } {
    const writeFiled = vi.fn(async (_records: object[], _holder: object) => true)
    return {
        relationTargets: undefined,
        writeFiled,
        releaseFiled: () => undefined,
        isReady: () => ready,
        expectFiling: () => () => undefined,
        markSubsetLoaded: () => undefined,
        holdLive: () => ({ setFilters: () => undefined, release: () => undefined }),
    }
}

/** setFiled calls as plain arrays: root, target, path, sorted row ids, sorted filter values. */
function filings(setFiled: { mock: { calls: unknown[][] } }) {
    return setFiled.mock.calls.map(call => [
        call[0],
        call[1],
        call[2],
        [...(call[3] as Iterable<string>)].sort(),
        [...((call[4] ?? call[3]) as Iterable<string>)].sort(),
    ])
}

describe('expand filer', () => {
    const holder = { parent: 'books' }

    it('files children before parents at every depth and keys every level by the root row', async () => {
        const order: string[] = []
        const publishers = target()
        publishers.writeFiled.mockImplementation(async () => {
            order.push('publishers')
            return true
        })
        const authors: RelationTarget & { writeFiled: ReturnType<typeof vi.fn> } = {
            ...target(),
            relationTargets: { publisher: publishers },
        }
        authors.writeFiled.mockImplementation(async () => {
            order.push('authors')
            return true
        })
        const setFiled = vi.fn(() => ({ commit: () => undefined, undo: () => undefined }))
        const filer = createExpandFiler({
            collectionName: 'books',
            setFiled,
            holder,
            isStale: () => false,
        })
        await filer.upsertExpanded(
            [
                { id: 'b1', expand: { author: { id: 'a1', expand: { publisher: { id: 'p1' } } } } },
                { id: 'b2', expand: { author: { id: 'a1', expand: { publisher: { id: 'p1' } } } } },
                { id: 'b3', expand: { author: { id: 'a2' } } },
            ],
            { author: authors },
            ['author.publisher']
        )
        expect(order).toEqual(['publishers', 'authors'])
        expect(filings(setFiled).sort()).toEqual(
            [
                ['b1', publishers, 'author.publisher', ['p1'], ['p1']],
                ['b2', publishers, 'author.publisher', ['p1'], ['p1']],
                ['b3', publishers, 'author.publisher', [], []],
                ['b1', authors, 'author', ['a1'], ['a1']],
                ['b2', authors, 'author', ['a1'], ['a1']],
                ['b3', authors, 'author', ['a2'], ['a2']],
            ].sort()
        )
    })

    it('a root whose relation went missing clears every deeper path it filed', async () => {
        const publishers = target()
        const authors: RelationTarget = { ...target(), relationTargets: { publisher: publishers } }
        const setFiled = vi.fn(() => ({ commit: () => undefined, undo: () => undefined }))
        const filer = createExpandFiler({
            collectionName: 'books',
            setFiled,
            holder,
            isStale: () => false,
        })
        await filer.upsertExpanded([{ id: 'b1' }], { author: authors }, ['author.publisher'])
        expect(filings(setFiled).sort()).toEqual(
            [
                ['b1', authors, 'author', [], []],
                ['b1', publishers, 'author.publisher', [], []],
            ].sort()
        )
    })

    it('reconciles filings for fresh parents only and files none of a stale parent', async () => {
        const authors = target()
        const setFiled = vi.fn(() => ({ commit: () => undefined, undo: () => undefined }))
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
        expect(filings(setFiled)).toEqual([['fresh', authors, 'author', ['a1'], ['a1']]])
    })

    it('ends a filing for a requested key the record no longer carries, and leaves unrequested keys alone', async () => {
        const authors = target()
        const tags = target()
        const setFiled = vi.fn(() => ({ commit: () => undefined, undo: () => undefined }))
        const filer = createExpandFiler({
            collectionName: 'books',
            setFiled,
            holder,
            isStale: () => false,
        })
        await filer.upsertExpanded([{ id: 'b1' }], { author: authors, tags }, ['author'])
        expect(filings(setFiled)).toEqual([['b1', authors, 'author', [], []]])
    })

    it('fileExpanded writes and records at once; commit releases and undo reverts, later', async () => {
        const authors = target()
        const released: string[] = []
        const undone: string[] = []
        const setFiled = vi.fn((_parent: string, _target: RelationTarget, key: string) => ({
            commit: () => {
                released.push(key)
            },
            undo: () => {
                undone.push(key)
            },
        }))
        const filer = createExpandFiler({
            collectionName: 'books',
            setFiled,
            holder,
            isStale: () => false,
        })
        const change = await filer.fileExpanded(
            [{ id: 'b1', expand: { author: { id: 'a2' } } }],
            { author: authors },
            ['author']
        )
        expect(authors.writeFiled).toHaveBeenCalledTimes(1)
        expect(filings(setFiled)).toEqual([['b1', authors, 'author', ['a2'], ['a2']]])
        expect(released).toEqual([])
        change.commit()
        expect(released).toEqual(['author'])
        expect(undone).toEqual([])

        const discarded = await filer.fileExpanded(
            [{ id: 'b1', expand: { author: { id: 'a3' } } }],
            { author: authors },
            ['author']
        )
        discarded.undo()
        expect(undone).toEqual(['author'])
    })

    it('canFileFirst is true only with rows to file and every target to write ready', () => {
        const ready = target()
        const cold = target(false)
        const filer = createExpandFiler({
            collectionName: 'books',
            setFiled: () => ({ commit: () => undefined, undo: () => undefined }),
            holder,
            isStale: () => false,
        })
        const record = { id: 'b1', expand: { author: { id: 'a1' }, tags: [{ id: 't1' }] } }
        expect(filer.canFileFirst([record], { author: ready, tags: ready })).toBe(true)
        expect(filer.canFileFirst([record], { author: ready, tags: cold })).toBe(false)
        expect(filer.canFileFirst([{ id: 'b2' }], { author: ready })).toBe(false)
        expect(filer.canFileFirst([record], undefined)).toBe(false)
    })
})
