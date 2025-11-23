import PocketBase from 'pocketbase';
import type { UnsubscribeFunc } from 'pocketbase';
import type { Collection } from "@tanstack/db"
import type { RealtimeEvent, SubscriptionState } from './types';
import { logger } from './logger';

/**
 * Subscription configuration constants.
 * Controls reconnection behavior and timing.
 */
export const SUBSCRIPTION_CONFIG = {
    /** Maximum number of reconnection attempts before giving up */
    MAX_RECONNECT_ATTEMPTS: 5,

    /** Base delay in milliseconds for reconnection (uses exponential backoff) */
    BASE_RECONNECT_DELAY_MS: 1000,

    /** Default timeout in milliseconds for waitForSubscription */
    DEFAULT_WAIT_TIMEOUT_MS: 5000,

    /** Delay in milliseconds before unsubscribing after last query unmounts (prevents thrashing) */
    CLEANUP_DELAY_MS: 5000,
} as const;

/**
 * Type guard to check if a value has an 'id' field.
 * PocketBase records always include an id field.
 */
function hasId(record: unknown): record is { id: string } {
    return typeof record === 'object'
        && record !== null
        && 'id' in record
        && typeof (record as { id: unknown }).id === 'string';
}

/**
 * Creates a pending subscription state with default values.
 * Used when initializing subscriptions before they're fully established.
 */
function createPendingSubscriptionState(recordId?: string): SubscriptionState {
    return {
        unsubscribe: async () => { /* will be replaced */ },
        recordId,
        reconnectAttempts: 0,
        isReconnecting: false,
    };
}

/**
 * Gets the subscription key for a given record ID.
 * Returns '*' for collection-wide subscriptions, or the specific record ID.
 */
function getSubscriptionKey(recordId?: string): string {
    return recordId || '*';
}


/**
 * Manages real-time subscriptions to PocketBase collections.
 * Handles subscription lifecycle, reconnection with exponential backoff,
 * and automatic synchronization with TanStack DB collections.
 *
 * Subscriptions are automatically managed based on TanStack DB's subscriber count:
 * - Start subscribing when first query becomes active
 * - Stop subscribing when last query becomes inactive (with cleanup delay)
 */
export class SubscriptionManager {
    private subscriptions: Map<string, Map<string, SubscriptionState>> = new Map();
    private subscriptionPromises: Map<string, Map<string, Promise<void>>> = new Map();
    private cleanupTimers: Map<string, NodeJS.Timeout> = new Map();
    private subscriberCounts: Map<string, number> = new Map();

    constructor(private pocketbase: PocketBase) {}

    // ============================================================================
    // Internal Helpers
    // ============================================================================

    /**
     * Setup real-time subscription for a collection.
     * Returns an unsubscribe function.
     */
    private async setupSubscription<T extends object>(
        collectionName: string,
        collection: Collection<T>,
        recordId?: string
    ): Promise<UnsubscribeFunc> {
        const subscriptionKey = getSubscriptionKey(recordId);

        const eventHandler = (event: RealtimeEvent<T>) => {
            // Use direct writes to sync changes to TanStack DB
            collection.utils.writeBatch(() => {
                switch (event.action) {
                    case 'create':
                        collection.utils.writeInsert(event.record);
                        break;
                    case 'update':
                        collection.utils.writeUpdate(event.record);
                        break;
                    case 'delete':
                        // Type guard to ensure record has id field
                        if (!hasId(event.record)) {
                            logger.error('Delete event record missing id field', {
                                collectionName,
                                record: event.record
                            });
                            return;
                        }
                        collection.utils.writeDelete(event.record.id);
                        break;
                }
            });
        };

        // Subscribe to PocketBase real-time updates
        const unsubscribe = await this.pocketbase
            .collection(collectionName)
            .subscribe(subscriptionKey, eventHandler);

        logger.debug('Subscription established', { collectionName, subscriptionKey });

        return unsubscribe;
    }

