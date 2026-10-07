import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { createSyncedStore, type SyncChannel } from '../src/synced-store'

type Row = { id: string; name: string }
type Message = Parameters<SyncChannel<Row>['write']>[0]

// A sync session that records each transaction against an in-memory store.
function fakeSession(initial: Row[] = []) {
    const rows = new Map(initial.map(row => [row.id, row]))
    const committed: Message[][] = []
    let open: Message[] | undefined
    const channel: SyncChannel<Row> = {
        begin: () => {
            open = []
        },
        write: message => {
            open?.push(message)
            if ('key' in message) rows.delete(String(message.key))
            else rows.set(message.value.id, message.value)
        },
        commit: signal => {
            if (!signal?.aborted && open) committed.push(open)
            open = undefined
            return true
        },
    }
    return { rows, committed, channel }
}

function storeFor(session: ReturnType<typeof fakeSession>, queryClient = new QueryClient()) {
    const store = createSyncedStore<Row>({
        collectionName: 'rows',
        queryClient,
        acceptedRow: id => session.rows.get(id),
    })
    store.attach(session.channel)
    return store
}

describe('createSyncedStore', () => {
    it('writes nothing without a sync session', () => {
        const session = fakeSession()
        const store = storeFor(session)
        store.detach(session.channel)
        expect(store.apply([{ id: 'a', name: 'A' }])).toBe(false)
        expect(session.committed).toEqual([])
    })

    it('inserts an absent row and updates a present one in one transaction', () => {
        const session = fakeSession([{ id: 'a', name: 'old' }])
        const store = storeFor(session)
        expect(
            store.apply([
                { id: 'a', name: 'new' },
                { id: 'b', name: 'B' },
            ])
        ).toBe(true)
        expect(session.committed).toHaveLength(1)
        expect(session.committed[0].map(message => message.type)).toEqual(['update', 'insert'])
    })

    it('writes a copy of each row', () => {
        const session = fakeSession()
        const store = storeFor(session)
        const row = { id: 'a', name: 'A' }
        store.apply([row])
        row.name = 'changed by the caller'
        expect(session.rows.get('a')).toEqual({ id: 'a', name: 'A' })
    })

    it('skips a delete of an absent row but still removes it from cached results', () => {
        const session = fakeSession([{ id: 'a', name: 'A' }])
        const queryClient = new QueryClient()
        queryClient.setQueryData(['rows', { filter: 'x' }], [{ id: 'gone', name: 'G' }])
        const store = storeFor(session, queryClient)
        expect(store.apply([], ['gone'])).toBe(true)
        expect(session.committed).toEqual([])
        expect(queryClient.getQueryData(['rows', { filter: 'x' }])).toEqual([])
    })

    it('claims written rows in every cached query of the collection', () => {
        const session = fakeSession([{ id: 'a', name: 'A' }])
        const queryClient = new QueryClient()
        queryClient.setQueryData(['rows'], [{ id: 'a', name: 'A' }])
        queryClient.setQueryData(['rows', { filter: 'y' }], [])
        queryClient.setQueryData(['other'], [{ id: 'a', name: 'A' }])
        const store = storeFor(session, queryClient)
        store.apply(
            [
                { id: 'a', name: 'A2' },
                { id: 'b', name: 'B' },
            ],
            []
        )
        expect(queryClient.getQueryData(['rows'])).toEqual([
            { id: 'a', name: 'A2' },
            { id: 'b', name: 'B' },
        ])
        expect(queryClient.getQueryData(['rows', { filter: 'y' }])).toEqual([
            { id: 'a', name: 'A2' },
            { id: 'b', name: 'B' },
        ])
        expect(queryClient.getQueryData(['other'])).toEqual([{ id: 'a', name: 'A' }])
    })

    it('cancels the transaction when a write throws', () => {
        const session = fakeSession()
        const failing: SyncChannel<Row> = {
            ...session.channel,
            write: () => {
                throw new Error('rejected')
            },
        }
        const store = storeFor(session)
        store.attach(failing)
        expect(() => store.apply([{ id: 'a', name: 'A' }])).toThrow('rejected')
        expect(session.committed).toEqual([])
    })
})
