import { useLiveQuery } from '@tanstack/react-db'
import type { QueryClient } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import PocketBase from 'pocketbase'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createCollection } from '../src'
import {
    authenticateTestUser,
    clearAuth,
    createTestQueryClient,
    pb,
    waitForLoadFinish,
    waitForSubscription,
} from './helpers'
import type { Schema } from './schema'

const TOKEN_HEADER = 'X-Test-Token'
const VALID_TOKEN = 'let-me-in'

if (!process.env.TESTING_PB_ADDR) {
    throw new Error('TESTING_PB_ADDR environment variable is not set')
}

/**
 * A dedicated unauthenticated client per test: the realtime connection and its
 * subscription options are per-client, so sharing one would let a token from
 * another test leak into the subscription under test.
 */
function createAnonymousClient() {
    const client = new PocketBase(process.env.TESTING_PB_ADDR)
    client.autoCancellation(false)
    return client
}

async function createGatedRecord(title: string) {
    return await pb.collection('token_gated').create({ title })
}

describe('Collection - subscribe options', () => {
    let queryClient: QueryClient
    const createdIds: string[] = []

    beforeAll(async () => {
        await authenticateTestUser()
    })

    afterAll(async () => {
        for (const id of createdIds) {
            try {
                await pb.collection('token_gated').delete(id)
            } catch (_error) {
                // Ignore cleanup errors
            }
        }
        clearAuth()
    })

    beforeEach(() => {
        queryClient = createTestQueryClient()
    })

    afterEach(() => {
        queryClient.clear()
    })

    it('forwards subscribeOptions headers so a gated rule authorizes the subscription', async () => {
        const client = createAnonymousClient()
        const collection = createCollection<Schema>(client, queryClient, {
            subscribeOptions: () => ({ headers: { [TOKEN_HEADER]: VALID_TOKEN } }),
        })('token_gated', { syncMode: 'eager' })

        const { result } = renderHook(() => useLiveQuery(q => q.from({ gated: collection })))
        await waitForLoadFinish(result)
        await waitForSubscription(collection)

        const record = await createGatedRecord('with-token')
        createdIds.push(record.id)

        await waitFor(() => expect(result.current.data.some(r => r.id === record.id)).toBe(true), {
            timeout: 8000,
        })
    }, 20000)

    it('does not receive gated events when no subscribeOptions are supplied', async () => {
        const client = createAnonymousClient()
        const collection = createCollection<Schema>(client, queryClient)('token_gated', {
            syncMode: 'eager',
        })

        const { result } = renderHook(() => useLiveQuery(q => q.from({ gated: collection })))
        await waitForLoadFinish(result)
        await waitForSubscription(collection)

        const record = await createGatedRecord('without-token')
        createdIds.push(record.id)

        // Give the event the same window the positive case needed before
        // asserting it never arrives.
        await new Promise(resolve => setTimeout(resolve, 3000))
        expect(result.current.data.some(r => r.id === record.id)).toBe(false)
    }, 20000)

    it('calls subscribeOptions on each subscribe so a rotated value is used', async () => {
        const client = createAnonymousClient()
        const tokens: string[] = []
        let currentToken = 'stale-token'

        const collection = createCollection<Schema>(client, queryClient, {
            subscribeOptions: () => {
                tokens.push(currentToken)
                return { headers: { [TOKEN_HEADER]: currentToken } }
            },
        })('token_gated', { syncMode: 'eager' })

        const first = renderHook(() => useLiveQuery(q => q.from({ gated: collection })))
        await waitForLoadFinish(first.result)
        await waitForSubscription(collection)
        expect(tokens).toEqual(['stale-token'])

        // Drop the subscriber count to zero, then back to one, to force a
        // resubscribe through the same path a reconnect would take.
        first.unmount()
        await waitFor(() => expect(collection.isSubscribed()).toBe(false), { timeout: 8000 })

        currentToken = VALID_TOKEN
        const second = renderHook(() => useLiveQuery(q => q.from({ gated: collection })))
        await waitForLoadFinish(second.result)
        await waitForSubscription(collection)

        expect(tokens.length).toBeGreaterThan(1)
        expect(tokens.at(-1)).toBe(VALID_TOKEN)

        // The rotated token must be the one actually in force on the server.
        const record = await createGatedRecord('rotated-token')
        createdIds.push(record.id)

        await waitFor(
            () => expect(second.result.current.data.some(r => r.id === record.id)).toBe(true),
            { timeout: 8000 }
        )
    }, 30000)

    it('treats a subscribeOptions getter returning undefined as a no-op', async () => {
        let callCount = 0
        const collection = createCollection<Schema>(pb, queryClient, {
            subscribeOptions: () => {
                callCount += 1
                return undefined
            },
        })('books', { syncMode: 'eager' })

        const { result } = renderHook(() => useLiveQuery(q => q.from({ books: collection })))
        await waitForLoadFinish(result)
        await waitForSubscription(collection)

        expect(callCount).toBeGreaterThan(0)
        expect(collection.isSubscribed()).toBe(true)
        expect(result.current.data.length).toBeGreaterThan(0)
    }, 20000)

    it('subscribes normally when no factory options are given', async () => {
        const collection = createCollection<Schema>(pb, queryClient)('books', {
            syncMode: 'eager',
        })

        const { result } = renderHook(() => useLiveQuery(q => q.from({ books: collection })))
        await waitForLoadFinish(result)
        await waitForSubscription(collection)

        expect(collection.isSubscribed()).toBe(true)
        expect(result.current.data.length).toBeGreaterThan(0)
    }, 20000)
})