    /**
     * Handle reconnection with exponential backoff.
     * Attempts to reestablish a failed subscription.
     */
    private async handleReconnection<T extends object>(
        collectionName: string,
        collection: Collection<T>,
        recordId?: string
    ): Promise<void> {
        const collectionSubs = this.subscriptions.get(collectionName);
        if (!collectionSubs) return;

        const subscriptionKey = getSubscriptionKey(recordId);
        const state = collectionSubs.get(subscriptionKey);
        if (!state || state.isReconnecting) return;

        state.isReconnecting = true;
        logger.warn('Starting reconnection attempts', { collectionName, subscriptionKey });

        while (state.reconnectAttempts < SUBSCRIPTION_CONFIG.MAX_RECONNECT_ATTEMPTS) {
            const delay = SUBSCRIPTION_CONFIG.BASE_RECONNECT_DELAY_MS * Math.pow(2, state.reconnectAttempts);
            logger.debug(`Reconnection attempt ${state.reconnectAttempts + 1}, waiting ${delay}ms`, {
                collectionName,
                subscriptionKey
            });
            await new Promise(resolve => setTimeout(resolve, delay));

            try {
                // Attempt to resubscribe
                const newUnsubscribe = await this.setupSubscription(
                    collectionName,
                    collection,
                    recordId
                );

                state.unsubscribe = newUnsubscribe;
                state.reconnectAttempts = 0;
                state.isReconnecting = false;
                logger.debug('Reconnection successful', { collectionName, subscriptionKey });
                return;
            } catch (error) {
                state.reconnectAttempts++;
                logger.warn(`Reconnection attempt ${state.reconnectAttempts} failed`, {
                    collectionName,
                    subscriptionKey,
                    error
                });
            }
        }

        // Max attempts reached, give up
        logger.error('Max reconnection attempts reached, giving up', {
            collectionName,
            subscriptionKey,
            attempts: state.reconnectAttempts
        });
        state.isReconnecting = false;
        collectionSubs.delete(subscriptionKey);
    }

    // ============================================================================
    // Core Subscription Methods
    // ============================================================================

    /**
     * Subscribe to real-time updates for a collection.
     * Returns a promise that resolves when the subscription is fully established.
     *
     * @param collectionName - The PocketBase collection name
     * @param collection - The TanStack DB collection to sync with
     * @param recordId - Optional: Subscribe to specific record, or omit for collection-wide updates
     */
    async subscribe<T extends object>(
        collectionName: string,
        collection: Collection<T>,
        recordId?: string
    ): Promise<void> {
        if (!this.subscriptions.has(collectionName)) {
            this.subscriptions.set(collectionName, new Map());
        }
        if (!this.subscriptionPromises.has(collectionName)) {
            this.subscriptionPromises.set(collectionName, new Map());
        }

        const collectionSubs = this.subscriptions.get(collectionName)!;
        const collectionPromises = this.subscriptionPromises.get(collectionName)!;
        const subscriptionKey = getSubscriptionKey(recordId);

        // Don't subscribe if already subscribed
        if (collectionSubs.has(subscriptionKey)) {
            logger.debug('Already subscribed, skipping', { collectionName, subscriptionKey });
            return;
        }

        // If there's already a pending subscription promise, wait for it
        const existingPromise = collectionPromises.get(subscriptionKey);
        if (existingPromise) {
            logger.debug('Pending subscription found, waiting', { collectionName, subscriptionKey });
            return existingPromise;
        }

        // Create a placeholder subscription state immediately (synchronous)
        // This ensures isSubscribed() returns true right away
        collectionSubs.set(subscriptionKey, createPendingSubscriptionState(recordId));

        // Create the subscription promise
        const subscriptionPromise = (async () => {
            try {
                // Setup subscription and wait for it to complete
                const unsubscribe = await this.setupSubscription(collectionName, collection, recordId);

                // Replace placeholder with actual unsubscribe function
                const state = collectionSubs.get(subscriptionKey);
                if (state) {
                    state.unsubscribe = unsubscribe;
                }
            } catch (error) {
                // Remove placeholder on error
                collectionSubs.delete(subscriptionKey);
                // Clean up promise on error
                collectionPromises.delete(subscriptionKey);
                logger.error('Subscription failed', { collectionName, subscriptionKey, error });
                // Handle subscription error - try to reconnect
                await this.handleReconnection(collectionName, collection, recordId);
                throw error; // Re-throw so callers know it failed
            }
            // Note: We DON'T clean up the promise in finally - we keep it so
            // waitForSubscription can check if subscription is complete
        })();

        // Store the promise so waitForSubscription can use it
        collectionPromises.set(subscriptionKey, subscriptionPromise);

        // Wait for the promise to complete
        try {
            await subscriptionPromise;
            // Successfully subscribed, keep the promise in the map
            // It will be cleaned up when unsubscribing
        } catch (_error) {
            // Error already handled above
        }
    }

