import { waitFor } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { RealtimeSubscribeAbortedError, RealtimeTopicTooLongError, subscribeTopic } from '../src'
import { authenticateTestUser, clearAuth, pb, sendSignal } from './helpers'

// A message on `barrier` arrives after every message the server sent before
// it on the same connection, so waiting for it proves an earlier topic got
// nothing.
async function withBarrier(check: () => void): Promise<void> {
    const barrier = vi.fn()
    const unsubscribe = await subscribeTopic(pb, 'test/barrier', barrier)
    await sendSignal('test/barrier')
    await waitFor(() => expect(barrier).toHaveBeenCalled())
    check()
    await unsubscribe()
}

describe('subscribeTopic', () => {
    beforeAll(async () => {
        await authenticateTestUser()
    })

    afterAll(() => {
        clearAuth()
    })

    it('calls onMessage, with no argument, once per message', async () => {
        const onMessage = vi.fn()
        const unsubscribe = await subscribeTopic(pb, 'collection/topic_a', onMessage)
        await sendSignal('collection/topic_a', 2)
        await waitFor(() => expect(onMessage).toHaveBeenCalledTimes(2))
        expect(onMessage.mock.calls).toEqual([[], []])
        await unsubscribe()
    })

    it('stops after unsubscribe', async () => {
        const onMessage = vi.fn()
        const unsubscribe = await subscribeTopic(pb, 'collection/topic_b', onMessage)
        await unsubscribe()
        await sendSignal('collection/topic_b')
        await withBarrier(() => expect(onMessage).not.toHaveBeenCalled())
    })

    it('keeps one subscriber when another on the same topic leaves', async () => {
        const first = vi.fn()
        const second = vi.fn()
        const unsubscribeFirst = await subscribeTopic(pb, 'collection/topic_c', first)
        const unsubscribeSecond = await subscribeTopic(pb, 'collection/topic_c', second)
        await unsubscribeFirst()
        await sendSignal('collection/topic_c')
        await waitFor(() => expect(second).toHaveBeenCalledTimes(1))
        expect(first).not.toHaveBeenCalled()
        await unsubscribeSecond()
    })

    it('ignores messages on other topics', async () => {
        const onMessage = vi.fn()
        const unsubscribe = await subscribeTopic(pb, 'collection/topic_d', onMessage)
        await sendSignal('collection/topic_other')
        await withBarrier(() => expect(onMessage).not.toHaveBeenCalled())
        await unsubscribe()
    })

    it('rejects an empty topic and a topic over 2500 characters', async () => {
        await expect(subscribeTopic(pb, '', vi.fn())).rejects.toThrow('topic is empty')
        await expect(subscribeTopic(pb, 'x'.repeat(2501), vi.fn())).rejects.toBeInstanceOf(
            RealtimeTopicTooLongError
        )
    })

    it('rejects with RealtimeSubscribeAbortedError when its signal aborts', async () => {
        await expect(
            subscribeTopic(pb, 'test/aborted', vi.fn(), { signal: AbortSignal.abort() })
        ).rejects.toBeInstanceOf(RealtimeSubscribeAbortedError)
    })
})
