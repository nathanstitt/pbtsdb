import { describe, expect, it } from 'vitest'
import { createCollection } from '../src'
import { batchTargetOf } from '../src/batch-registry'
import { pb } from './helpers'
import type { Schema } from './schema'

describe('batch registry', () => {
    it('registers a built collection with its client and default handlers', () => {
        const tags = createCollection<Schema>(pb)('tags')
        const target = batchTargetOf(tags)
        expect(target?.pb).toBe(pb)
        expect(target?.collectionName).toBe('tags')
        expect(target?.handles).toEqual({ insert: true, update: true, delete: true })
    })

    it('marks a custom handler and a disabled handler as not batchable', () => {
        const tags = createCollection<Schema>(pb)('tags', {
            onInsert: async () => {},
            onDelete: false,
        })
        expect(batchTargetOf(tags)?.handles).toEqual({ insert: false, update: true, delete: false })
    })

    it('finds the target of a view through the prototype chain', () => {
        const books = createCollection<Schema>(pb)('books', { relations: {} })
        const view = Object.create(books)
        expect(batchTargetOf(view)).toBe(batchTargetOf(books))
    })

    it('returns undefined for an object pbtsdb did not build', () => {
        expect(batchTargetOf({})).toBeUndefined()
    })
})
