import type { RecordSubscribeOptions, RecordSubscription } from 'pocketbase'
import { RefCounter } from './filter-refs'
import { logger } from './logger'
import { REALTIME_TOPIC_MAX_LENGTH, realtimeTopicLength } from './pocketbase-limits'
import type { Transport } from './transport'

export interface RealtimeSubscriptionDeps<T extends object> {
    transport: Transport
    collectionName: string
    /** An event and the topic that delivered it: `'*'` or the filter string. */
    handleEvent: (event: RecordSubscription<T>, topic: string) => void
    /** The expand union the next subscribe carries; pure, compared to detect drift. */
    pendingExpand: () => string | undefined
    /** Options for the next subscribe attempt; calls the factory callback. */
    subscribeOptions: () => RecordSubscribeOptions | undefined
    /** An entry opened, so the collections its expand reaches should be held. */
    onEntryOpened: () => void
    /**
     * The topic's entry is closed and the topic is no longer wanted, so the
     * rows it delivered lose that topic's holder. Not called for a restart,
     * which reopens the same topic.
     */
    onEntryClosed: (topic: string) => void
    /** Nothing is open and nothing is wanted. */
    onIdle: () => void
}

/**
 * The PocketBase realtime entries for one collection. The `'*'` entry covers
 * the whole collection; a filter entry covers one query filter. Filter entries
 * stay closed while `'*'` is open. Every change to what is wanted goes through
 * `reconcile`, which serializes all open and close work on one promise tail.
 */
export interface RealtimeSubscription {
    /** Counted subscribers want the whole collection. */
    addCollectionSubscriber: () => void
    dropCollectionSubscriber: () => void
    /** A query's filters, or `undefined` for the whole collection. Refs are zeroed on sync cleanup. */
    retainQueryFilters: (filters: readonly string[] | undefined) => void
    releaseQueryFilters: (filters: readonly string[] | undefined) => void
    resetQueryFilters: () => void
    /** Filters a parent's hold on this collection wants; they outlive the sync session. */
    swapHoldFilters: (previous: readonly string[], next: readonly string[]) => void
    reconcile: () => void
    /** Close every open entry and reopen what is wanted; a no-op when nothing is live. */
    restart: () => void
    isOpen: () => boolean
    /** Resolves once an entry is open; rejects when none opens within `timeout`. */
    wait: (timeout?: number) => Promise<void>
}

