import { renderHook, waitFor } from '@testing-library/react'
import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'

import {
    pb,
    createTestQueryClient,
    authenticateTestUser,
    clearAuth,
    createTagsCollection,
    createCollectionFactory,
    waitForLoadFinish,
} from './helpers'

describe('Collection - Pagination', () => {
    let queryClient: QueryClient
    const createdTagIds: string[] = []
    const RECORD_COUNT = 1200
    const COLOR = '#FF0000'

    beforeAll(async () => {
        await authenticateTestUser()

        // Insert 1200 records in batches
        const batchSize = 100
        for (let i = 0; i < RECORD_COUNT; i += batchSize) {
            const batch = []
            for (let j = i; j < Math.min(i + batchSize, RECORD_COUNT); j++) {
                batch.push(
                    pb.collection('tags').create({
                        name: `pagination-test-tag-${j}`,
                        color: COLOR,
                    })
                )
            }
            const results = await Promise.all(batch)
            createdTagIds.push(...results.map((r) => r.id))
        }
    }, 120000)

    afterAll(async () => {
        // Clean up created records in batches
        const batchSize = 100
        for (let i = 0; i < createdTagIds.length; i += batchSize) {
            const batch = createdTagIds.slice(i, i + batchSize)
            await Promise.all(batch.map((id) => pb.collection('tags').delete(id).catch(() => {})))
        }
        clearAuth()
    }, 120000)

    beforeEach(() => {
        queryClient = createTestQueryClient()
    })

    afterEach(() => {
        queryClient.clear()
    })

    it('should fetch all records even when count exceeds default page size', async () => {
        const tagsCollection = createTagsCollection(queryClient)

        const { result } = renderHook(() =>
            useLiveQuery((q) => q.from({ tags: tagsCollection }).where(({ tags }) => eq(tags.color, COLOR)))
        )            

        await waitForLoadFinish(result, 30000)

        // Should have at least the 1200 records we created
        expect(result.current.data.length).toBeGreaterThanOrEqual(RECORD_COUNT)

        // Verify our test tags are present
        const testTags = result.current.data.filter((tag) =>
            tag.name.startsWith('pagination-test-tag-')
        )
        expect(testTags.length).toBe(RECORD_COUNT)
    }, 60000)

    it('should fetch only limited records when limit is specified', async () => {
        // Use on-demand sync so the fetch happens when query with limit is executed
        const factory = createCollectionFactory(queryClient)
        const tagsCollection = factory.create('tags', { syncMode: 'on-demand' })
        const LIMIT = 50

        // Query with a limit - should only fetch LIMIT records from server
        const { result: limitedResult } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ tags: tagsCollection })
                    .orderBy(({ tags }) => tags.id)  // Required by TanStack DB when using limit
                    .limit(LIMIT)
            )
        )

        // Wait for data to actually be populated (not just isLoading: false)
        await waitFor(
            () => {
                expect(limitedResult.current.isLoading).toBe(false)
                expect(limitedResult.current.data.length).toBeGreaterThan(0)
            },
            { timeout: 30000 }
        )

        // Query result should return exactly the limit
        expect(limitedResult.current.data.length).toBe(LIMIT)

        // Verify collection itself only contains LIMIT records (not all 1200+)
        // by querying without limit - should still only have LIMIT records
        const { result: unlimitedResult } = renderHook(() =>
            useLiveQuery((q) => q.from({ tags: tagsCollection }))
        )

        await waitFor(
            () => {
                expect(unlimitedResult.current.isLoading).toBe(false)
                expect(unlimitedResult.current.data).toBeDefined()
            },
            { timeout: 30000 }
        )

        // Collection should only have LIMIT records since that's all we fetched
        expect(unlimitedResult.current.data.length).toBe(LIMIT)
    }, 60000)
})
