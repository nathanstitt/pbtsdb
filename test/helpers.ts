import { QueryClient } from '@tanstack/react-query'
import { waitFor } from '@testing-library/react'
import PocketBase from 'pocketbase'
import { expect } from 'vitest'
import 'dotenv/config'
import { createCollection, type Logger, newRecordId, resetLogger, setLogger } from '../src'
import type { Schema } from './schema'

export { newRecordId }

/**
 * Captures log messages during tests.
 * Call createTestLogger() to get a logger that stores messages in arrays.
 */
export interface TestLogger extends Logger {
    messages: {
        debug: Array<{ msg: string; context?: object }>
        info: Array<{ msg: string; context?: object }>
        warn: Array<{ msg: string; context?: object }>
        error: Array<{ msg: string; context?: object }>
    }
    clear: () => void
}

/**
 * Creates a test logger that captures all log messages.
 * Use with setLogger() to capture messages during tests.
 */
export function createTestLogger(): TestLogger {
    const messages: TestLogger['messages'] = {
        debug: [],
        info: [],
        warn: [],
        error: [],
    }

    return {
        messages,
        debug: (msg: string, context?: object) => {
            messages.debug.push({ msg, context })
        },
        info: (msg: string, context?: object) => {
            messages.info.push({ msg, context })
        },
        warn: (msg: string, context?: object) => {
            messages.warn.push({ msg, context })
        },
        error: (msg: string, context?: object) => {
            messages.error.push({ msg, context })
        },
        clear: () => {
            messages.debug = []
            messages.info = []
            messages.warn = []
            messages.error = []
        },
    }
}

export { resetLogger, setLogger }

if (!process.env.TESTING_PB_ADDR) {
    throw new Error('TESTING_PB_ADDR environment variable is not set')
}

export const pb = new PocketBase(process.env.TESTING_PB_ADDR)
pb.autoCancellation(false)

/**
 * Create a fresh QueryClient for testing with appropriate settings
 */
export function createTestQueryClient(): QueryClient {
    return new QueryClient({
        defaultOptions: {
            queries: {
                retry: false,
                gcTime: 30000,
            },
        },
    })
}

/**
 * Authenticate with PocketBase using test credentials
 */
export async function authenticateTestUser(): Promise<void> {
    const { TEST_USER_EMAIL, TEST_USER_PW } = process.env
    if (!TEST_USER_EMAIL || !TEST_USER_PW) {
        throw new Error('TEST_USER_EMAIL and TEST_USER_PW environment variables must be set')
    }
    await pb.collection('users').authWithPassword(TEST_USER_EMAIL, TEST_USER_PW)
}

/**
 * Clear PocketBase authentication
 */
export function clearAuth(): void {
    pb.authStore.clear()
}

/**
 * Get a unique timestamp-based slug for test data (non-ID fields like ISBN)
 */
export function getTestSlug(prefix = 'test'): string {
    const timestamp = Date.now().toString().slice(-8)
    return `${prefix}-${timestamp}`
}

/**
 * Get the current authenticated user's org ID
 */
export function getCurrentOrg(): string | undefined {
    return pb.authStore.model?.org
}

/**
 * Create a books collection with the given query client
 */
export function createBooksCollection(
    queryClient: QueryClient,
    options?: { syncMode?: 'eager' | 'on-demand' }
) {
    return createCollection<Schema>(pb, queryClient)('books', {
        syncMode: options?.syncMode,
    })
}

/**
 * Create an authors collection with the given query client
 */
export function createAuthorsCollection(queryClient: QueryClient) {
    return createCollection<Schema>(pb, queryClient)('authors', {})
}

/**
 * Create a book_metadata collection with the given query client
 */
export function createBookMetadataCollection(queryClient: QueryClient) {
    return createCollection<Schema>(pb, queryClient)('book_metadata')
}

/**
 * Create a tags collection with the given query client
 */
export function createTagsCollection(queryClient: QueryClient) {
    return createCollection<Schema>(pb, queryClient)('tags')
}

/**
 * Create a book_tags collection with the given query client
 */
export function createBookTagsCollection(queryClient: QueryClient) {
    return createCollection<Schema>(pb, queryClient)('book_tags')
}

/**
 * Get a valid author ID for testing (fetches first author from database)
 */
export async function getTestAuthorId(): Promise<string> {
    const authors = await pb.collection('authors').getList(1, 1)
    if (authors.items.length === 0) {
        throw new Error('No authors found in database for testing')
    }
    return authors.items[0].id
}

/**
 * The `query.filter` encoded in a realtime topic built by {@link realtimeTopic},
 * or `undefined` when the topic carries no options.
 */
export function topicFilter(topic: string): string | undefined {
    return topicQuery(topic)?.filter as string | undefined
}

/**
 * The decoded `query` object from a realtime topic built by
 * {@link realtimeTopic}, or `undefined` when the topic carries no options.
 */
export function topicQuery(topic: string): Record<string, unknown> | undefined {
    const [, encoded] = topic.split('?options=')
    if (!encoded) return undefined
    const decoded = JSON.parse(decodeURIComponent(encoded)) as { query?: Record<string, unknown> }
    return decoded.query
}

/**
 * Wait for a live query result to finish loading.
 * Works with both array results (from .from()) and single object results (from .findOne()).
 * @param result - The result object from renderHook containing { current: { isLoading: boolean } }
 * @param timeout - Optional timeout in ms (default: 5000)
 */
export async function waitForLoadFinish(
    result: { current: { isLoading: boolean; data?: unknown } },
    timeout = 5000
): Promise<void> {
    await waitFor(
        () => {
            expect(result.current.isLoading).toBe(false)
            expect(result.current.data).toBeDefined()
        },
        { timeout }
    )
}
