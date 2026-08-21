# dsh-strip-sandbox-permissions

A zero-dependency DeepSeek Harness (DSH) plugin that ignores `sandbox_permissions` /
`justification` fields carried in model tool-call arguments, preventing false
sandbox escalation rejections.

## Problem

Some models (a post-training tendency) automatically attach `sandbox_permissions`
(and its companion `justification`) to tool calls. When the session already runs
with sufficient permission (for example full access), carrying a non-strictly-wider
value triggers a false rejection from the DSH sandbox:

```
Error: sandbox escalation to "workspace-write" is not strictly wider than this call's current "workspace-write" mode
```

## How it works

Every model tool call flows through the `llm/stream` waterfall, so this is the
single interception point that covers every adapter. Adapters emit a `block-end`
chunk carrying the fully assembled tool-call block at the end of the stream.
This plugin rewrites that block: it parses the arguments object, deletes the
top-level `sandbox_permissions` / `justification` keys, and re-serializes.
Session logs and replay both see the cleaned arguments, so nothing downstream
disagrees.

Only those two escalation-specific keys are stripped; every other argument is
preserved verbatim. A new block is produced only when one of the keys actually
exists — otherwise the original block is passed through unchanged (zero cost).
Invalid JSON, non-object arguments, and non-tool-call blocks are left untouched.

## Install

```sh
dsh plugin --profile <your-profile> add dsh-strip-sandbox-permissions
```

Restart DSH after installing. Verify:

```sh
dsh plugin --profile <your-profile> list
```

## License

MIT
