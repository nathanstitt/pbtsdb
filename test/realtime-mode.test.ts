import { useLiveQuery } from '@tanstack/react-db'
import type { QueryClient } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createCollection } from '../src'
import {
    authenticateTestUser,
    clearAuth,
    createTestQueryClient,
    pb,
    waitForLoadFinish,
} from './helpers'
import type { Schema } from './schema'

describe('realtime mode', () => {
    let queryClient: QueryClient

    beforeAll(async () => {
        await authenticateTestUser()
    })

    afterAll(() => {
        clearAuth()
    })

    beforeEach(() => {
        queryClient = createTestQueryClient()
    })

    afterEach(() => {
        queryClient.clear()
    })

    describe('option', () => {
        it("rejects realtime 'query' on an eager collection", () => {
            const c = createCollection<Schema>(pb, queryClient)
            expect(() => c('books', { realtime: 'query' })).toThrow(
                "Collection 'books': realtime 'query' requires syncMode 'on-demand'"
            )
            expect(() => c('books', { syncMode: 'eager', realtime: 'query' })).toThrow(
                "Collection 'books': realtime 'query' requires syncMode 'on-demand'"
            )
        })

        it("accepts realtime 'query' on an on-demand collection", async () => {
            const c = createCollection<Schema>(pb, queryClient)
            const books = c('books', { syncMode: 'on-demand', realtime: 'query' })
            const { result } = renderHook(() => useLiveQuery(q => q.from({ b: books })))
            await waitForLoadFinish(result)
            expect(result.current.data.length).toBeGreaterThan(0)
        }, 15000)
    })
})
