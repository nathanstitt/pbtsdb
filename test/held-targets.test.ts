import { describe, expect, it, vi } from 'vitest'
import { createHeldTargets } from '../src/held-targets'
import type { RelationTarget } from '../src/types'

function target() {
    const setFilters = vi.fn<(filters: readonly string[]) => void>()
    const releaseFiled = vi.fn<(ids: readonly string[], holder: object) => void>()
    const relationTarget: RelationTarget = {
        relationTargets: undefined,
        writeFiled: async () => true,
        releaseFiled,
        expectFiling: () => () => undefined,
        markSubsetLoaded: () => undefined,
        holdLive: () => ({ setFilters, release: () => undefined }),
    }
    return { relationTarget, setFilters, releaseFiled }
}

const lastFilters = (setFilters: ReturnType<typeof target>['setFilters']) =>
    setFilters.mock.calls.at(-1)?.[0] ?? []

describe('held targets', () => {
    const holder = { parent: 'books' }

    it('subscribes a forward relation to the filed ids and releases a row when its last parent leaves', () => {
        const { relationTarget, setFilters, releaseFiled } = target()
        const held = createHeldTargets('books', holder)
        held.sync(new Set([relationTarget]))
        held.setFiled('b1', relationTarget, 'author', ['a1'])
        held.setFiled('b2', relationTarget, 'author', ['a1', 'a2'])
        expect(lastFilters(setFilters).join(' ')).toContain('a2')

        held.forgetParentRow('b1')
        expect(releaseFiled).not.toHaveBeenCalled()
        expect(lastFilters(setFilters).join(' ')).toContain('a1')

        held.forgetParentRow('b2')
        expect(releaseFiled).toHaveBeenCalledTimes(1)
        expect([...releaseFiled.mock.calls[0][0]].sort()).toEqual(['a1', 'a2'])
        expect(releaseFiled.mock.calls[0][1]).toBe(holder)
        expect(lastFilters(setFilters)).toEqual([])
    })

    it('releases the rows a parent stopped filing when its expand changes', () => {
        const { relationTarget, setFilters, releaseFiled } = target()
        const held = createHeldTargets('books', holder)
        held.sync(new Set([relationTarget]))
        held.setFiled('b1', relationTarget, 'author', ['a1'])
        held.setFiled('b1', relationTarget, 'author', ['a2'])
        expect(releaseFiled).toHaveBeenCalledWith(['a1'], holder)
        const filters = lastFilters(setFilters).join(' ')
        expect(filters).toContain('a2')
        expect(filters).not.toContain('a1')
    })

    it('keeps a back-relation filter while the parent is filed, even with no children', () => {
        const { relationTarget, setFilters, releaseFiled } = target()
        const held = createHeldTargets('authors', holder)
        held.sync(new Set([relationTarget]))
        held.setFiled('a1', relationTarget, 'books_via_author', ['b1', 'b2'])
        expect(lastFilters(setFilters).join(' ')).toContain('a1')

        held.setFiled('a1', relationTarget, 'books_via_author', [])
        expect([...releaseFiled.mock.calls[0][0]].sort()).toEqual(['b1', 'b2'])
        expect(lastFilters(setFilters).join(' ')).toContain('a1')

        held.forgetParentRow('a1')
        expect(lastFilters(setFilters)).toEqual([])
    })

    it('a re-hold subscribes to the current filings only', () => {
        const { relationTarget, setFilters } = target()
        const held = createHeldTargets('books', holder)
        held.setFiled('b1', relationTarget, 'author', ['a1'])
        held.setFiled('b2', relationTarget, 'author', ['a2'])
        held.forgetParentRow('b1')
        held.sync(new Set([relationTarget]))
        const filters = lastFilters(setFilters).join(' ')
        expect(filters).toContain('a2')
        expect(filters).not.toContain('a1')
    })

    it('clearFiled forgets every filing without releasing', () => {
        const { relationTarget, setFilters, releaseFiled } = target()
        const held = createHeldTargets('books', holder)
        held.setFiled('b1', relationTarget, 'author', ['a1'])
        held.clearFiled()
        held.sync(new Set([relationTarget]))
        expect(lastFilters(setFilters)).toEqual([])
        expect(releaseFiled).not.toHaveBeenCalled()
    })
})
