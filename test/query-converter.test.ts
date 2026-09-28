import type { IR } from '@tanstack/db'
import { and, eq, gt, inArray, isNull, like, lt, not, or } from '@tanstack/db'
import { describe, expect, it } from 'vitest'
import {
    convertToPocketBaseFilter,
    convertToPocketBaseSort,
} from '../src/pocketbase-query-converter'

// Helper to create mock field operands for testing the converter
// The converter uses parseWhereExpression which extracts field paths from the IR structure
const mockField = <T = unknown>(path: string[]) => path as unknown as IR.BasicExpression<T>

describe('PocketBase Query Converter', () => {
    it('should convert eq operator to PocketBase filter', () => {
        // Create a where expression using mock field operand
        const whereExpr = eq(mockField(['genre']), 'Fantasy')

        const filter = convertToPocketBaseFilter(whereExpr)
        expect(filter).toBe('genre = "Fantasy"')
    })

    it('should convert gt operator to PocketBase filter', () => {
        const whereExpr = gt(mockField(['page_count']), 100)

        const filter = convertToPocketBaseFilter(whereExpr)
        expect(filter).toBe('page_count > 100')
    })

    it('should convert and operator to PocketBase filter', () => {
        const whereExpr = and(
            eq(mockField(['genre']), 'Fantasy'),
            gt(mockField(['page_count']), 100)
        )

        const filter = convertToPocketBaseFilter(whereExpr)
        expect(filter).toBe('(genre = "Fantasy" && page_count > 100)')
    })

    it('should convert or operator to PocketBase filter', () => {
        const whereExpr = or(
            eq(mockField(['genre']), 'Fantasy'),
            eq(mockField(['genre']), 'Science Fiction')
        )

        const filter = convertToPocketBaseFilter(whereExpr)
        expect(filter).toBe('(genre = "Fantasy" || genre = "Science Fiction")')
    })

    it('should return undefined for null/undefined input', () => {
        expect(convertToPocketBaseFilter(null)).toBeUndefined()
        expect(convertToPocketBaseFilter(undefined)).toBeUndefined()
    })

    it('should return undefined for null/undefined sort input', () => {
        expect(convertToPocketBaseSort(null)).toBeUndefined()
        expect(convertToPocketBaseSort(undefined)).toBeUndefined()
    })

    it('should deduplicate query values', () => {
        // Using type assertion to construct raw IR for testing
        const where = {
            name: 'in',
            args: [
                {
                    path: ['id'],
                    type: 'ref',
                },
                {
                    value: ['x0xz23mbkpouksb', 'x0xz23mbkpouksb', 'x0xz23mbkpouksb'],
                    type: 'val',
                },
            ],
            type: 'func',
        } as IR.BasicExpression<boolean>

        const filter = convertToPocketBaseFilter(where)
        // After deduplication, only one unique value remains
        expect(filter).toBe('id = "x0xz23mbkpouksb"')
    })

    describe('not', () => {
        const genre = mockField<string>(['genre'])
        const pages = mockField<number>(['page_count'])

        it.each([
            ['eq', not(eq(genre, 'Fantasy')), 'genre != "Fantasy"'],
            ['like', not(like(genre, 'Fan%')), 'genre !~ "Fan%"'],
            ['isNull', not(isNull(genre)), 'genre != null'],
            ['gt', not(gt(pages, 100)), 'page_count <= 100'],
            ['lt', not(lt(pages, 100)), 'page_count >= 100'],
            ['in', not(inArray(genre, ['A', 'B'])), '(genre != "A" && genre != "B")'],
            ['not', not(not(eq(genre, 'A'))), 'genre = "A"'],
            ['and', not(and(eq(genre, 'A'), gt(pages, 1))), '(genre != "A" || page_count <= 1)'],
            ['or', not(or(eq(genre, 'A'), eq(genre, 'B'))), '(genre != "A" && genre != "B")'],
        ])('should push not(%s) down to a PocketBase operator', (_name, whereExpr, expected) => {
            expect(convertToPocketBaseFilter(whereExpr)).toBe(expected)
        })

        it('should push not down inside and/or', () => {
            const whereExpr = and(eq(genre, 'A'), not(eq(pages, 1)))
            expect(convertToPocketBaseFilter(whereExpr)).toBe('(genre = "A" && page_count != 1)')
        })
    })
})