export function createRealtimeSubscription<T extends object>(
    deps: RealtimeSubscriptionDeps<T>
): RealtimeSubscription {
    const { collectionName } = deps

    let starUnsubscribe: (() => Promise<void>) | null = null
    let starExpand: string | undefined
    const filterEntries = new Map<
        string,
        { unsubscribe: () => Promise<void>; expand: string | undefined }
    >()
    const waiters = new Set<() => void>()

    let collectionSubscribers = 0
    let unfilteredQueryRefs = 0
    const queryRefs = new RefCounter()
    const holdRefs = new RefCounter()
    // Wanted filters whose topic is over PocketBase's cap. The realtime
    // client rejects an oversized topic before sending it, so these widen
    // to '*' instead.
    const oversizedFilters = new Set<string>()
    // Topics that opened at least once, so the ledger may hold rows under them.
    const delivered = new Set<string>()

    const isStarOpen = () => starUnsubscribe !== null
    const isOpen = () => isStarOpen() || filterEntries.size > 0
    const wantedFilters = () => new Set([...queryRefs.keys(), ...holdRefs.keys()])
    const wantsStar = () =>
        collectionSubscribers > 0 || unfilteredQueryRefs > 0 || oversizedFilters.size > 0

    function dropRef(refs: RefCounter, filter: string): void {
        if (refs.drop(filter) && !queryRefs.has(filter) && !holdRefs.has(filter)) {
            oversizedFilters.delete(filter)
        }
    }

    function notifyOpened(): void {
        deps.onEntryOpened()
        for (const resolve of waiters) resolve()
        waiters.clear()
    }

    // A failed step is logged and never poisons the tail.
    let work: Promise<void> = Promise.resolve()
    function enqueue(fn: () => Promise<void>): void {
        work = work.then(fn, fn).catch(error => {
            logger.error('Subscription work failed', { collectionName, error })
        })
    }

    async function openStar(): Promise<void> {
        if (isStarOpen()) return
        const expand = deps.pendingExpand()
        try {
            starUnsubscribe = await deps.transport.subscribe<T>(
                collectionName,
                deps.subscribeOptions(),
                event => deps.handleEvent(event, '*')
            )
            delivered.add('*')
            starExpand = expand
            logger.debug('Subscription started', { collectionName })
            notifyOpened()
        } catch (error) {
            logger.error('Failed to start subscription', { collectionName, error })
        }
    }

    async function closeStar(): Promise<void> {
        const unsubscribe = starUnsubscribe
        if (!unsubscribe) return
        // Cleared first: a throwing unsubscribe must not leave the entry open.
        starUnsubscribe = null
        starExpand = undefined
        try {
            await unsubscribe()
            logger.debug('Subscription stopped', { collectionName })
        } catch (error) {
            logger.debug('Unsubscribe failed (expected if connection closed)', {
                collectionName,
                error,
            })
        }
    }

    // A factory-supplied filter narrows every entry; the query filter narrows
    // further, so the two are conjoined.
    function filteredOptions(filter: string): RecordSubscribeOptions {
        const base = deps.subscribeOptions()
        const combined = base?.filter ? `(${base.filter}) && (${filter})` : filter
        return { ...base, filter: combined }
    }

    async function openFilter(filter: string): Promise<void> {
        if (filterEntries.has(filter)) return
        const options = filteredOptions(filter)
        const expand = deps.pendingExpand()
        try {
            const unsubscribe = await deps.transport.subscribe<T>(collectionName, options, event =>
                deps.handleEvent(event, filter)
            )
            delivered.add(filter)
            filterEntries.set(filter, { unsubscribe, expand })
            logger.debug('Filtered subscription started', { collectionName, filter })
            notifyOpened()
        } catch (error) {
            logger.error('Failed to start filtered subscription', {
                collectionName,
                filter,
                error,
            })
        }
    }

    async function closeFilter(filter: string): Promise<void> {
        const entry = filterEntries.get(filter)
        if (!entry) return
        filterEntries.delete(filter)
        try {
            await entry.unsubscribe()
            logger.debug('Filtered subscription stopped', { collectionName, filter })
        } catch (error) {
            logger.debug('Unsubscribe failed (expected if connection closed)', {
                collectionName,
                filter,
                error,
            })
        }
    }

    async function closeFilters(keep: (filter: string) => boolean = () => false): Promise<void> {
        await Promise.all([...filterEntries.keys()].filter(f => !keep(f)).map(closeFilter))
    }

    // A topic's rows stay held while its entry is open or the topic is still
    // wanted: a restart reopens the same topic, and a filter closed because
    // '*' opened comes back when '*' is no longer wanted. Runs after every
    // close in the pass has settled.
    function releaseClosedTopics(): void {
        const wanted = wantedFilters()
        for (const topic of delivered) {
            const live =
                topic === '*'
                    ? isStarOpen() || wantsStar()
                    : filterEntries.has(topic) || wanted.has(topic)
            if (live) continue
            delivered.delete(topic)
            deps.onEntryClosed(topic)
        }
    }

    // Oversized filters are found first, synchronously, so one pass can
    // decide between '*' and filter entries before any request goes out.
    async function openWantedFilters(): Promise<void> {
        if (wantsStar()) return
        const wanted = [...wantedFilters()]
        for (const filter of wanted) {
            if (filterEntries.has(filter) || oversizedFilters.has(filter)) continue
            const topicLength = realtimeTopicLength(collectionName, filteredOptions(filter))
            if (topicLength > REALTIME_TOPIC_MAX_LENGTH) {
                oversizedFilters.add(filter)
                logger.warn('Realtime filter too long; subscribing to the whole collection', {
                    collectionName,
                    filterLength: filter.length,
                    topicLength,
                })
            }
        }
        if (wantsStar()) return
        await Promise.all(wanted.map(openFilter))
    }

    // The expand union can grow while a subscribe call is in flight.
    function expandDrifted(): boolean {
        const pending = deps.pendingExpand()
        if (isStarOpen() && starExpand !== pending) return true
        for (const entry of filterEntries.values()) if (entry.expand !== pending) return true
        return false
    }

    // The single place entries are opened or closed. Wanted entries open
    // before unwanted ones close: an overlap duplicates events, a gap loses
    // them. A filter found oversized while opening flips wantsStar in this pass.
    async function doReconcile(): Promise<void> {
        await openWantedFilters()
        if (wantsStar()) {
            await openStar()
            if (isStarOpen()) await closeFilters()
        } else {
            await closeStar()
            const wanted = wantedFilters()
            await closeFilters(filter => wanted.has(filter))
        }
        releaseClosedTopics()
        if (!isOpen() && !wantsStar() && wantedFilters().size === 0) deps.onIdle()
        if (expandDrifted()) restart()
    }

    async function doRestart(): Promise<void> {
        if (!isOpen()) return
        await closeStar()
        await closeFilters()
        await doReconcile()
    }

    const reconcile = () => enqueue(doReconcile)
    const restart = () => enqueue(doRestart)

    return {
        addCollectionSubscriber() {
            collectionSubscribers += 1
        },
        dropCollectionSubscriber() {
            collectionSubscribers -= 1
        },
        retainQueryFilters(filters) {
            if (!filters) unfilteredQueryRefs += 1
            else for (const filter of filters) queryRefs.add(filter)
            reconcile()
        },
        releaseQueryFilters(filters) {
            if (!filters) unfilteredQueryRefs -= 1
            else for (const filter of filters) dropRef(queryRefs, filter)
            reconcile()
        },
        resetQueryFilters() {
            queryRefs.clear()
            unfilteredQueryRefs = 0
            for (const filter of oversizedFilters) {
                if (!holdRefs.has(filter)) oversizedFilters.delete(filter)
            }
            reconcile()
        },
        swapHoldFilters(previous, next) {
            for (const filter of next) if (!previous.includes(filter)) holdRefs.add(filter)
            for (const filter of previous) if (!next.includes(filter)) dropRef(holdRefs, filter)
            reconcile()
        },
        reconcile,
        restart,
        isOpen,
        wait(timeout = 5000) {
            if (isOpen()) return Promise.resolve()
            return new Promise((resolve, reject) => {
                const onOpen = () => {
                    clearTimeout(timer)
                    resolve()
                }
                const timer = setTimeout(() => {
                    waiters.delete(onOpen)
                    reject(new Error('Subscription timeout'))
                }, timeout)
                waiters.add(onOpen)
            })
        },
    }
}
