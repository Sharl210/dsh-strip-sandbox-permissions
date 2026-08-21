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

## 中文说明

一个零依赖的 DeepSeek Harness（DSH）插件：忽略模型工具调用参数里携带的
`sandbox_permissions` / `justification` 字段，避免沙箱权限误拒绝。

部分模型（后训练倾向）会在工具调用参数里自动带上 `sandbox_permissions`（及其配套
`justification`）。当会话已处于足够权限（例如完整访问权限）时，携带一个非严格加宽的
值会触发 DSH 沙箱的误拒绝。本插件在 `llm/stream` 瀑布流（所有模型工具调用的必经点）
拦截 `block-end` 块，从工具参数对象顶层删除这两个字段后再交给装配器。只剥离这两个
升级专属字段，其余参数原样保留；未命中时零开销透传。

安装：

```sh
dsh plugin --profile <你的profile名> add dsh-strip-sandbox-permissions
```

安装完成后重启 DSH 即生效。

## License

MIT
