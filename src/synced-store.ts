import type { SyncConfig } from '@tanstack/db'

type SyncParams<T extends object> = Parameters<SyncConfig<T, string | number>['sync']>[0]

/** The part of a running sync session pbtsdb writes through. */
export type SyncChannel<T extends object> = Pick<SyncParams<T>, 'begin' | 'write' | 'commit'>

export type SyncWrite<T> = { type: 'insert' | 'update'; value: T } | { type: 'delete'; key: string }

/** pbtsdb's writes as sync transactions on the running session. */
export interface SyncedStore<T extends object> {
    /** Bind the session `sync()` was called with; replaces any earlier one. */
    attach: (channel: SyncChannel<T>) => void
    /** Forget `channel` if it is still the bound session. */
    detach: (channel: SyncChannel<T>) => void
    isAttached: () => boolean
    /**
     * Apply `writes` in one sync transaction. Returns core's commit receipt
     * unchanged (`true` when already visible), or false with no session bound.
     */
    transact: (writes: readonly SyncWrite<T>[]) => true | Promise<void> | false
}

export function createSyncedStore<T extends object>(collectionName: string): SyncedStore<T> {
    let session: SyncChannel<T> | undefined

    return {
        attach(channel) {
            session = channel
        },
        detach(channel) {
            if (session === channel) session = undefined
        },
        isAttached: () => session !== undefined,
        transact(writes) {
            const channel = session
            if (!channel) return false
            if (writes.length === 0) return true
            channel.begin()
            try {
                for (const write of writes) channel.write(write)
            } catch (error) {
                const cancel = new AbortController()
                cancel.abort()
                channel.commit(cancel.signal)
                throw new Error(`${collectionName}: sync write failed`, { cause: error })
            }
            // Returned unchanged: `whenSyncAccepted` reads the acceptance
            // moment core attaches to this promise, and a `.then()` copy
            // would lose it.
            return channel.commit()
        },
    }
}
