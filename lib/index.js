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
 * 2. `reasoning_effort`, governed by config `reasoningEffort`
 *    `reasoning_effort` is an optional child-LLM routing field on the subagent
 *    delegation tools: omitting it inherits a compatible configured/parent
 *    effort or the selected model's default. The runtime rejects a supplied
 *    value in two distinct ways, and both mean "this field should not have been
 *    sent":
 *
 *      a) `child LLM \`reasoning_effort\` must be non-empty`
 *         `@deepseek-ai/dsh-tool-subagent` treats the mere presence of the key
 *         as an explicit route selection (`hasDelegationModelRequest`), so even
 *         an empty placeholder `""` is rejected by `assertNonEmpty`. Some models
 *         emit exactly that instead of omitting the field.
 *
 *      b) `provider "<p>" model "<m>" does not support reasoning effort "<v>"`
 *         The value survives, but the target model advertises no reasoning
 *         efforts, so the LLM runtime refuses it. Any value — `"high"`,
 *         `"medium"`, whatever the model guessed — fails the same way.
 *
 *    Case (a) is fixed unconditionally: an empty placeholder means exactly what
 *    omission means, so it is deleted and the call proceeds as if the model had
 *    said nothing.
 *
 *    Case (b) depends on the routes a deployment actually uses. Stripping a
 *    NON-empty effort on a model that genuinely supports reasoning efforts would
 *    silently discard a deliberate choice, so that is not the default. Set
 *
 *      config: { reasoningEffort: always }
 *
 *    to drop the key whatever it carries — the right setting when none of the
 *    deployment's routes advertises reasoning efforts (getting the effort
 *    through is impossible anyway, so a stray value only ever kills the call).
 *
 * HOW: every model tool call flows through the `llm/stream` waterfall (both the
 * agent loop's `preparedCall.stream` and `llm.stream` route through
 * `streamWithRegistration` → `ctx.waterfall(this, 'llm/stream', ...)`), so this
 * is the single interception point covering every adapter that goes through the
 * harness LLM runtime, and it also covers child agents running in-process
 * (the hook is `global: true`, so it reaches child scopes as well). Adapters
 * emit a `block-end` chunk carrying the assembled tool-call block at the end of
 * the stream. This plugin rewrites that block: it parses the arguments object,
 * deletes the offending top-level keys, and re-serializes.
 *
 * WHAT THE REWRITE DOES AND DOES NOT COVER (verified against the real runtime,
 * not assumed):
 * - The ASSEMBLED tool call — what actually executes, and what the durable
 *   `assistant/message` carries — uses the rewritten block. That is the part
 *   that decides whether the call succeeds.
 * - The raw incremental `tool-call-chunks` deltas are emitted BEFORE `block-end`
 *   and pass through untouched, so a session log's delta records still contain
 *   the original key. This was confirmed empirically: a probe whose model output
 *   contained `"reasoning_effort":"high"` kept that text in its delta records
 *   while its `block-end` came out clean. Rewriting deltas in flight is not
 *   possible (a key can straddle a delta boundary), so this is a known,
 *   accepted limitation rather than an oversight. Consumers that rebuild a call
 *   from deltas — replay tooling — may therefore still see the key.
 * - Only model-issued calls are seen. A PTC-mode `run_code` program that calls a
 *   tool programmatically (`tools.subagent({...})`) builds its arguments in
 *   code and never produces a model `block-end`, so this plugin cannot clean it.
 *   That gap is inert while `tools` mode is `native`; it becomes live if the
 *   deployment selects `ptc`/`both`.
 *
 * Escalation caveat: `sandbox_permissions`/`justification` are legitimate
 * optional arguments on the bash/fs/pwsh/run_code tools, not pure noise. They
 * are stripped unconditionally because the common failure mode is a model
 * attaching them out of habit and losing the call to a "not strictly wider"
 * rejection. In a genuinely restricted session that means a deliberate, valid
 * escalation request is also dropped: the tool then runs under the standing
 * policy and may simply be denied. Set `reasoningEffort`-style policy aside —
 * if a restricted deployment needs model-driven escalation, this plugin should
 * not be installed there as-is.
 *
 * SAFETY: only the keys named above are touched; every other argument — and
 * every other empty string anywhere in the object — is preserved verbatim. A
 * new block is produced only when something was actually removed, otherwise the
 * original block object is passed through unchanged (zero cost). Invalid JSON,
 * non-object arguments, and non-tool-call blocks are left untouched.
 *
 * Zero-dependency: this module imports nothing and only registers one event
 * listener on the host. Configuration is read as a plain object because Cordis
 * passes raw config through when a plugin declares no `Config` schema, which
 * keeps the package free of any `peerDependencies`. An unknown or missing
 * `reasoningEffort` value falls back to the conservative `"empty"` mode.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-strip-sandbox-permissions'

