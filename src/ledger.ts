import { idOf, idsOf, updatedAtOf } from './records'

/** Something that keeps a row in the store: a subset, a topic filter, a hold, or a sentinel. */
export type Holder = object | string

/** Rows a retain or replace must write: new to the store, or replaced in it. */
export interface LedgerWrites<T> {
    inserted: T[]
    updated: T[]
}

/** The ledger changes made since `track()`, kept or undone as one unit. */
export interface LedgerChange {
    commit: () => void
    rollback: () => void
}

/**
 * Every synced row with the holders that reference it. A row is in the store
 * while at least one holder references it.
 */
export interface Ledger<T extends object> {
    row: (id: string) => T | undefined
    has: (id: string) => boolean
    rows: () => IterableIterator<T>
    size: () => number
    idsOf: (holder: Holder) => string[]
    holderCount: (id: string) => number
    /**
     * Reference `rows` for `holder`. A row that is new or not older is stored
     * as a new object: the stored row merged with the incoming one.
     */
    retain: (holder: Holder, rows: readonly T[]) => LedgerWrites<T>
    /** Replace stored rows with `rows` under the same rule as `retain`, adding no holder; a row not stored is skipped. */
    refresh: (rows: readonly T[]) => LedgerWrites<T>
    /** Drop `holder`'s reference to `ids` (all of them when omitted). Returns ids with no holder left, now removed. */
    release: (holder: Holder, ids?: Iterable<string>) => string[]
    /** Set `holder`'s references to exactly `rows`. */
    replace: (holder: Holder, rows: readonly T[]) => LedgerWrites<T> & { removed: string[] }
    /** Remove the row from every holder. False when absent. */
    releaseAll: (id: string) => boolean
    /** Every holder that references at least one row. */
    holders: () => Holder[]
    /** Record every change from now on, so the caller can undo it if its sync write throws. */
    track: () => LedgerChange
    clear: () => void
}

/** Rows a mutation write-back or `accept()` landed; released once a subset or topic covers them. */
export const ACCEPTED: Holder = { holder: 'accepted' }
/** The whole collection, in eager mode. */
export const EAGER: Holder = { holder: 'eager' }

type Entry<T> = { row: T; holders: Set<Holder> }

export function createLedger<T extends object>(): Ledger<T> {
    const entries = new Map<string, Entry<T>>()
    const byHolder = new Map<Holder, Set<string>>()
    let journal: (() => void)[] | undefined

    function link(id: string, entry: Entry<T>, holder: Holder): void {
        if (entry.holders.has(holder)) return
        entry.holders.add(holder)
        let ids = byHolder.get(holder)
        if (!ids) {
            ids = new Set()
            byHolder.set(holder, ids)
        }
        ids.add(id)
        journal?.push(() => unlink(id, entry, holder))
    }

    function unlink(id: string, entry: Entry<T>, holder: Holder): void {
        if (!entry.holders.delete(holder)) return
        const ids = byHolder.get(holder)
        ids?.delete(id)
        if (ids?.size === 0) byHolder.delete(holder)
        journal?.push(() => link(id, entry, holder))
    }

    function put(id: string, entry: Entry<T>): void {
        entries.set(id, entry)
        journal?.push(() => {
            entries.delete(id)
        })
    }

    function remove(id: string, entry: Entry<T>): void {
        entries.delete(id)
        journal?.push(() => {
            entries.set(id, entry)
        })
    }

    function setRow(entry: Entry<T>, row: T): void {
        const previous = entry.row
        entry.row = row
        journal?.push(() => {
            entry.row = previous
        })
    }

    function isOlder(incoming: T, current: T): boolean {
        const next = updatedAtOf(incoming)
        const now = updatedAtOf(current)
        return next !== undefined && now !== undefined && next < now
    }

    // The collection declares rowUpdateMode 'full', so core stores the
    // written object as is. Merging here keeps a partial realtime payload
    // (a factory `fields` option) from dropping fields, and keeps this row
    // equal to core's.
    function update(entry: Entry<T>, incoming: T, writes: LedgerWrites<T>): void {
        if (entry.row === incoming || isOlder(incoming, entry.row)) return
        setRow(entry, { ...entry.row, ...incoming })
        writes.updated.push(entry.row)
    }

    function retain(holder: Holder, rows: readonly T[]): LedgerWrites<T> {
        const writes: LedgerWrites<T> = { inserted: [], updated: [] }
        for (const incoming of rows) {
            const id = idOf(incoming)
            if (id === undefined) continue
            const entry = entries.get(id)
            if (!entry) {
                const created: Entry<T> = { row: { ...incoming }, holders: new Set() }
                put(id, created)
                link(id, created, holder)
                writes.inserted.push(created.row)
                continue
            }
            link(id, entry, holder)
            update(entry, incoming, writes)
        }
        return writes
    }

    function refresh(rows: readonly T[]): LedgerWrites<T> {
        const writes: LedgerWrites<T> = { inserted: [], updated: [] }
        for (const incoming of rows) {
            const id = idOf(incoming)
            const entry = id === undefined ? undefined : entries.get(id)
            if (entry) update(entry, incoming, writes)
        }
        return writes
    }

    function release(holder: Holder, ids?: Iterable<string>): string[] {
        const held = byHolder.get(holder)
        if (!held) return []
        const removed: string[] = []
        for (const id of ids ? [...ids] : [...held]) {
            const entry = entries.get(id)
            if (!entry || !held.has(id)) continue
            unlink(id, entry, holder)
            if (entry.holders.size === 0) {
                remove(id, entry)
                removed.push(id)
            }
        }
        return removed
    }

    return {
        row: id => entries.get(id)?.row,
        has: id => entries.has(id),
        rows: function* rows() {
            for (const entry of entries.values()) yield entry.row
        },
        size: () => entries.size,
        idsOf: holder => [...(byHolder.get(holder) ?? [])],
        holderCount: id => entries.get(id)?.holders.size ?? 0,
        retain,
        refresh,
        release,
        replace(holder, rows) {
            const keep = new Set(idsOf(rows))
            const stale = [...(byHolder.get(holder) ?? [])].filter(id => !keep.has(id))
            const writes = retain(holder, rows)
            return { ...writes, removed: release(holder, stale) }
        },
        releaseAll(id) {
            const entry = entries.get(id)
            if (!entry) return false
            for (const holder of [...entry.holders]) unlink(id, entry, holder)
            remove(id, entry)
            return true
        },
        holders: () => [...byHolder.keys()],
        track() {
            const undo: (() => void)[] = []
            journal = undo
            const stop = () => {
                if (journal === undo) journal = undefined
            }
            return {
                commit() {
                    stop()
                    undo.length = 0
                },
                rollback() {
                    stop()
                    for (const step of undo.reverse()) step()
                    undo.length = 0
                },
            }
        },
        clear() {
            entries.clear()
            byHolder.clear()
        },
    }
}
