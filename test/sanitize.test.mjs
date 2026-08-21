/**
 * End-to-end test for dsh-strip-sandbox-permissions.
 *
 * Mocks a minimal Cordis context, applies the real plugin, and feeds a fake
 * `llm/stream` waterfall containing a tool call that carries
 * `sandbox_permissions` / `justification`, plus normal blocks that must pass
 * through untouched.
 *
 * Run: `node test/sanitize.test.mjs`
 */
import assert from 'node:assert/strict'
import { name, apply } from '../lib/index.js'

let registered = null
const ctx = {
  on(ev, fn, opts) {
    registered = { ev, fn, opts }
    return () => {}
  },
}

apply(ctx)

assert.equal(registered.ev, 'llm/stream', 'listener must be llm/stream')
assert.equal(registered.opts?.global, true, 'listener must be global')
assert.equal(name, 'dsh-strip-sandbox-permissions', 'plugin name mismatch')

function* upstream() {
  yield { type: 'tool-call-delta', index: 0, id: 'c1', name: 'bash', argumentsDelta: '{}' }
  yield {
    type: 'block-end',
    index: 0,
    block: {
      type: 'tool-call',
      id: 'c1',
      name: 'bash',
      arguments: JSON.stringify({
        command: 'ls',
        description: 'x',
        sandbox_permissions: 'workspace-write',
        justification: 'need write',
      }),
    },
  }
  yield {
    type: 'block-end',
    index: 1,
    block: {
      type: 'tool-call',
      id: 'c2',
      name: 'edit',
      arguments: JSON.stringify({ file_path: 'a.txt', old_string: 'a', new_string: 'b' }),
    },
  }
  yield { type: 'text-delta', index: 2, text: 'hi' }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

const out = []
for await (const chunk of registered.fn({ provider: 'x' }, () => upstream())) out.push(chunk)

// 1. 携带权限的 block-end 被剥离
const ends = out.filter((c) => c.type === 'block-end')
assert.equal(ends.length, 2, 'two block-end chunks expected')
const cleaned = JSON.parse(ends[0].block.arguments)
assert.equal('sandbox_permissions' in cleaned, false, 'sandbox_permissions must be stripped')
assert.equal('justification' in cleaned, false, 'justification must be stripped')
assert.equal(cleaned.command, 'ls', 'other args preserved')
assert.equal(cleaned.description, 'x', 'other args preserved')

// 2. 正常 block-end 原样透传
assert.equal(
  ends[1].block.arguments,
  JSON.stringify({ file_path: 'a.txt', old_string: 'a', new_string: 'b' }),
  'clean block must pass through unchanged',
)

// 3. 非 block-end 块原样透传
assert.equal(out.length, 5, 'all chunks preserved')
assert.equal(out[3].type, 'text-delta')
assert.equal(out[3].text, 'hi')
assert.equal(out[4].type, 'finish')

console.log('PASS: 携带权限的 block-end 已剥离 ->', JSON.stringify(cleaned))
console.log('PASS: 正常 block-end / delta / finish 原样透传, 共', out.length, '块')