/**
 * Escalation-specific keys: removed whatever value they carry, because the key
 * itself (not its value) is what triggers the false sandbox rejection.
 */
const ALWAYS_STRIP_KEYS = ['sandbox_permissions', 'justification']

/**
 * Optional routing key governed by the `reasoningEffort` config.
 * - `"empty"` (default): removed only when the model left an empty placeholder,
 *   in which case deleting the key restores the intended meaning ("omitted,
 *   inherit the default"). A non-empty value is a real routing choice.
 * - `"always"`: removed whatever it carries, for deployments whose routes
 *   advertise no reasoning efforts at all.
 */
const REASONING_EFFORT_KEY = 'reasoning_effort'

/** Accepted `reasoningEffort` config values. */
const MODE_EMPTY = 'empty'
const MODE_ALWAYS = 'always'

/**
 * Resolve the effective `reasoningEffort` mode from raw plugin config.
 * @param {unknown} config - raw Cordis plugin config.
 * @returns {string} `"always"` when explicitly requested, else `"empty"`.
 */
function resolveReasoningEffortMode(config) {
  const value = config !== null && typeof config === 'object' ? config.reasoningEffort : undefined
  return value === MODE_ALWAYS ? MODE_ALWAYS : MODE_EMPTY
}

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
 * @param {string} effortMode - effective `reasoningEffort` mode.
 * @returns {string[]} keys to delete, empty when the call is already clean.
 */
function keysToStrip(parsed, effortMode) {
  const strip = []
  for (const key of ALWAYS_STRIP_KEYS) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) strip.push(key)
  }
  if (Object.prototype.hasOwnProperty.call(parsed, REASONING_EFFORT_KEY)) {
    if (effortMode === MODE_ALWAYS || !hasUsableValue(parsed[REASONING_EFFORT_KEY])) strip.push(REASONING_EFFORT_KEY)
  }
  return strip
}

/**
 * Clean one content block: only handles tool-call blocks whose arguments parse
 * as a plain object containing a strippable key.
 * @param {object | undefined} block - the assembled block.
 * @param {string} effortMode - effective `reasoningEffort` mode.
 * @returns {object} the original block when untouched, or a new block with the
 *   offending keys removed when touched.
 */
function sanitizeBlock(block, effortMode) {
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
  const strip = keysToStrip(parsed, effortMode)
  if (strip.length === 0) return block
  const next = { ...parsed }
  for (const key of strip) delete next[key]
  return { ...block, arguments: JSON.stringify(next) }
}

/**
 * Wrap the `llm/stream` waterfall: rewrite `block-end` chunks that carry a
 * strippable argument, pass everything else through untouched.
 * @param {object} ctx - the Cordis plugin context.
 * @param {object} [config] - raw plugin config; `reasoningEffort` selects the
 *   effort-stripping mode.
 */
export function apply(ctx, config) {
  const effortMode = resolveReasoningEffortMode(config)
  ctx.on('llm/stream', (options, next) => {
    const upstream = next()
    return (async function* () {
      for await (const chunk of upstream) {
        if (chunk.type === 'block-end') {
          const block = sanitizeBlock(chunk.block, effortMode)
          yield block === chunk.block ? chunk : { ...chunk, block }
        } else {
          yield chunk
        }
      }
    })()
  }, { global: true })
}
