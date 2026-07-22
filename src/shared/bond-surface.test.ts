import { describe, it, expect } from 'vitest'
import { buildDaemonSurface, type RpcInvoker } from './bond-surface'
import type { DispatchableMethod } from './rpc-schema'
import type { WorkingState } from './memory'

/**
 * Contract test for the shared window.bond surface builder: each renderer
 * method must reach its daemon RPC method with the registry param shape.
 * A representative sample across namespaces, not all ~70 methods.
 */

function recordingInvoker() {
  const calls: Array<{ method: DispatchableMethod; params: unknown }> = []
  const invoke: RpcInvoker = (method, params) => {
    calls.push({ method, params })
    return Promise.resolve(undefined as never)
  }
  return { calls, invoke }
}

describe('buildDaemonSurface', () => {
  it('maps chat methods with input passthrough', async () => {
    const { calls, invoke } = recordingInvoker()
    const bond = buildDaemonSurface(invoke)

    const input = { text: 'hi', turnId: 't1', userMessageId: 'u1', assistantMessageId: 'a1', activityMessageId: 'act1' }
    await bond.send(input)
    expect(calls.at(-1)).toEqual({ method: 'bond.send', params: input })

    await bond.send('hello', 's1')
    expect(calls.at(-1)).toEqual({ method: 'bond.send', params: { text: 'hello', sessionId: 's1', images: undefined } })

    await bond.cancel('s1')
    expect(calls.at(-1)).toEqual({ method: 'bond.cancel', params: { sessionId: 's1' } })

    // No sessionId → no params object, matching BondClient.cancel.
    await bond.cancel()
    expect(calls.at(-1)).toEqual({ method: 'bond.cancel', params: undefined })

    await bond.respondToApproval('req-1', false)
    expect(calls.at(-1)).toEqual({ method: 'bond.approvalResponse', params: { requestId: 'req-1', approved: false } })

    await bond.answerQuestion('q-1', { kind: 'cancelled' })
    expect(calls.at(-1)).toEqual({ method: 'bond.questionResponse', params: { questionId: 'q-1', answer: { kind: 'cancelled' } } })

    await bond.pendingQuestion()
    expect(calls.at(-1)).toEqual({ method: 'question.pending', params: undefined })
  })

  it('maps transcript and session methods', async () => {
    const { calls, invoke } = recordingInvoker()
    const bond = buildDaemonSurface(invoke)

    await bond.listTranscript({ beforeSeq: 9, limit: 40 })
    expect(calls.at(-1)).toEqual({ method: 'transcript.list', params: { beforeSeq: 9, limit: 40 } })

    await bond.upsertTranscript([])
    expect(calls.at(-1)).toEqual({ method: 'transcript.upsert', params: { messages: [] } })

    await bond.searchTranscript('needle', 5)
    expect(calls.at(-1)).toEqual({ method: 'transcript.search', params: { query: 'needle', limit: 5 } })

    await bond.createSession({ title: 'T' })
    expect(calls.at(-1)).toEqual({ method: 'session.create', params: { title: 'T' } })
  })

  it('maps image methods, renaming positional ids to registry shapes', async () => {
    const { calls, invoke } = recordingInvoker()
    const bond = buildDaemonSurface(invoke)

    await bond.getImage('img-1')
    expect(calls.at(-1)).toEqual({ method: 'image.get', params: { id: 'img-1' } })

    await bond.getImages(['a', 'b'])
    expect(calls.at(-1)).toEqual({ method: 'image.getMultiple', params: { ids: ['a', 'b'] } })

    await bond.importImage('base64data', 'image/png')
    expect(calls.at(-1)).toEqual({ method: 'image.import', params: { data: 'base64data', mediaType: 'image/png' } })

    await bond.deleteImage('img-2')
    expect(calls.at(-1)).toEqual({ method: 'image.delete', params: { id: 'img-2' } })
  })

  it('maps collection methods', async () => {
    const { calls, invoke } = recordingInvoker()
    const bond = buildDaemonSurface(invoke)

    await bond.updateCollection('c1', { archived: true })
    expect(calls.at(-1)).toEqual({ method: 'collection.update', params: { id: 'c1', updates: { archived: true } } })

    await bond.addCollectionItem('c1', { name: 'x' })
    expect(calls.at(-1)).toEqual({ method: 'collection.addItem', params: { collectionId: 'c1', data: { name: 'x' } } })

    await bond.addItemComment('item-1', 'user', 'hello')
    expect(calls.at(-1)).toEqual({ method: 'collection.addItemComment', params: { itemId: 'item-1', author: 'user', body: 'hello' } })
  })

  it('maps sense methods', async () => {
    const { calls, invoke } = recordingInvoker()
    const bond = buildDaemonSurface(invoke)

    await bond.senseTimeline('2026-07-19T00:00:00Z', '2026-07-19T23:59:59Z', 100)
    expect(calls.at(-1)).toEqual({
      method: 'sense.timeline',
      params: { from: '2026-07-19T00:00:00Z', to: '2026-07-19T23:59:59Z', limit: 100 },
    })

    await bond.senseCapture('cap-1')
    expect(calls.at(-1)).toEqual({ method: 'sense.capture', params: { id: 'cap-1' } })

    await bond.senseSearch('safari', 50)
    expect(calls.at(-1)).toEqual({ method: 'sense.search', params: { query: 'safari', limit: 50 } })

    await bond.senseStatus()
    expect(calls.at(-1)).toEqual({ method: 'sense.status', params: undefined })
  })

  it('maps memory and debrief methods', async () => {
    const { calls, invoke } = recordingInvoker()
    const bond = buildDaemonSurface(invoke)

    const working: WorkingState = {
      sessionId: null, projectId: null, goal: 'g',
      facts: [], preferences: [], decisions: [], openThreads: [], artifacts: [], activeSkill: null, checkpoint: null, updatedAt: 'now',
    }
    await bond.memoryUpdateWorking(working)
    expect(calls.at(-1)).toEqual({ method: 'memory.updateWorking', params: { working } })

    await bond.memorySearch('coffee', 20)
    expect(calls.at(-1)).toEqual({ method: 'memory.search', params: { query: 'coffee', limit: 20 } })

    await bond.memoryDelete('m1')
    expect(calls.at(-1)).toEqual({ method: 'memory.delete', params: { id: 'm1' } })

    await bond.senseDebrief(undefined, 'sess-1')
    expect(calls.at(-1)).toEqual({ method: 'sense.debrief', params: { id: undefined, sessionId: 'sess-1' } })
  })

  it('maps settings, skills, and setup methods', async () => {
    const { calls, invoke } = recordingInvoker()
    const bond = buildDaemonSurface(invoke)

    await bond.saveSoul('be kind')
    expect(calls.at(-1)).toEqual({ method: 'settings.saveSoul', params: { content: 'be kind' } })

    await bond.setEditMode({ type: 'readonly' })
    expect(calls.at(-1)).toEqual({ method: 'settings.setEditMode', params: { editMode: { type: 'readonly' } } })

    await bond.removeSkill('blog-helper')
    expect(calls.at(-1)).toEqual({ method: 'skills.remove', params: { name: 'blog-helper' } })

    await bond.startPiOAuth('anthropic')
    expect(calls.at(-1)).toEqual({ method: 'pi.startOAuth', params: { provider: 'anthropic' } })

    await bond.getModel()
    expect(calls.at(-1)).toEqual({ method: 'bond.getModel', params: undefined })
  })
})