    /**
     * Unsubscribe from real-time updates.
     *
     * @param collectionName - The PocketBase collection name
     * @param recordId - Optional: Unsubscribe from specific record, or omit for collection-wide
     */
    unsubscribe(collectionName: string, recordId?: string): void {
        const collectionSubs = this.subscriptions.get(collectionName);
        if (!collectionSubs) return;

        const subscriptionKey = getSubscriptionKey(recordId);
        const state = collectionSubs.get(subscriptionKey);

        if (state) {
            // PocketBase unsubscribe returns a promise - handle it to avoid unhandled rejections
            const unsubPromise = state.unsubscribe();
            if (unsubPromise && typeof unsubPromise.catch === 'function') {
                unsubPromise.catch((error) => {
                    logger.debug('Unsubscribe failed (expected if connection closed)', {
                        collectionName,
                        subscriptionKey,
                        error
                    });
                });
            }
            collectionSubs.delete(subscriptionKey);
            logger.debug('Unsubscribed', { collectionName, subscriptionKey });
        }

        // Clean up the promise map
        const collectionPromises = this.subscriptionPromises.get(collectionName);
        if (collectionPromises) {
            collectionPromises.delete(subscriptionKey);
            if (collectionPromises.size === 0) {
                this.subscriptionPromises.delete(collectionName);
            }
        }

        // Clean up collection map if empty
        if (collectionSubs.size === 0) {
            this.subscriptions.delete(collectionName);
        }
    }

    /**
     * Unsubscribe from all subscriptions for a collection.
     *
     * @param collectionName - The PocketBase collection name
     */
    unsubscribeAll(collectionName: string): void {
        const collectionSubs = this.subscriptions.get(collectionName);
        if (!collectionSubs) return;

        logger.debug('Unsubscribing from all subscriptions', { collectionName, count: collectionSubs.size });

        for (const state of collectionSubs.values()) {
            // PocketBase unsubscribe returns a promise - handle it to avoid unhandled rejections
            const unsubPromise = state.unsubscribe();
            if (unsubPromise && typeof unsubPromise.catch === 'function') {
                unsubPromise.catch((error) => {
                    logger.debug('Unsubscribe failed (expected if connection closed)', {
                        collectionName,
                        error
                    });
                });
            }
        }

        this.subscriptions.delete(collectionName);
        this.subscriptionPromises.delete(collectionName);
    }

    // ============================================================================
    // State Queries
    // ============================================================================

    /**
     * Check if subscribed to a collection.
     *
     * @param collectionName - The PocketBase collection name
     * @param recordId - Optional: Check specific record subscription, or omit for collection-wide
     */
    isSubscribed(collectionName: string, recordId?: string): boolean {
        const collectionSubs = this.subscriptions.get(collectionName);
        if (!collectionSubs) return false;

        const subscriptionKey = getSubscriptionKey(recordId);
        return collectionSubs.has(subscriptionKey);
    }

