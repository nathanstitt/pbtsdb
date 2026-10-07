import { describe, expect, it } from 'vitest'
import { ACCEPTED, createLedger } from '../src/ledger'
import { createMembership } from '../src/membership'
import { createSyncedStore, type SyncChannel } from '../src/synced-store'

type Row = { id: string; name: string; updated: string }

const row = (id: string, name: string, updated = '2026-01-01 00:00:00.000Z'): Row => ({
    id,
    name,
    updated,
})

function setup() {
    const log: string[] = []
    const channel: SyncChannel<Row> = {
        begin: () => {
            log.push('begin')
        },
        write: message => {
            log.push(
                'key' in message
                    ? `delete:${String(message.key)}`
                    : `${message.type}:${message.value.id}`
            )
        },
        commit: () => {
            log.push('commit')
            return true
        },
    }
    const removed: Row[] = []
    const ledger = createLedger<Row>()
    const store = createSyncedStore<Row>('rows')
    store.attach(channel)
    const membership = createMembership<Row>({
        collectionName: 'rows',
        ledger,
        store,
        onRemoved: rows => removed.push(...rows),
    })
    return { channel, log, removed, ledger, membership }
}

describe('membership', () => {
    it('land inserts new rows and updates present ones in one transaction', () => {
        const { log, membership } = setup()
        membership.land('t', [row('a', 'A')])
        log.length = 0
        membership.land('t', [row('a', 'A2', '2026-01-02 00:00:00.000Z'), row('b', 'B')])
        expect(log).toEqual(['begin', 'update:a', 'insert:b', 'commit'])
    })

    it('land of a new row duplicated in one batch writes it once, as the final version', () => {
        const { log, ledger, membership } = setup()
        membership.land('t', [row('a', 'A'), row('a', 'A2', '2026-01-02 00:00:00.000Z')])
        expect(log).toEqual(['begin', 'insert:a', 'commit'])
        expect(ledger.row('a')?.name).toBe('A2')
    })

    it('land of a new row duplicated with an older second copy writes the first version once', () => {
        const { log, ledger, membership } = setup()
        membership.land('t', [
            row('a', 'A2', '2026-01-02 00:00:00.000Z'),
            row('a', 'A', '2026-01-01 00:00:00.000Z'),
        ])
        expect(log).toEqual(['begin', 'insert:a', 'commit'])
        expect(ledger.row('a')?.name).toBe('A2')
    })

    it('land of a stale row writes nothing but keeps the holder', () => {
        const { log, ledger, membership } = setup()
        membership.land('t1', [row('a', 'A', '2026-01-02 00:00:00.000Z')])
        log.length = 0
        membership.land('t2', [row('a', 'old', '2026-01-01 00:00:00.000Z')])
        expect(log).toEqual([])
        expect(ledger.holderCount('a')).toBe(2)
    })

    it('reconcile removes rows the holder no longer lists when nothing else holds them', () => {
        const { log, removed, membership } = setup()
        membership.land('sub', [row('a', 'A'), row('b', 'B')])
        membership.land(ACCEPTED, [row('b', 'B')])
        log.length = 0
        membership.reconcile('sub', [row('c', 'C')])
        expect(log).toEqual(['begin', 'insert:c', 'delete:a', 'commit'])
        expect(removed.map(r => r.id)).toEqual(['a'])
    })

    it('drop releases the given holders and deletes rows at zero', () => {
        const { log, membership } = setup()
        membership.land('topic', [row('a', 'A')])
        membership.land('sub', [row('a', 'A')])
        membership.land(ACCEPTED, [row('a', 'A')])
        log.length = 0
        membership.drop(['topic', 'sub'], ['a'])
        expect(log).toEqual([])
        membership.drop([ACCEPTED], ['a'])
        expect(log).toEqual(['begin', 'delete:a', 'commit'])
    })

    it('dropAll deletes regardless of holders', () => {
        const { log, membership } = setup()
        membership.land('t1', [row('a', 'A')])
        membership.land('t2', [row('a', 'A')])
        log.length = 0
        membership.dropAll(['a', 'missing'])
        expect(log).toEqual(['begin', 'delete:a', 'commit'])
    })

    it('returns false and changes nothing with no session', () => {
        const { ledger, membership } = setup()
        const detached = createMembership<Row>({
            collectionName: 'rows',
            ledger,
            store: createSyncedStore<Row>('rows'),
            onRemoved: () => undefined,
        })
        expect(detached.land('t', [row('a', 'A')])).toBe(false)
        expect(ledger.has('a')).toBe(false)
        expect(membership.land('t', [])).toBe(true)
    })

    it('rows held only by a topic leave when the topic closes', () => {
        const { log, removed, ledger, membership } = setup()
        const topic = "genre = 'x'"
        membership.land('sub', [row('a', 'A')])
        membership.land(topic, [row('a', 'A'), row('b', 'B')])
        log.length = 0
        membership.drop([topic])
        expect(log).toEqual(['begin', 'delete:b', 'commit'])
        expect(removed.map(r => r.id)).toEqual(['b'])
        expect(ledger.has('a')).toBe(true)
        expect(ledger.idsOf(topic)).toEqual([])
    })

    it('accept holds only rows nothing holds yet and refreshes the rest in place', () => {
        const { log, ledger, membership } = setup()
        membership.land('topic', [row('a', 'A')])
        log.length = 0
        membership.accept([row('a', 'A2', '2026-01-02 00:00:00.000Z'), row('b', 'B')])
        expect(log).toEqual(['begin', 'update:a', 'insert:b', 'commit'])
        expect(ledger.row('a')?.name).toBe('A2')
        expect(ledger.idsOf(ACCEPTED)).toEqual(['b'])
        expect(ledger.holderCount('a')).toBe(1)
    })

    it('accept of a stale copy of a held row writes nothing and adds no holder', () => {
        const { log, ledger, membership } = setup()
        membership.land('topic', [row('a', 'A', '2026-01-02 00:00:00.000Z')])
        log.length = 0
        membership.accept([row('a', 'old', '2026-01-01 00:00:00.000Z')])
        expect(log).toEqual([])
        expect(ledger.row('a')?.name).toBe('A')
        expect(ledger.idsOf(ACCEPTED)).toEqual([])
    })

    it('rolls the ledger back when a sync write throws', () => {
        const { channel, ledger, membership } = setup()
        membership.land('t', [row('a', 'A')])
        channel.write = () => {
            throw new Error('boom')
        }
        const newer = row('a', 'A2', '2026-01-02 00:00:00.000Z')
        expect(() => membership.land('t', [newer, row('b', 'B')])).toThrow()
        expect(ledger.row('a')?.name).toBe('A')
        expect(ledger.has('b')).toBe(false)
        expect(ledger.idsOf('t')).toEqual(['a'])
    })
})
