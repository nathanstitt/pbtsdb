import { ACCEPTED, type Holder, type Ledger, type LedgerWrites } from './ledger'
import { idOf, idsOf } from './records'
import type { SyncedStore, SyncWrite } from './synced-store'

/** A commit receipt, or false when no sync session is running. */
export type Applied = true | Promise<void> | false

export interface MembershipDeps<T extends object> {
    collectionName: string
    ledger: Ledger<T>
    store: SyncedStore<T>
    /** Rows that left the store, for mark bookkeeping. */
    onRemoved: (rows: readonly T[]) => void
}

/**
 * Ledger changes as sync transactions. Every row the store gains or loses
 * goes through here (see docs/internals.md, "Ledger").
 */
export interface Membership<T extends object> {
    /** Reference `rows` for `holder`; new and newer rows are written. */
    land: (holder: Holder, rows: readonly T[]) => Applied
    /**
     * Land server-confirmed rows. A row nothing holds yet takes the
     * `ACCEPTED` holder; a row already held is refreshed in place and gains
     * no holder, so a write-back never outlives the holders a query or
     * topic gave the row.
     */
    accept: (rows: readonly T[]) => Applied
    /**
     * Make `rows` exactly what `holder` references; rows it no longer holds
     * may leave. `releaseAlso` holders release `rows` in the same
     * transaction; `holder` keeps each of them, so none leaves.
     */
    reconcile: (holder: Holder, rows: readonly T[], releaseAlso?: readonly Holder[]) => Applied
    /** Release `holders` from the `ids` that `keeper` references; `keeper` keeps each row. */
    confirm: (keeper: Holder, holders: readonly Holder[], ids: Iterable<string>) => Applied
    /** Release `ids` (all of theirs when omitted) from `holders`; rows at zero leave. */
    drop: (holders: readonly Holder[], ids?: Iterable<string>) => Applied
    /** Remove `ids` from every holder. */
    dropAll: (ids: Iterable<string>) => Applied
    /** Reference the stored rows among `ids` for each of `holders`; no row changes. */
    hold: (holders: readonly Holder[], ids: Iterable<string>) => Applied
}

type Change<T> = { writes: SyncWrite<T>[]; gone: T[] }

const NO_WRITES = { inserted: [], updated: [] }

export function createMembership<T extends object>(deps: MembershipDeps<T>): Membership<T> {
    const { ledger, store } = deps

    // One write per id, in input order rather than insert/update bucket
    // order: a duplicate id in `rows` must write once, not once per
    // occurrence, and always as the final ledger row, since that is the
    // object core tracks by identity once the transaction lands.
    function writesFor(
        rows: readonly T[],
        changes: LedgerWrites<T>,
        removed: readonly string[]
    ): SyncWrite<T>[] {
        const inserted = new Set(changes.inserted.map(idOf))
        const updated = new Set(changes.updated.map(idOf))
        const seen = new Set<string>()
        const writes: SyncWrite<T>[] = []
        for (const row of rows) {
            const id = idOf(row)
            if (id === undefined || seen.has(id) || !(inserted.has(id) || updated.has(id))) continue
            const stored = ledger.row(id)
            if (stored === undefined) continue
            seen.add(id)
            writes.push({ type: inserted.has(id) ? 'insert' : 'update', value: stored })
        }
        for (const key of removed) writes.push({ type: 'delete', key })
        return writes
    }

    function rowsBefore(ids: readonly string[]): Map<string, T> {
        const rows = new Map<string, T>()
        for (const id of ids) {
            const row = ledger.row(id)
            if (row) rows.set(id, row)
        }
        return rows
    }

    function pick(rows: Map<string, T>, ids: readonly string[]): T[] {
        return ids.map(id => rows.get(id)).filter((row): row is T => row !== undefined)
    }

    // Releases a holder from rows another holder still references, so no row
    // can reach zero; a removal here is a bug and rolls the change back.
    function releaseKept(keeper: Holder, holders: readonly Holder[], ids: Iterable<string>): void {
        const kept = new Set(ledger.idsOf(keeper))
        const covered = [...ids].filter(id => kept.has(id))
        for (const holder of holders) {
            const removed = ledger.release(holder, covered)
            if (removed.length > 0) {
                throw new Error(
                    `${deps.collectionName}: releasing a kept row removed ${removed.join(', ')}`
                )
            }
        }
    }

    // The ledger change and its sync transaction succeed or fail together:
    // a throwing write rolls the ledger back, so the two never disagree.
    function apply(change: () => Change<T>): Applied {
        if (!store.isAttached()) return false
        const tracked = ledger.track()
        let receipt: Applied
        let gone: T[]
        try {
            const result = change()
            gone = result.gone
            receipt = store.transact(result.writes)
        } catch (error) {
            tracked.rollback()
            throw error
        }
        tracked.commit()
        if (gone.length > 0) deps.onRemoved(gone)
        return receipt
    }

    return {
        land: (holder, rows) =>
            apply(() => ({ writes: writesFor(rows, ledger.retain(holder, rows), []), gone: [] })),
        accept: rows =>
            apply(() => {
                const held = new Set(idsOf(rows).filter(id => ledger.has(id)))
                const fresh = rows.filter(row => !held.has(idOf(row) ?? ''))
                const stale = rows.filter(row => held.has(idOf(row) ?? ''))
                const retained = ledger.retain(ACCEPTED, fresh)
                const refreshed = ledger.refresh(stale)
                const changes = {
                    inserted: [...retained.inserted, ...refreshed.inserted],
                    updated: [...retained.updated, ...refreshed.updated],
                }
                return { writes: writesFor(rows, changes, []), gone: [] }
            }),
        reconcile: (holder, rows, releaseAlso = []) =>
            apply(() => {
                const before = rowsBefore(ledger.idsOf(holder))
                const { removed, ...changes } = ledger.replace(holder, rows)
                releaseKept(holder, releaseAlso, idsOf(rows))
                return { writes: writesFor(rows, changes, removed), gone: pick(before, removed) }
            }),
        confirm: (keeper, holders, ids) =>
            apply(() => {
                releaseKept(keeper, holders, ids)
                return { writes: [], gone: [] }
            }),
        drop: (holders, ids) =>
            apply(() => {
                const listed = ids ? [...ids] : undefined
                const removed: string[] = []
                const gone: T[] = []
                for (const holder of holders) {
                    const held = listed ?? ledger.idsOf(holder)
                    const before = rowsBefore(held)
                    const released = ledger.release(holder, held)
                    removed.push(...released)
                    gone.push(...pick(before, released))
                }
                return { writes: writesFor([], NO_WRITES, removed), gone }
            }),
        hold: (holders, ids) =>
            apply(() => {
                const listed = [...ids]
                for (const holder of holders) ledger.hold(holder, listed)
                return { writes: [], gone: [] }
            }),
        dropAll: ids =>
            apply(() => {
                const present = [...new Set(ids)].filter(id => ledger.has(id))
                const gone = pick(rowsBefore(present), present)
                for (const id of present) ledger.releaseAll(id)
                return { writes: writesFor([], NO_WRITES, present), gone }
            }),
    }
}
