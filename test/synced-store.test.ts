import { describe, expect, it } from 'vitest'
import { createSyncedStore, type SyncChannel } from '../src/synced-store'

type Row = { id: string; name: string }

function fakeChannel() {
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
        commit: signal => {
            log.push(signal?.aborted ? 'commit:aborted' : 'commit')
            return true
        },
    }
    return { channel, log }
}

describe('synced store', () => {
    it('writes nothing and returns false with no session', () => {
        const store = createSyncedStore<Row>('rows')
        expect(store.transact([{ type: 'insert', value: { id: 'a', name: 'A' } }])).toBe(false)
        expect(store.isAttached()).toBe(false)
    })

    it('wraps the writes in one begin/commit', () => {
        const store = createSyncedStore<Row>('rows')
        const { channel, log } = fakeChannel()
        store.attach(channel)
        const receipt = store.transact([
            { type: 'insert', value: { id: 'a', name: 'A' } },
            { type: 'update', value: { id: 'b', name: 'B' } },
            { type: 'delete', key: 'c' },
        ])
        expect(receipt).toBe(true)
        expect(log).toEqual(['begin', 'insert:a', 'update:b', 'delete:c', 'commit'])
    })

    it('skips the transaction for an empty write list', () => {
        const store = createSyncedStore<Row>('rows')
        const { channel, log } = fakeChannel()
        store.attach(channel)
        expect(store.transact([])).toBe(true)
        expect(log).toEqual([])
    })

    it('aborts the transaction when a write throws, then rethrows', () => {
        const store = createSyncedStore<Row>('rows')
        const { channel, log } = fakeChannel()
        channel.write = () => {
            throw new Error('boom')
        }
        store.attach(channel)
        expect(() => store.transact([{ type: 'delete', key: 'x' }])).toThrow('sync write failed')
        expect(log).toEqual(['begin', 'commit:aborted'])
    })

    it('detach forgets only the attached channel', () => {
        const store = createSyncedStore<Row>('rows')
        const first = fakeChannel()
        const second = fakeChannel()
        store.attach(first.channel)
        store.attach(second.channel)
        store.detach(first.channel)
        expect(store.isAttached()).toBe(true)
        store.detach(second.channel)
        expect(store.isAttached()).toBe(false)
    })
})
