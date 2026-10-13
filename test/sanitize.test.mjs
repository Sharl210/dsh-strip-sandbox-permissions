/**
 * End-to-end test for dsh-strip-sandbox-permissions.
 *
 * Mocks a minimal Cordis context, applies the real plugin (once per
 * `reasoningEffort` mode), and feeds fake `llm/stream` waterfalls through the
 * registered listener, asserting both the stripping behaviour and the untouched
 * pass-through paths.
 *
 * Run: `node test/sanitize.test.mjs`
 */
import assert from 'node:assert/strict'
import { name, apply } from '../lib/index.js'

assert.equal(name, 'dsh-strip-sandbox-permissions', 'plugin name mismatch')

/**
 * Apply the plugin with a given config and capture its listener.
 * @param {object} [config] - raw plugin config.
 * @returns {object} the captured `{ ev, fn, opts }` registration.
 */
function mount(config) {
  let registered = null
  const ctx = {
    on(ev, fn, opts) {
      registered = { ev, fn, opts }
      return () => {}
    },
  }
  apply(ctx, config)
  assert.equal(registered.ev, 'llm/stream', 'listener must be llm/stream')
  assert.equal(registered.opts?.global, true, 'listener must be global')
  return registered
}

/** Default mode: strip empty reasoning_effort placeholders only. */
const defaultListener = mount()
/** Always mode: strip reasoning_effort whatever it carries. */
const alwaysListener = mount({ reasoningEffort: 'always' })

/** Build a tool-call block-end chunk around raw arguments. */
function toolCall(index, id, toolName, args) {
  return {
    type: 'block-end',
    index,
    block: { type: 'tool-call', id, name: toolName, arguments: JSON.stringify(args) },
  }
}

/**
 * Push chunks through a listener and collect the output.
 * @param {object} listener - a captured registration.
 * @param {object[]} chunks - upstream chunks.
 * @returns {Promise<object[]>} the listener's output.
 */
async function run(listener, chunks) {
  const out = []
  for await (const chunk of listener.fn({ provider: 'x' }, () => chunks)) out.push(chunk)
  return out
}

/** Parsed arguments of an output block-end chunk. */
const argsOf = (chunk) => JSON.parse(chunk.block.arguments)

let passed = 0
/**
 * Await one named check, then count it. The await matters: a synchronous
 * `check` around an async body would count the check before its assertions
 * ran, turning a failure into an unhandled rejection and a false pass.
 * @param {string} label - human-readable check name.
 * @param {Function} fn - assertions, sync or async.
 */
async function check(label, fn) {
  await fn()
  passed += 1
  console.log('PASS:', label)
}

// --- 1. escalation keys: stripped regardless of value -----------------------

