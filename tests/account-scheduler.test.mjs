import assert from 'node:assert/strict'
import test from 'node:test'

import path from 'node:path'
import { pathToFileURL } from 'node:url'

const buildDir = process.env.POOL_TEST_BUILD_DIR
  ? pathToFileURL(path.resolve(process.env.POOL_TEST_BUILD_DIR)).href
  : new URL('../dist-electron', import.meta.url).href
const { AccountTaskScheduler } = await import(`${buildDir}/account-scheduler.js`)

const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve))

test('runs different accounts concurrently', async () => {
  const gates = new Map([[1, deferred()], [2, deferred()]])
  const started = []
  const scheduler = new AccountTaskScheduler(
    () => 2,
    async (item) => {
      started.push(item.key)
      await gates.get(item.accountId).promise
    },
  )

  scheduler.enqueue({ key: 'one', accountId: 1 })
  scheduler.enqueue({ key: 'two', accountId: 2 })
  await nextTurn()
  assert.deepEqual(started.sort(), ['one', 'two'])

  gates.get(1).resolve()
  gates.get(2).resolve()
})

test('keeps tasks for the same account sequential', async () => {
  const firstGate = deferred()
  const started = []
  const scheduler = new AccountTaskScheduler(
    () => 2,
    async (item) => {
      started.push(item.key)
      if (item.key === 'first') await firstGate.promise
    },
  )

  scheduler.enqueue({ key: 'first', accountId: 1 })
  scheduler.enqueue({ key: 'second', accountId: 1 })
  await nextTurn()
  assert.deepEqual(started, ['first'])

  firstGate.resolve()
  await nextTurn()
  assert.deepEqual(started, ['first', 'second'])
})

test('honors the configured concurrency limit', async () => {
  const firstGate = deferred()
  const started = []
  const scheduler = new AccountTaskScheduler(
    () => 1,
    async (item) => {
      started.push(item.key)
      if (item.key === 'first') await firstGate.promise
    },
  )

  scheduler.enqueue({ key: 'first', accountId: 1 })
  scheduler.enqueue({ key: 'second', accountId: 2 })
  await nextTurn()
  assert.deepEqual(started, ['first'])

  firstGate.resolve()
  await nextTurn()
  assert.deepEqual(started, ['first', 'second'])
})

test('requeue from inside the running worker runs again after the key is released (retry regression)', async () => {
  const runs = []
  let scheduler
  scheduler = new AccountTaskScheduler(
    () => 2,
    async (item) => {
      runs.push(`${item.key}@${item.accountId}`)
      if (runs.length === 1) {
        // 旧实现在这里调用 enqueue 会因 key 仍在执行而被静默丢弃，请求永远卡在 accepted。
        assert.equal(scheduler.enqueue({ key: item.key, accountId: 2 }), false)
        assert.equal(scheduler.requeue({ key: item.key, accountId: 2 }), true)
        assert.equal(scheduler.has(item.key), true)
      }
    },
  )

  scheduler.enqueue({ key: 'req-1', accountId: 1 })
  await nextTurn()
  await nextTurn()
  await nextTurn()
  assert.deepEqual(runs, ['req-1@1', 'req-1@2'])
  assert.equal(scheduler.has('req-1'), false)
})

test('requeued retry jumps ahead of tasks that were queued later', async () => {
  const gate = deferred()
  const runs = []
  let scheduler
  scheduler = new AccountTaskScheduler(
    () => 1,
    async (item) => {
      runs.push(`${item.key}@${item.accountId}`)
      if (item.key === 'retry' && item.accountId === 1) {
        scheduler.enqueue({ key: 'later', accountId: 3 })
        scheduler.requeue({ key: 'retry', accountId: 2 })
        await gate.promise
      }
    },
  )

  scheduler.enqueue({ key: 'retry', accountId: 1 })
  await nextTurn()
  gate.resolve()
  for (let i = 0; i < 6; i += 1) await nextTurn()
  assert.deepEqual(runs, ['retry@1', 'retry@2', 'later@3'])
})

test('remove drops queued tasks but leaves running ones alone', async () => {
  const gate = deferred()
  const started = []
  const scheduler = new AccountTaskScheduler(
    () => 1,
    async (item) => {
      started.push(item.key)
      await gate.promise
    },
  )

  scheduler.enqueue({ key: 'running', accountId: 1 })
  scheduler.enqueue({ key: 'queued', accountId: 2 })
  await nextTurn()
  assert.equal(scheduler.isActive('running'), true)
  assert.equal(scheduler.remove('queued'), true)
  assert.equal(scheduler.remove('running'), false)
  assert.equal(scheduler.has('queued'), false)
  assert.equal(scheduler.has('running'), true)
  gate.resolve()
  await nextTurn()
  await nextTurn()
  assert.deepEqual(started, ['running'])
})
