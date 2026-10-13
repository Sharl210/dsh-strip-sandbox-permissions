/**
 * dsh-strip-sandbox-permissions — drop placeholder arguments that models
 * attach to tool calls and that DSH then rejects.
 *
 * Two classes of junk are handled, both caused by the same habit: a model fills
 * in an optional field it has nothing to say about, instead of omitting it.
 *
 * 1. ALWAYS-STRIP (`sandbox_permissions`, `justification`)
 *    Some models (post-training tendency) automatically attach
 *    `sandbox_permissions` (and its companion `justification`) to tool calls.
 *    When the session already runs with sufficient permission (for example full
 *    access), carrying a non-strictly-wider value triggers a false rejection:
 *
 *      `sandbox escalation to "<mode>" is not strictly wider than this call's current "<mode>" mode`
 *
 *    raised by the shared escalation validator (`@deepseek-ai/dsh-sandbox`
 *    `approveEscalation`), and the command that should have run is refused.
 *    Any value of these two keys is escalation noise, so both are removed
 *    whatever they carry.
 *
 * 2. STRIP-WHEN-EMPTY (`reasoning_effort`)
 *    `reasoning_effort` is an optional child-LLM routing field on the subagent
 *    delegation tools: omitting it inherits a compatible configured/parent
 *    effort or the selected model's default. Some models cannot leave it alone
 *    and emit `"reasoning_effort": ""`. That empty string is not "no effort" to
 *    the runtime — `@deepseek-ai/dsh-tool-subagent` treats the mere presence of
 *    the key as an explicit route selection (`hasDelegationModelRequest`), then
 *    rejects the value in `assertNonEmpty`:
 *
 *      `child LLM \`reasoning_effort\` must be non-empty`
 *
 *    An empty placeholder means exactly what omission means, so it is deleted
 *    and the call proceeds as if the model had said nothing. A NON-empty effort
 *    is a deliberate, meaningful routing choice and is passed through verbatim.
 *
 * HOW: every model tool call flows through the `llm/stream` waterfall (both the
 * agent loop's `preparedCall.stream` and `llm.stream` route through
 * `streamWithRegistration` → `ctx.waterfall(this, 'llm/stream', ...)`), so this
 * is the single interception point that covers every adapter, and it also
 * covers child agents running in-process. Adapters emit a `block-end` chunk
 * carrying the fully assembled tool-call block (its `arguments` is the complete
 * JSON string) at the end of the stream. This plugin rewrites that block: it
 * parses the arguments object, deletes the offending top-level keys, and
 * re-serializes. Session logs (`assistant/chunk`) and replay both see the
 * cleaned arguments, so nothing downstream disagrees.
 *
 * SAFETY: only the keys named above are touched; every other argument — and
 * every other empty string anywhere in the object — is preserved verbatim. A
 * new block is produced only when something was actually removed, otherwise the
 * original block object is passed through unchanged (zero cost). Invalid JSON,
 * non-object arguments, and non-tool-call blocks are left untouched.
 *
 * Zero-dependency: this module imports nothing and only registers one event
 * listener on the host.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-strip-sandbox-permissions'

/**
 * Escalation-specific keys: removed whatever value they carry, because the key
 * itself (not its value) is what triggers the false sandbox rejection.
 */
const ALWAYS_STRIP_KEYS = ['sandbox_permissions', 'justification']

/**
 * Optional routing keys: removed only when the model left them as an empty
 * placeholder, in which case deleting the key restores the intended meaning
 * ("omitted, inherit the default"). A non-empty value is a real choice.
 */
const STRIP_WHEN_EMPTY_KEYS = ['reasoning_effort']

/**
 * Whether a value carries something the runtime can act on. Placeholders are
 * `null`, the empty string, and whitespace-only strings.
 * @param {unknown} value - the candidate value.
 * @returns {boolean} true when the value is a usable, non-placeholder value.
 */
function hasUsableValue(value) {
  if (value === null) return false
  if (typeof value === 'string') return value.trim() !== ''
  return true
}

/**
 * Collect the top-level argument keys this plugin removes from one parsed
 * arguments object.
 * @param {object} parsed - the parsed tool-call arguments.
 * @returns {string[]} keys to delete, empty when the call is already clean.
 */
function keysToStrip(parsed) {
  const strip = []
  for (const key of ALWAYS_STRIP_KEYS) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) strip.push(key)
  }
  for (const key of STRIP_WHEN_EMPTY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(parsed, key) && !hasUsableValue(parsed[key])) strip.push(key)
  }
  return strip
}

/**
 * Clean one content block: only handles tool-call blocks whose arguments parse
 * as a plain object containing a strippable key.
 * @param {object | undefined} block - the assembled block.
 * @returns {object} the original block when untouched, or a new block with the
 *   offending keys removed when touched.
 */
function sanitizeBlock(block) {
  if (!block || block.type !== 'tool-call') return block
  const raw = block.arguments
  if (typeof raw !== 'string' || raw.length === 0) return block
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return block // invalid JSON — leave untouched
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return block
  const strip = keysToStrip(parsed)
  if (strip.length === 0) return block
  const next = { ...parsed }
  for (const key of strip) delete next[key]
  return { ...block, arguments: JSON.stringify(next) }
}

/**
 * Wrap the `llm/stream` waterfall: rewrite `block-end` chunks that carry a
 * strippable argument, pass everything else through untouched.
 */
export function apply(ctx) {
  ctx.on('llm/stream', (options, next) => {
    const upstream = next()
    return (async function* () {
      for await (const chunk of upstream) {
        if (chunk.type === 'block-end') {
          const block = sanitizeBlock(chunk.block)
          yield block === chunk.block ? chunk : { ...chunk, block }
        } else {
          yield chunk
        }
      }
    })()
  }, { global: true })
}