    /**
     * Wait for a subscription to be fully established (useful for testing).
     *
     * @param collectionName - The collection name
     * @param recordId - Optional specific record ID
     * @param timeoutMs - Timeout in milliseconds
     */
    async waitForSubscription(
        collectionName: string,
        recordId?: string,
        timeoutMs: number = SUBSCRIPTION_CONFIG.DEFAULT_WAIT_TIMEOUT_MS
    ): Promise<void> {
        const subscriptionKey = getSubscriptionKey(recordId);

        // Check if already subscribed (no pending promise)
        const collectionSubs = this.subscriptions.get(collectionName);
        if (collectionSubs?.has(subscriptionKey)) {
            // Already subscribed, check if the promise is complete
            const collectionPromises = this.subscriptionPromises.get(collectionName);
            if (!collectionPromises?.has(subscriptionKey)) {
                // No pending promise means subscription is complete
                return;
            }
        }

        // Get the pending promise
        const collectionPromises = this.subscriptionPromises.get(collectionName);
        const promise = collectionPromises?.get(subscriptionKey);

        if (!promise) {
            // No subscription at all - this might be disabled
            const isSubscribed = collectionSubs?.has(subscriptionKey);
            if (!isSubscribed) {
                throw new Error(`No subscription found for ${collectionName}:${subscriptionKey}. Did you disable auto-subscriptions?`);
            }
            // Subscribed but no promise (shouldn't happen, but handle gracefully)
            return;
        }

        // Wait for the subscription promise with timeout
        const timeoutPromise = new Promise<void>((_, reject) => {
            setTimeout(() => reject(new Error(`Subscription timeout after ${timeoutMs}ms`)), timeoutMs);
        });

        await Promise.race([promise, timeoutPromise]);
    }

    // ============================================================================
    // Lifecycle Management
    // ============================================================================

    /**
     * Track subscriber addition for a collection.
     * Automatically subscribes when first subscriber is added.
     *
     * @param collectionName - The PocketBase collection name
     * @param collection - The TanStack DB collection to sync with
     */
    async addSubscriber<T extends object>(
        collectionName: string,
        collection: Collection<T>
    ): Promise<void> {
        const currentCount = this.subscriberCounts.get(collectionName) || 0;
        const newCount = currentCount + 1;
        this.subscriberCounts.set(collectionName, newCount);

        logger.debug('Subscriber added', { collectionName, count: newCount });

        // Cancel any pending cleanup
        const cleanupTimer = this.cleanupTimers.get(collectionName);
        if (cleanupTimer) {
            clearTimeout(cleanupTimer);
            this.cleanupTimers.delete(collectionName);
            logger.debug('Cleanup timer cancelled', { collectionName });
        }

        // Subscribe when first subscriber is added
        if (newCount === 1 && !this.isSubscribed(collectionName)) {
            logger.debug('First subscriber - starting subscription', { collectionName });
            await this.subscribe(collectionName, collection);
        }
    }

    /**
     * Track subscriber removal for a collection.
     * Automatically unsubscribes (with delay) when last subscriber is removed.
     *
     * @param collectionName - The PocketBase collection name
     */
    removeSubscriber(collectionName: string): void {
        const currentCount = this.subscriberCounts.get(collectionName) || 0;
        const newCount = Math.max(0, currentCount - 1);
        this.subscriberCounts.set(collectionName, newCount);

        logger.debug('Subscriber removed', { collectionName, count: newCount });

        // Schedule cleanup when last subscriber is removed
        if (newCount === 0) {
            // Cancel any existing cleanup timer
            const existingTimer = this.cleanupTimers.get(collectionName);
            if (existingTimer) {
                clearTimeout(existingTimer);
            }

            // Schedule unsubscribe with delay to prevent thrashing
            const cleanupTimer = setTimeout(() => {
                // Double-check subscriber count is still 0
                const finalCount = this.subscriberCounts.get(collectionName) || 0;
                if (finalCount === 0) {
                    logger.debug('Cleanup timer fired - unsubscribing', { collectionName });
                    this.unsubscribeAll(collectionName);
                    this.subscriberCounts.delete(collectionName);
                }
                this.cleanupTimers.delete(collectionName);
            }, SUBSCRIPTION_CONFIG.CLEANUP_DELAY_MS);

            this.cleanupTimers.set(collectionName, cleanupTimer);
            logger.debug('Cleanup timer scheduled', {
                collectionName,
                delayMs: SUBSCRIPTION_CONFIG.CLEANUP_DELAY_MS
            });
        }
    }

    /**
     * Get the current subscriber count for a collection.
     * Useful for debugging and testing.
     *
     * @param collectionName - The PocketBase collection name
     * @returns Current subscriber count
     */
    getSubscriberCount(collectionName: string): number {
        return this.subscriberCounts.get(collectionName) || 0;
    }
}