{
  const upstream = [
    { type: 'tool-call-delta', index: 0, id: 'c1', name: 'bash', argumentsDelta: '{}' },
    toolCall(0, 'c1', 'bash', {
      command: 'ls',
      description: 'x',
      sandbox_permissions: 'workspace-write',
      justification: 'need write',
    }),
    toolCall(1, 'c2', 'edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b' }),
    { type: 'text-delta', index: 2, text: 'hi' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const out = await run(defaultListener, upstream)
  const ends = out.filter((c) => c.type === 'block-end')

  await check('携带权限的 block-end 被剥离', () => {
    assert.equal(ends.length, 2, 'two block-end chunks expected')
    const cleaned = argsOf(ends[0])
    assert.equal('sandbox_permissions' in cleaned, false)
    assert.equal('justification' in cleaned, false)
    assert.equal(cleaned.command, 'ls', 'other args preserved')
    assert.equal(cleaned.description, 'x', 'other args preserved')
  })

  await check('干净 block 原样透传（同一对象引用，零开销）', () => {
    assert.equal(ends[1], upstream[2], 'untouched block must be the very same chunk')
  })

  await check('非 tool-call 块与流结构不受影响', () => {
    assert.equal(out.length, 5, 'all chunks preserved')
    assert.equal(out[3].type, 'text-delta')
    assert.equal(out[3].text, 'hi')
    assert.equal(out[4].type, 'finish')
  })
}

// --- 2. default mode: empty placeholder stripped, real value kept -----------

{
  const upstream = [
    toolCall(0, 'r1', 'subagent', {
      description: 'delegate',
      prompt: 'do it',
      provider: 'my',
      model: '[copilot]deepseek-v4-pro',
      reasoning_effort: '',
    }),
    toolCall(1, 'r2', 'subagent', { prompt: 'a', reasoning_effort: '   ' }),
    toolCall(2, 'r3', 'subagent', { prompt: 'b', reasoning_effort: null }),
    toolCall(3, 'r4', 'subagent', { prompt: 'c', reasoning_effort: 'high' }),
    toolCall(4, 'r5', 'subagent', { prompt: 'd' }),
    toolCall(5, 'r6', 'subagent', { prompt: 'e', reasoning_effort: 0 }),
  ]
  const out = await run(defaultListener, upstream)
  const ends = out.filter((c) => c.type === 'block-end')

  await check('[默认] reasoning_effort 空串被抠掉，其余参数保留', () => {
    const cleaned = argsOf(ends[0])
    assert.equal('reasoning_effort' in cleaned, false)
    assert.equal(cleaned.provider, 'my')
    assert.equal(cleaned.model, '[copilot]deepseek-v4-pro')
    assert.equal(cleaned.prompt, 'do it')
    assert.equal(cleaned.description, 'delegate')
  })

  await check('[默认] 纯空白 reasoning_effort 同样视为空占位', () => {
    assert.equal('reasoning_effort' in argsOf(ends[1]), false)
  })

  await check('[默认] null reasoning_effort 视为空占位', () => {
    assert.equal('reasoning_effort' in argsOf(ends[2]), false)
  })

  await check('[默认] 非空 reasoning_effort 是真实意图，原样保留', () => {
    assert.equal(argsOf(ends[3]).reasoning_effort, 'high')
  })

  await check('[默认] 未提供的字段不被凭空添加', () => {
    assert.deepEqual(argsOf(ends[4]), { prompt: 'd' })
  })

  await check('[默认] 数字 0 不算空占位，交给原校验报错', () => {
    assert.equal(argsOf(ends[5]).reasoning_effort, 0)
  })
}

// --- 3. always mode: the key never reaches the runtime ---------------------

{
  const upstream = [
    toolCall(0, 'a1', 'subagent', { prompt: 'p', provider: 'my', model: 'm', reasoning_effort: 'high' }),
    toolCall(1, 'a2', 'subagent', { prompt: 'p', reasoning_effort: 'medium' }),
    toolCall(2, 'a3', 'subagent', { prompt: 'p', reasoning_effort: '' }),
    toolCall(3, 'a4', 'subagent', { prompt: 'p', reasoning_effort: null }),
    toolCall(4, 'a5', 'subagent', { prompt: 'p', provider: 'my', model: 'm' }),
  ]
  const out = await run(alwaysListener, upstream)
  const ends = out.filter((c) => c.type === 'block-end')

  await check('[always] 用户实测的那个值 high 被抠掉（模型不支持任何档位）', () => {
    assert.deepEqual(argsOf(ends[0]), { prompt: 'p', provider: 'my', model: 'm' })
  })

  await check('[always] medium 同样被抠掉', () => {
    assert.deepEqual(argsOf(ends[1]), { prompt: 'p' })
  })

  await check('[always] 空串仍被抠掉', () => {
    assert.deepEqual(argsOf(ends[2]), { prompt: 'p' })
  })

  await check('[always] null 仍被抠掉', () => {
    assert.deepEqual(argsOf(ends[3]), { prompt: 'p' })
  })

  await check('[always] 未提供该字段的调用完全不动（同一引用）', () => {
    assert.equal(ends[4], upstream[4], 'absent key must not create a rewrite')
  })
}

// --- 4. config handling ----------------------------------------------------

{
  await check('未知/缺失/非法 reasoningEffort 一律退回保守的 empty 模式', async () => {
    for (const config of [undefined, {}, { reasoningEffort: 'ALWAYS' }, { reasoningEffort: 'never' }, { reasoningEffort: 1 }, null]) {
      const listener = mount(config)
      const out = await run(listener, [toolCall(0, 'x', 'subagent', { prompt: 'p', reasoning_effort: 'high' })])
      assert.equal(argsOf(out[0]).reasoning_effort, 'high', `config ${JSON.stringify(config)} must keep non-empty values`)
    }
  })
}

// --- 5. safety: other empty strings are none of our business ---------------

{
  const upstream = [
    toolCall(0, 's1', 'write', { file_path: 'a.txt', content: '' }),
    toolCall(1, 's2', 'bash', { command: 'ls', note: '', description: '' }),
  ]
  const out = await run(defaultListener, upstream)
  const ends = out.filter((c) => c.type === 'block-end')

  await check('无关字段的空字符串不被误伤', () => {
    assert.deepEqual(argsOf(ends[0]), { file_path: 'a.txt', content: '' })
    assert.deepEqual(argsOf(ends[1]), { command: 'ls', note: '', description: '' })
    assert.equal(ends[0], upstream[0], 'no rewrite when nothing matches')
    assert.equal(ends[1], upstream[1], 'no rewrite when nothing matches')
  })
}

// --- 6. malformed input is left alone --------------------------------------

{
  const upstream = [
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'm1', name: 'x', arguments: '{not json' } },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'm2', name: 'x', arguments: '[1,2]' } },
    { type: 'block-end', index: 2, block: { type: 'text', text: 'hello' } },
    { type: 'block-end', index: 3, block: { type: 'tool-call', id: 'm4', name: 'x' } },
  ]
  const out = await run(alwaysListener, upstream)

  await check('非法 JSON / 非对象 / 非 tool-call / 无 arguments 一律原样透传', () => {
    assert.equal(out.length, 4)
    for (let i = 0; i < 4; i += 1) assert.equal(out[i], upstream[i], `chunk ${i} must pass through by reference`)
  })
}

// --- 7. both classes in one call -------------------------------------------

{
  const upstream = [
    toolCall(0, 'b1', 'subagent', {
      prompt: 'x',
      reasoning_effort: '',
      sandbox_permissions: 'danger-full-access',
      justification: 'y',
    }),
  ]
  const out = await run(defaultListener, upstream)

  await check('同一调用里的两类脏参数一次清理干净', () => {
    assert.deepEqual(argsOf(out[0]), { prompt: 'x' })
  })
}

console.log(`\nPASS: 共 ${passed} 项检查全部通过`)
