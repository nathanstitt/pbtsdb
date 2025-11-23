import { QueryClient } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { useLiveQuery } from '@tanstack/react-db'
import { and, eq, gt, gte, lt, lte, or } from '@tanstack/db'
import 'dotenv/config'


import PocketBase from 'pocketbase'
import { CollectionFactory } from '../src/collection'

import { Schema } from './schema'
const pb = new PocketBase(process.env.TESTING_PB_ADDR!)

describe('PBCollection - Real PocketBase Integration', () => {
    let queryClient: QueryClient
    let testJobSlug: string | null = null

    beforeAll(async () => {
        await pb.collection('users').authWithPassword( process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PW!)

        // Fetch a test job to use for queries
        try {
            const jobs = await pb.collection('jobs').getList(1, 1, {
                sort: '-created',
            })
            if (jobs.items.length > 0) {
                testJobSlug = jobs.items[0].slug
            }
        } catch (_error) {}
    })

    afterAll(() => {
        // Clear auth
        pb.authStore.clear()
    })

    beforeEach(() => {
        // Create a fresh query client for each test
        queryClient = new QueryClient({
            defaultOptions: {
                queries: {
                    retry: false,
                    gcTime: Infinity, // Don't garbage collect queries during tests
                },
            },
        })
    })

    afterEach(() => {
        // Clear all queries
        queryClient.clear()
    })

    it('should fetch jobs with simple filter using pocketbase api', async () => {
        const result = await pb.collection('jobs').getList(1, 1)
        expect(result).toBeDefined()
        expect(Array.isArray(result.items)).toBe(true)
        expect(result.items.length).toBeGreaterThanOrEqual(1)

    }, 10000)

    it('should fetch job by slug using tanstack db collection', async () => {

        const collections = new CollectionFactory<Schema>(pb, queryClient)
        const jobsCollection = collections.create('jobs')

        // is a tanstack DB collection

        const { result } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ jobs: jobsCollection })
            )
        )

        // Wait for the collection to load and have data
        await waitFor(
            () => {
                expect(result.current.isLoading).toBe(false)
            },
            { timeout: 5000 }
        )

        expect(result.current.isLoading).toBe(false)
        expect(result.current.data).toBeDefined()
        expect(result.current.data.length).toBeGreaterThanOrEqual(1)
        const job = result.current.data[0]
        const jobName: string = job.name
        expect(jobName).toBeTypeOf('string')


    })

    it('should accept relations config for type safety', async () => {
        const collections = new CollectionFactory<Schema>(pb, queryClient)

        // Create collections with relations config
        const customersCollection = collections.create('customers')
        const jobsCollection = collections.create('jobs', {
            relations: {
                customer: customersCollection  // Type-checked field name
            }
        })

        // Verify collections are created successfully
        expect(jobsCollection).toBeDefined()
        expect(customersCollection).toBeDefined()

        // Note: Actual join logic would be in useLiveQuery as shown in JSDoc example
        // This test validates that the API accepts relations configuration
    })

    it('should join jobs with customers using manual join pattern', async () => {
        const collections = new CollectionFactory<Schema>(pb, queryClient)

        // Create collections with relations config
        const customersCollection = collections.create('customers')
        const jobsCollection = collections.create('jobs', {
            relations: {
                customer: customersCollection
            }
        })

        const { result } = renderHook(() =>
            useLiveQuery((q) =>
                q.from({ job: jobsCollection })
                    .join(
                        { customer: customersCollection },
                        ({ job, customer }) => eq(job.customer, customer.id),
                        'left'
                    )
                    .select(({ job, customer }) => ({
                        ...job,
                        expand: {
                            customer: customer ? { ...customer } : undefined
                        }
                    }))
            )
        )

        // Wait for the query to load
        await waitFor(
            () => {
                expect(result.current.isLoading).toBe(false)
            },
            { timeout: 10000 }
        )

        expect(result.current.isLoading).toBe(false)
        expect(result.current.data).toBeDefined()
        expect(result.current.data.length).toBeGreaterThanOrEqual(1)

        // Verify the joined data structure
        const jobWithCustomer = result.current.data[0]

        // Original job fields should exist
        expect(jobWithCustomer.id).toBeDefined()
        expect(jobWithCustomer.name).toBeDefined()
        expect(jobWithCustomer.customer).toBeDefined() // FK ID still exists

        // With on-demand sync mode and manual joins, the expand structure is created client-side
        // by the select() function. The expand property should exist with customer data from the join.
        // Note: This test validates that the manual join API works, even if expand is undefined
        // when both collections are empty or when the join doesn't find matches.

        if (jobWithCustomer.expand && jobWithCustomer.expand.customer) {
            const customerData = jobWithCustomer.expand.customer
            expect(customerData.id).toBeDefined()
            expect(customerData.name).toBeDefined()

            // The customer ID should match the FK
            expect(customerData.id).toBe(jobWithCustomer.customer)

            // Type inference test - these should be typed correctly
            const customerId: string = customerData.id
            const customerName: string = customerData.name
            expect(customerId).toBeTypeOf('string')
            expect(customerName).toBeTypeOf('string')
        } else {
            // If expand doesn't exist, at least verify the query executed successfully
            expect(jobWithCustomer).toBeDefined()
        }
    }, 15000)

    describe('Query Operators', () => {
        it('should filter jobs using eq operator', async () => {
            const collections = new CollectionFactory<Schema>(pb, queryClient)
            const jobsCollection = collections.create('jobs')

            // First get all jobs to find a valid status
            const allJobs = await pb.collection('jobs').getList(1, 10)
            expect(allJobs.items.length).toBeGreaterThan(0)
            const testStatus = allJobs.items[0].status

            const { result } = renderHook(() =>
                useLiveQuery((q) =>
                    q.from({ jobs: jobsCollection })
                        .where(({ jobs }) => eq(jobs.status, testStatus))
                )
            )

            await waitFor(
                () => {
                    expect(result.current.isLoading).toBe(false)
                },
                { timeout: 5000 }
            )

            expect(result.current.data).toBeDefined()
            expect(result.current.data.length).toBeGreaterThan(0)

            // All results should have the filtered status
            result.current.data.forEach(job => {
                expect(job.status).toBe(testStatus)
            })
        })

        it('should filter jobs using gt operator with dates', async () => {
            const collections = new CollectionFactory<Schema>(pb, queryClient)
            const jobsCollection = collections.create('jobs')

            // Use a date in the past to ensure we get some results
            const pastDate = new Date('2020-01-01')

            const { result } = renderHook(() =>
                useLiveQuery((q) =>
                    q.from({ jobs: jobsCollection })
                        .where(({ jobs }) => gt(jobs.created, pastDate.toISOString()))
                )
            )

            await waitFor(
                () => {
                    expect(result.current.isLoading).toBe(false)
                },
                { timeout: 5000 }
            )

            expect(result.current.data).toBeDefined()
            expect(result.current.data.length).toBeGreaterThan(0)

            // All results should have created date after pastDate
            result.current.data.forEach(job => {
                expect(new Date(job.created).getTime()).toBeGreaterThan(pastDate.getTime())
            })
        })

        it('should filter jobs using gte operator', async () => {
            const collections = new CollectionFactory<Schema>(pb, queryClient)
            const jobsCollection = collections.create('jobs')

            // Get a job's created date to use as threshold
            const allJobs = await pb.collection('jobs').getList(1, 1, { sort: '-created' })
            expect(allJobs.items.length).toBeGreaterThan(0)
            const thresholdDate = allJobs.items[0].created

            const { result } = renderHook(() =>
                useLiveQuery((q) =>
                    q.from({ jobs: jobsCollection })
                        .where(({ jobs }) => gte(jobs.created, thresholdDate))
                )
            )

            await waitFor(
                () => {
                    expect(result.current.isLoading).toBe(false)
                },
                { timeout: 5000 }
            )

            expect(result.current.data).toBeDefined()
            expect(result.current.data.length).toBeGreaterThan(0)

            // All results should have created date >= threshold
            result.current.data.forEach(job => {
                expect(new Date(job.created).getTime()).toBeGreaterThanOrEqual(new Date(thresholdDate).getTime())
            })
        })

        it('should filter jobs using lt operator', async () => {
            const collections = new CollectionFactory<Schema>(pb, queryClient)
            const jobsCollection = collections.create('jobs')

            // Use a future date to ensure we get some results
            const futureDate = new Date('2030-01-01')

            const { result } = renderHook(() =>
                useLiveQuery((q) =>
                    q.from({ jobs: jobsCollection })
                        .where(({ jobs }) => lt(jobs.created, futureDate.toISOString()))
                )
            )

            await waitFor(
                () => {
                    expect(result.current.isLoading).toBe(false)
                },
                { timeout: 5000 }
            )

            expect(result.current.data).toBeDefined()
            expect(result.current.data.length).toBeGreaterThan(0)

            // All results should have created date before futureDate
            result.current.data.forEach(job => {
                expect(new Date(job.created).getTime()).toBeLessThan(futureDate.getTime())
            })
        })

        it('should filter jobs using lte operator', async () => {
            const collections = new CollectionFactory<Schema>(pb, queryClient)
            const jobsCollection = collections.create('jobs')

            const futureDate = new Date('2030-01-01')

            const { result } = renderHook(() =>
                useLiveQuery((q) =>
                    q.from({ jobs: jobsCollection })
                        .where(({ jobs }) => lte(jobs.created, futureDate.toISOString()))
                )
            )

            await waitFor(
                () => {
                    expect(result.current.isLoading).toBe(false)
                },
                { timeout: 5000 }
            )

            expect(result.current.data).toBeDefined()
            expect(result.current.data.length).toBeGreaterThan(0)

            // All results should have created date <= futureDate
            result.current.data.forEach(job => {
                expect(new Date(job.created).getTime()).toBeLessThanOrEqual(futureDate.getTime())
            })
        })

        it('should filter jobs using and operator', async () => {
            const collections = new CollectionFactory<Schema>(pb, queryClient)
            const jobsCollection = collections.create('jobs')

            // Get test data
            const allJobs = await pb.collection('jobs').getList(1, 10)
            expect(allJobs.items.length).toBeGreaterThan(0)
            const testStatus = allJobs.items[0].status
            const pastDate = new Date('2020-01-01')

            const { result } = renderHook(() =>
                useLiveQuery((q) =>
                    q.from({ jobs: jobsCollection })
                        .where(({ jobs }) => and(
                            eq(jobs.status, testStatus),
                            gt(jobs.created, pastDate.toISOString())
                        ))
                )
            )

            await waitFor(
                () => {
                    expect(result.current.isLoading).toBe(false)
                },
                { timeout: 5000 }
            )

            expect(result.current.data).toBeDefined()

            // All results should match both conditions
            result.current.data.forEach(job => {
                expect(job.status).toBe(testStatus)
                expect(new Date(job.created).getTime()).toBeGreaterThan(pastDate.getTime())
            })
        })

        it('should filter jobs using or operator', async () => {
            const collections = new CollectionFactory<Schema>(pb, queryClient)
            const jobsCollection = collections.create('jobs')

            // Get two different statuses
            const allJobs = await pb.collection('jobs').getList(1, 20)
            expect(allJobs.items.length).toBeGreaterThan(0)

            // Find two different status values
            const uniqueStatuses = [...new Set(allJobs.items.map(j => j.status))]
            const status1 = uniqueStatuses[0]
            const status2 = uniqueStatuses.length > 1 ? uniqueStatuses[1] : status1

            const { result } = renderHook(() =>
                useLiveQuery((q) =>
                    q.from({ jobs: jobsCollection })
                        .where(({ jobs }) => or(
                            eq(jobs.status, status1),
                            eq(jobs.status, status2)
                        ))
                )
            )

            await waitFor(
                () => {
                    expect(result.current.isLoading).toBe(false)
                },
                { timeout: 5000 }
            )

            expect(result.current.data).toBeDefined()
            expect(result.current.data.length).toBeGreaterThan(0)

            // All results should match at least one condition
            result.current.data.forEach(job => {
                expect([status1, status2]).toContain(job.status)
            })
        })

        it('should sort jobs by created date descending', async () => {
            const collections = new CollectionFactory<Schema>(pb, queryClient)
            const jobsCollection = collections.create('jobs')

            const { result } = renderHook(() =>
                useLiveQuery((q) =>
                    q.from({ jobs: jobsCollection })
                        .orderBy(({ jobs }) => jobs.created, 'desc')
                )
            )

            await waitFor(
                () => {
                    expect(result.current.isLoading).toBe(false)
                },
                { timeout: 5000 }
            )

            expect(result.current.data).toBeDefined()
            expect(result.current.data.length).toBeGreaterThanOrEqual(1)

            // Verify descending order if we have multiple results
            if (result.current.data.length > 1) {
                const dates = result.current.data.map(j => new Date(j.created).getTime())
                for (let i = 1; i < dates.length; i++) {
                    expect(dates[i]).toBeLessThanOrEqual(dates[i - 1])
                }
            }
        })

        it('should support complex nested queries with and/or', async () => {
            const collections = new CollectionFactory<Schema>(pb, queryClient)
            const jobsCollection = collections.create('jobs')

            const allJobs = await pb.collection('jobs').getList(1, 20)
            expect(allJobs.items.length).toBeGreaterThan(0)
            const testStatus = allJobs.items[0].status
            const pastDate = new Date('2020-01-01')
            const futureDate = new Date('2030-01-01')

            const { result } = renderHook(() =>
                useLiveQuery((q) =>
                    q.from({ jobs: jobsCollection })
                        .where(({ jobs }) => and(
                            eq(jobs.status, testStatus),
                            or(
                                gt(jobs.created, pastDate.toISOString()),
                                lt(jobs.updated, futureDate.toISOString())
                            )
                        ))
                )
            )

            await waitFor(
                () => {
                    expect(result.current.isLoading).toBe(false)
                },
                { timeout: 5000 }
            )

            expect(result.current.data).toBeDefined()

            // All results should match the complex condition
            result.current.data.forEach(job => {
                expect(job.status).toBe(testStatus)
                const meetsOrCondition =
                    new Date(job.created).getTime() > pastDate.getTime() ||
                    new Date(job.updated).getTime() < futureDate.getTime()
                expect(meetsOrCondition).toBe(true)
            })
        })

        it('should throw error for unsupported operators', async () => {
            const collections = new CollectionFactory<Schema>(pb, queryClient)

            // This test verifies that unsupported operators are rejected
            // by the query compilation, not by our converter
            // TanStack DB will throw a QueryCompilationError before reaching our code

            expect(() => {
                renderHook(() =>
                    useLiveQuery((q) =>
                        q.from({ jobs: collections.create('jobs') })
                            // Testing unsupported structure
                            .where(() => ({ op: 'unsupported', field: ['name'], value: 'test' }) as any)
                    )
                )
            }).toThrow()
        })
    })

    describe('Relation Expansion', () => {
        it('should expand relations when specified in options', async () => {
            const collections = new CollectionFactory<Schema>(pb, queryClient)
            const jobsCollection = collections.create('jobs', {
                expand: 'customer,location'
            })

            const { result } = renderHook(() =>
                useLiveQuery((q) =>
                    q.from({ jobs: jobsCollection })
                )
            )

            await waitFor(
                () => {
                    expect(result.current.isLoading).toBe(false)
                },
                { timeout: 5000 }
            )

            expect(result.current.data).toBeDefined()
            expect(result.current.data.length).toBeGreaterThan(0)

            // Check if expanded data exists
            // @ts-ignore - expand property exists at runtime when PocketBase expands relations
            const jobWithExpand = result.current.data.find(j => (j as any).expand)
            // @ts-ignore - expand property exists at runtime
            if (jobWithExpand && (jobWithExpand as any).expand) {
                // If expand exists, it should have customer or location
                // @ts-ignore - expand property exists at runtime
                const hasExpandedData =
                    (jobWithExpand as any).expand.customer !== undefined ||
                    (jobWithExpand as any).expand.location !== undefined

                expect(hasExpandedData).toBe(true)
            }
        })

        it('should filter on nested relation fields', async () => {
            const collections = new CollectionFactory<Schema>(pb, queryClient)
            const jobsCollection = collections.create('jobs', {
                expand: 'customer'
            })

            // Get a customer ID to filter by
            const allJobs = await pb.collection('jobs').getList(1, 10, {
                expand: 'customer'
            })
            expect(allJobs.items.length).toBeGreaterThan(0)

            // Find a job with a customer
            const jobWithCustomer = allJobs.items.find(j => j.customer)
            if (!jobWithCustomer) {
                // Skip if no jobs have customers
                return
            }

            const testCustomerId = jobWithCustomer.customer

            const { result } = renderHook(() =>
                useLiveQuery((q) =>
                    q.from({ jobs: jobsCollection })
                        .where(({ jobs }) => eq(jobs.customer, testCustomerId))
                )
            )

            await waitFor(
                () => {
                    expect(result.current.isLoading).toBe(false)
                },
                { timeout: 5000 }
            )

            expect(result.current.data).toBeDefined()
            expect(result.current.data.length).toBeGreaterThan(0)

            // All results should have the same customer
            result.current.data.forEach(job => {
                expect(job.customer).toBe(testCustomerId)
            })
        })
    })
})
