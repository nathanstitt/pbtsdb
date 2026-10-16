import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { renderHook, waitFor } from '@testing-library/react'
import PocketBase from 'pocketbase'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createCollection } from '../src'
import { authenticateTestUser, clearAuth, pb } from './helpers'
import type { Schema } from './schema'

describe('compound subset over a large join', () => {
    beforeAll(async () => {
        await authenticateTestUser()
    })

    afterAll(() => {
        clearAuth()
    })

    it('loads a join whose demand has a condition beside a list over 200 keys', async () => {
        const color = `#${Math.floor(Math.random() * 0xffffff)
            .toString(16)
            .padStart(6, '0')}`
        const [book] = await pb.collection('books').getFullList()
        const tagIds: string[] = []
        const linkIds: string[] = []
        try {
            for (let i = 0; i < 210; i++) {
                const tag = await pb.collection('tags').create({ name: `cs-${color}-${i}`, color })
                tagIds.push(tag.id)
            }
            for (const tag of tagIds) {
                const link = await pb.collection('book_tags').create({ book: book.id, tag })
                linkIds.push(link.id)
            }
            const client = new PocketBase(pb.baseURL)
            client.authStore.save(pb.authStore.token, pb.authStore.record)
            const c = createCollection<Schema>(client)
            const tags = c('tags', { syncMode: 'on-demand' })
            const bookTags = c('book_tags', { syncMode: 'on-demand' })
            const filters: string[] = []
            const send = client.send.bind(client)
            client.send = (path, options) => {
                if (path.includes('/book_tags/')) filters.push(String(options.filter))
                return send(path, options)
            }
            const { result } = renderHook(() =>
                useLiveQuery(q =>
                    q
                        .from({ bt: bookTags })
                        .innerJoin({ t: tags }, ({ bt, t }) => eq(bt.tag, t.id))
                        .where(({ bt }) => eq(bt.book, book.id))
                        .where(({ t }) => eq(t.color, color))
                )
            )
            await waitFor(() => expect(result.current.data).toHaveLength(tagIds.length), {
                timeout: 10000,
            })
            expect(filters.length).toBeGreaterThan(1)
            for (const filter of filters) {
                expect(filter.length).toBeLessThanOrEqual(2500)
                expect(filter).toContain(`(book = "${book.id}") && (`)
            }
        } finally {
            await Promise.all(linkIds.map(id => pb.collection('book_tags').delete(id)))
            await Promise.all(tagIds.map(id => pb.collection('tags').delete(id)))
        }
    }, 30000)
})
