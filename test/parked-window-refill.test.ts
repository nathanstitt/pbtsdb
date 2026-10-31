import { createLiveQueryCollection, eq } from '@tanstack/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCollection } from '../src'
import { disconnectRealtime, resetRealtime } from '../src/transport'
import { authenticateTestUser, clearAuth, getTestSlug, newRecordId, pb } from './helpers'
import type { Schema } from './schema'

/**
 * A limited query that unmounts parks its subset. A row deleted while it is
 * parked leaves a gap; the next equal query must fetch the row that fills it.
 */
describe('a parked limited subset', () => {
    beforeAll(async () => {
        await authenticateTestUser()
        disconnectRealtime(pb)
    })

    afterAll(() => {
        resetRealtime(pb)
        clearAuth()
    })

    it('is fetched again on adopt after a delete removed its row', async () => {
        const author = newRecordId()
        await pb
            .collection('authors')
            .create({ id: author, name: author, email: `${author}@window.test` })
        const createBook = (title: string) =>
            pb.collection('books').create({
                title,
                isbn: getTestSlug('isbn'),
                genre: 'Fiction',
                author,
                page_count: 1,
                published_date: '',
            })
        const first = await createBook('A window')
        const second = await createBook('B window')
        const books = createCollection<Schema>(pb)('books', {
            syncMode: 'on-demand',
            subsetGcTime: 5000,
        })
        const probe = () =>
            createLiveQueryCollection(q =>
                q
                    .from({ b: books })
                    .where(({ b }) => eq(b.author, author))
                    .orderBy(({ b }) => b.title, { direction: 'asc', stringSort: 'lexical' })
                    .limit(1)
            )
        try {
            const mounted = probe()
            await mounted.preload()
            expect(mounted.toArray.map(row => row.id)).toEqual([first.id])
            await mounted.cleanup()

            await books.delete(first.id).isPersisted.promise

            const remounted = probe()
            await remounted.preload()
            expect(remounted.toArray.map(row => row.id)).toEqual([second.id])
            await remounted.cleanup()
        } finally {
            await pb
                .collection('books')
                .delete(second.id)
                .catch(() => {})
            await pb
                .collection('authors')
                .delete(author)
                .catch(() => {})
        }
    }, 30000)
})
