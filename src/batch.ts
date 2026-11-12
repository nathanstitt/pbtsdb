import { createTransaction, type PendingMutation } from '@tanstack/db'
import type PocketBase from 'pocketbase'
import { type BatchTarget, batchTargetOf } from './batch-registry'

type ErrorBody = { status?: number; message?: string; data?: Record<string, unknown> }

/**
 * One operation of a batch failed, so PocketBase rolled the whole batch back.
 * `response` holds the failed operation's error body in the place a
 * ClientResponseError keeps it, so code that reads field errors from a
 * single-record failure reads this one too.
 */
export class BatchMutationError extends Error {
    readonly index: number
    readonly collection: string
    readonly recordId: string
    readonly status: number
    readonly response: ErrorBody

    constructor(input: {
        index: number
        collection: string
        recordId: string
        response: ErrorBody
        cause: unknown
    }) {
        super(input.response.message || 'Batch request failed.', { cause: input.cause })
        this.name = 'BatchMutationError'
        this.index = input.index
        this.collection = input.collection
        this.recordId = input.recordId
        this.status = input.response.status ?? 0
        this.response = input.response
    }
}

type Operation = { mutation: PendingMutation; target: BatchTarget; id: string }

// Server-stamped fields the built-in insert handler also leaves out.
const SERVER_STAMPED = ['created', 'updated', 'collectionId', 'collectionName'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function operationsOf(mutations: readonly PendingMutation[]): Operation[] {
    return mutations.map(mutation => {
        const target = batchTargetOf(mutation.collection)
        if (!target) {
            throw new Error(
                `batch: collection '${mutation.collection.id}' was not built by pbtsdb and cannot join a batch`
            )
        }
        if (!target.handles[mutation.type]) {
            throw new Error(
                `batch: collection '${target.collectionName}' has a custom or disabled ${mutation.type} handler and cannot join a batch`
            )
        }
        const row = mutation.type === 'insert' ? mutation.modified : mutation.original
        const id = String((row as { id?: unknown }).id ?? mutation.key)
        return { mutation, target, id }
    })
}

function clientOf(operations: readonly Operation[]): PocketBase {
    const pb = operations[0].target.pb
    if (operations.some(operation => operation.target.pb !== pb)) {
        throw new Error('batch: every collection in a batch must use the same PocketBase client')
    }
    return pb
}

// PocketBase reports the failed operation as
// { data: { requests: { "<index>": { code, message, response } } } }.
function failedOperation(error: unknown): { index: number; response: ErrorBody } | null {
    if (!isRecord(error) || !isRecord(error.response) || !isRecord(error.response.data)) return null
    const requests = error.response.data.requests
    if (!isRecord(requests)) return null
    const [key] = Object.keys(requests)
    const index = Number(key)
    const entry = requests[key]
    if (!Number.isInteger(index) || !isRecord(entry) || !isRecord(entry.response)) return null
    return { index, response: entry.response as ErrorBody }
}

type BatchRequest = { method: 'POST' | 'PATCH' | 'DELETE'; url: string; body?: object }
type BatchResult = { status: number; body: unknown }

function requestOf({ mutation, target, id }: Operation): BatchRequest {
    const records = `/api/collections/${encodeURIComponent(target.collectionName)}/records`
    if (mutation.type === 'insert') {
        const body = { ...(mutation.modified as Record<string, unknown>) }
        for (const field of SERVER_STAMPED) delete body[field]
        return { method: 'POST', url: records, body }
    }
    const url = `${records}/${encodeURIComponent(id)}`
    if (mutation.type === 'update') return { method: 'PATCH', url, body: mutation.changes }
    return { method: 'DELETE', url }
}

async function sendBatch(mutations: readonly PendingMutation[]): Promise<void> {
    const operations = operationsOf(mutations)
    const pb = clientOf(operations)

    // A JSON body, not the SDK's createBatch(): that always sends multipart
    // form data, which a batch needs only for file uploads.
    let results: BatchResult[]
    try {
        results = await pb.send<BatchResult[]>('/api/batch', {
            method: 'POST',
            body: { requests: operations.map(requestOf) },
        })
    } catch (error) {
        const failed = failedOperation(error)
        const operation = failed ? operations[failed.index] : undefined
        if (!failed || !operation) throw error
        throw new BatchMutationError({
            index: failed.index,
            collection: operation.target.collectionName,
            recordId: operation.id,
            response: failed.response,
            cause: error,
        })
    }

    // Land each collection's rows and deletes as its built-in handlers do.
    const landed = new Map<BatchTarget, { rows: object[]; deleted: string[] }>()
    operations.forEach((operation, index) => {
        const entry = landed.get(operation.target) ?? { rows: [], deleted: [] }
        landed.set(operation.target, entry)
        const body: unknown = results[index]?.body
        if (operation.mutation.type === 'delete') entry.deleted.push(operation.id)
        else if (isRecord(body)) entry.rows.push(body)
    })
    for (const [target, { rows, deleted }] of landed) {
        if (rows.length > 0) target.land(rows)
        if (deleted.length > 0) await target.evict(deleted)
        await target.settle()
    }
}

/**
 * Run the collection mutations made in `fn` as one PocketBase batch: one
 * request and one database transaction, all of them or none.
 *
 * `fn` must be synchronous. The returned Promise resolves when the server
 * accepted the batch and the returned rows landed, and rejects (after rolling
 * back every optimistic change) when the batch fails or is refused.
 */
export async function batch(fn: () => void): Promise<void> {
    const transaction = createTransaction({
        autoCommit: false,
        mutationFn: ({ transaction: tx }) => sendBatch(tx.mutations),
    })
    try {
        transaction.mutate(() => {
            const returned: unknown = fn()
            if (returned instanceof Promise) {
                // Calls after an await would not be part of the batch.
                returned.catch(() => {})
                throw new Error('batch: the callback must be synchronous')
            }
        })
    } catch (error) {
        transaction.rollback()
        throw error
    }
    await transaction.commit()
}
