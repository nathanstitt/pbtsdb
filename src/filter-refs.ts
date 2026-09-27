/** Reference counts keyed by filter string. */
export class RefCounter {
    private readonly counts = new Map<string, number>()

    add(key: string): void {
        this.counts.set(key, (this.counts.get(key) ?? 0) + 1)
    }

    /** Drops one reference. Returns true when none remain. */
    drop(key: string): boolean {
        const count = (this.counts.get(key) ?? 0) - 1
        if (count > 0) {
            this.counts.set(key, count)
            return false
        }
        this.counts.delete(key)
        return true
    }

    has(key: string): boolean {
        return this.counts.has(key)
    }

    keys(): IterableIterator<string> {
        return this.counts.keys()
    }

    clear(): void {
        this.counts.clear()
    }
}
