import { describe, expect, it } from 'vitest'
import { ACCEPTED, createLedger } from '../src/ledger'

type Row = { id: string; name: string; updated: string }

const row = (id: string, name: string, updated = '2026-01-01 00:00:00.000Z'): Row => ({
    id,
    name,
    updated,
})

describe('ledger', () => {
    it('stores a copy of each retained row and reports it as inserted once', () => {
        const ledger = createLedger<Row>()
        const a = row('a', 'A')
        const first = ledger.retain('t1', [a])
        expect(first.inserted.map(r => r.id)).toEqual(['a'])
        expect(first.updated).toEqual([])
        expect(ledger.row('a')).not.toBe(a)
        expect(ledger.row('a')).toEqual(a)
        const second = ledger.retain('t2', [a])
        expect(second.inserted).toEqual([])
        expect(second.updated.map(r => r.id)).toEqual(['a'])
        expect(ledger.holderCount('a')).toBe(2)
        const stored = ledger.row('a')
        const third = ledger.retain('t3', stored ? [stored] : [])
        expect(third.updated).toEqual([])
    })

    it('merges an update into the stored row as a new object', () => {
        type Noted = Row & { note?: string }
        const ledger = createLedger<Noted>()
        ledger.retain('t', [{ ...row('a', 'A'), note: 'n' }])
        const before = ledger.row('a')
        ledger.retain('t', [row('a', 'B', '2026-01-02 00:00:00.000Z')])
        expect(ledger.row('a')).toEqual({
            id: 'a',
            name: 'B',
            note: 'n',
            updated: '2026-01-02 00:00:00.000Z',
        })
        expect(ledger.row('a')).not.toBe(before)
    })

    it('replaces the row on an equal or newer updated and keeps it on an older one', () => {
        const ledger = createLedger<Row>()
        ledger.retain('t', [row('a', 'A', '2026-01-02 00:00:00.000Z')])
        const older = ledger.retain('t', [row('a', 'old', '2026-01-01 00:00:00.000Z')])
        expect(older.updated).toEqual([])
        expect(ledger.row('a')?.name).toBe('A')
        const equal = ledger.retain('t', [row('a', 'same', '2026-01-02 00:00:00.000Z')])
        expect(equal.updated.map(r => r.name)).toEqual(['same'])
        const newer = ledger.retain('t', [row('a', 'new', '2026-01-03 00:00:00.000Z')])
        expect(newer.updated.map(r => r.name)).toEqual(['new'])
    })

    it('removes a row only when its last holder releases it', () => {
        const ledger = createLedger<Row>()
        ledger.retain('t1', [row('a', 'A'), row('b', 'B')])
        ledger.retain('t2', [row('a', 'A')])
        expect(ledger.release('t1')).toEqual(['b'])
        expect(ledger.has('a')).toBe(true)
        expect(ledger.release('t2', ['a'])).toEqual(['a'])
        expect(ledger.has('a')).toBe(false)
        expect(ledger.release('t2', ['a'])).toEqual([])
    })

    it('replace releases the rows the holder no longer lists', () => {
        const ledger = createLedger<Row>()
        ledger.retain('sub', [row('a', 'A'), row('b', 'B')])
        ledger.retain(ACCEPTED, [row('b', 'B')])
        const result = ledger.replace('sub', [row('b', 'B'), row('c', 'C')])
        expect(result.inserted.map(r => r.id)).toEqual(['c'])
        expect(result.removed).toEqual(['a'])
        expect(ledger.idsOf('sub').sort()).toEqual(['b', 'c'])
        expect(ledger.holderCount('b')).toBe(2)
    })

    it('releaseAll removes the row regardless of holders', () => {
        const ledger = createLedger<Row>()
        ledger.retain('t1', [row('a', 'A')])
        ledger.retain('t2', [row('a', 'A')])
        expect(ledger.releaseAll('a')).toBe(true)
        expect(ledger.has('a')).toBe(false)
        expect(ledger.idsOf('t1')).toEqual([])
        expect(ledger.releaseAll('a')).toBe(false)
    })

    it('clear forgets every row and holder', () => {
        const ledger = createLedger<Row>()
        ledger.retain('t', [row('a', 'A')])
        ledger.clear()
        expect(ledger.size()).toBe(0)
        expect(ledger.idsOf('t')).toEqual([])
    })

    it('ignores a row without an id', () => {
        const ledger = createLedger<{ id?: string; name: string }>()
        const result = ledger.retain('t', [{ name: 'no id' }])
        expect(result.inserted).toEqual([])
        expect(ledger.size()).toBe(0)
    })

    it('lists every holder that references a row', () => {
        const ledger = createLedger<Row>()
        ledger.retain('*', [row('a', 'A')])
        ledger.retain(ACCEPTED, [row('b', 'B')])
        expect(ledger.holders()).toEqual(['*', ACCEPTED])
        ledger.release('*')
        expect(ledger.holders()).toEqual([ACCEPTED])
    })

    it('rollback undoes every change since track', () => {
        const ledger = createLedger<Row>()
        ledger.retain('t1', [row('a', 'A'), row('b', 'B')])
        const change = ledger.track()
        ledger.retain('t1', [row('a', 'A2', '2026-01-02 00:00:00.000Z'), row('c', 'C')])
        ledger.release('t1', ['b'])
        ledger.releaseAll('a')
        change.rollback()
        expect(ledger.row('a')?.name).toBe('A')
        expect(ledger.has('b')).toBe(true)
        expect(ledger.has('c')).toBe(false)
        expect(ledger.idsOf('t1').sort()).toEqual(['a', 'b'])
        const kept = ledger.track()
        ledger.retain('t2', [row('d', 'D')])
        kept.commit()
        kept.rollback()
        expect(ledger.has('d')).toBe(true)
    })
})
