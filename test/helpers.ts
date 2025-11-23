import { QueryClient } from '@tanstack/react-query'
import PocketBase from 'pocketbase'
import type { Collection } from '@tanstack/db'
import 'dotenv/config'
import { CollectionFactory, newRecordId } from '../src'
import type { Schema } from './schema'

export { newRecordId }

if (!process.env.TESTING_PB_ADDR) {
    throw new Error('TESTING_PB_ADDR environment variable is not set')
}

export const pb = new PocketBase(process.env.TESTING_PB_ADDR!)

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
    await pb.collection('users').authWithPassword(
        process.env.TEST_USER_EMAIL!,
        process.env.TEST_USER_PW!
    )
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
 * Create a CollectionFactory instance with PocketBase and QueryClient
 */
export function createCollectionFactory(queryClient: QueryClient): CollectionFactory<Schema> {
    return new CollectionFactory<Schema>(pb, queryClient)
}

/**
 * Create a books collection with the given query client
 */
export function createBooksCollection(queryClient: QueryClient) {
    const factory = createCollectionFactory(queryClient)
    return factory.create('books')
}

/**
 * Create an authors collection with the given query client
 */
export function createAuthorsCollection(queryClient: QueryClient) {
    const factory = createCollectionFactory(queryClient)
    return factory.create('authors')
}

/**
 * Create a book_metadata collection with the given query client
 */
export function createBookMetadataCollection(queryClient: QueryClient) {
    const factory = createCollectionFactory(queryClient)
    return factory.create('book_metadata')
}

/**
 * Create a tags collection with the given query client
 */
export function createTagsCollection(queryClient: QueryClient) {
    const factory = createCollectionFactory(queryClient)
    return factory.create('tags')
}

/**
 * Create a book_tags collection with the given query client
 */
export function createBookTagsCollection(queryClient: QueryClient) {
    const factory = createCollectionFactory(queryClient)
    return factory.create('book_tags')
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
