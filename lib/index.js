/**
 * dsh-strip-sandbox-permissions — ignore `sandbox_permissions` / `justification`
 * carried in model tool-call arguments.
 *
 * WHY: some models (post-training tendency) automatically attach
 * `sandbox_permissions` (and its companion `justification`) to tool calls. When
 * the session already runs with sufficient permission (for example full access),
 * carrying a non-strictly-wider value triggers a false rejection:
 *
 *   `sandbox escalation to "<mode>" is not strictly wider than this call's current "<mode>" mode`
 *
 * raised by the shared escalation validator (`@deepseek-ai/dsh-sandbox`
 * `approveEscalation`), and the command that should have run is refused.
 *
 * HOW: every model tool call flows through the `llm/stream` waterfall (both the
 * agent loop's `preparedCall.stream` and `llm.stream` route through
 * `streamWithRegistration` → `ctx.waterfall(this, 'llm/stream', ...)`), so this
 * is the single interception point that covers every adapter. Adapters emit a
 * `block-end` chunk carrying the fully assembled tool-call block (its
 * `arguments` is the complete JSON string) at the end of the stream. This
 * plugin rewrites that block: it parses the arguments object, deletes the
 * top-level `sandbox_permissions` / `justification` keys, and re-serializes.
 * Session logs (`assistant/chunk`) and replay both see the cleaned arguments,
 * so nothing downstream disagrees.
 *
 * SAFETY: only those two escalation-specific keys are stripped; every other
 * argument is preserved verbatim. A new block is produced only when one of the
 * keys actually exists — otherwise the original block object is passed through
 * unchanged (zero cost). Invalid JSON, non-object arguments, and non-tool-call
 * blocks are left untouched.
 *
 * Zero-dependency: this module imports nothing and only registers one event
 * listener on the host.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-strip-sandbox-permissions'

/** Only these two keys are escalation-specific and safe to strip. */
const STRIP_KEYS = ['sandbox_permissions', 'justification']

/**
 * Clean one content block: only handles tool-call blocks whose arguments parse
 * as a plain object containing an escalation key.
 * @param {object | undefined} block - the assembled block.
 * @returns {object} the original block when untouched, or a new block with the
 *   escalation keys removed when touched.
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
  let touched = false
  for (const key of STRIP_KEYS) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) {
      touched = true
      break
    }
  }
  if (!touched) return block
  const next = { ...parsed }
  for (const key of STRIP_KEYS) delete next[key]
  return { ...block, arguments: JSON.stringify(next) }
}

/**
 * Wrap the `llm/stream` waterfall: rewrite `block-end` chunks that carry the
 * escalation keys, pass everything else through untouched.
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
