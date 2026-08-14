import assert from 'node:assert/strict'
import test from 'node:test'
import stampExecutableIcon from '../../scripts/stampExecutableIcon.cjs'

const { copyFileWithRetry } = stampExecutableIcon

test('executable stamping retries transient Windows file locks', async () => {
  let copies = 0
  const delays = []
  await copyFileWithRetry('source', 'target', {
    copy: async () => {
      copies += 1
      if (copies < 3) throw Object.assign(new Error('locked'), { code: 'EBUSY' })
    },
    sleep: async (milliseconds) => { delays.push(milliseconds) }
  })

  assert.equal(copies, 3)
  assert.deepEqual(delays, [50, 100])
})

test('executable stamping does not retry permanent copy failures', async () => {
  let copies = 0
  await assert.rejects(
    copyFileWithRetry('source', 'target', {
      copy: async () => {
        copies += 1
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      },
      sleep: async () => assert.fail('permanent errors must not sleep')
    }),
    /missing/
  )
  assert.equal(copies, 1)
})
