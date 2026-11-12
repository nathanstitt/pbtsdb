import type PocketBase from 'pocketbase'

/**
 * What `batch` needs from one built collection: its client, whether the
 * built-in handlers are in use, and the same land/evict/settle steps the
 * built-in handlers run after a successful write.
 */
export interface BatchTarget {
    pb: PocketBase
    collectionName: string
    handles: { insert: boolean; update: boolean; delete: boolean }
    land(rows: readonly object[]): void
    evict(ids: readonly string[]): Promise<void>
    settle(): Promise<void>
}

const targets = new WeakMap<object, BatchTarget>()

export function registerBatchTarget(collection: object, target: BatchTarget): void {
    targets.set(collection, target)
}

// A view is Object.create(collection), so a mutation made through a view can
// carry the view; walk up to the collection that was registered.
export function batchTargetOf(collection: object): BatchTarget | undefined {
    for (
        let current: object | null = collection;
        current;
        current = Object.getPrototypeOf(current)
    ) {
        const target = targets.get(current)
        if (target) return target
    }
    return undefined
}
