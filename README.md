# dsh-strip-sandbox-permissions

A zero-dependency DeepSeek Harness (DSH) plugin that removes placeholder
arguments some models attach to tool calls — arguments that DSH then rejects
even though the call would have worked fine without them.

Two kinds of junk are handled. Both come from the same habit: a model fills in
an optional field it has nothing to say about, instead of leaving it out.

| Field | When it is removed | What it otherwise breaks |
|---|---|---|
| `sandbox_permissions`, `justification` | always (any value) | false sandbox escalation rejection |
| `reasoning_effort` | only when empty (`""`, whitespace-only, `null`) | subagent delegation rejected |

## Problem 1 — false sandbox escalation

Some models (a post-training tendency) automatically attach `sandbox_permissions`
(and its companion `justification`) to tool calls. When the session already runs
with sufficient permission (for example full access), carrying a non-strictly-wider
value triggers a false rejection from the DSH sandbox:

```
Error: sandbox escalation to "workspace-write" is not strictly wider than this call's current "workspace-write" mode
```

The command that should have run is refused. Any value of these two keys is
escalation noise, so both are removed whatever they carry.

## Problem 2 — empty `reasoning_effort` on subagent delegation

`reasoning_effort` is an optional child-LLM routing field on the subagent
delegation tools. Omitting it inherits a compatible configured/parent effort, or
falls back to the selected model's default. Some models cannot leave it alone
and emit:

```json
{ "provider": "my", "model": "...", "reasoning_effort": "" }
```

That empty string is not "no effort" to the runtime. The delegation tool treats
the mere presence of the key as an explicit route selection, then rejects the
value:

```
Error: child LLM `reasoning_effort` must be non-empty
```

An empty placeholder means exactly what omission means, so it is deleted and the
call proceeds as if the model had said nothing. A **non-empty** effort is a
deliberate routing choice and is passed through verbatim.

## How it works

Every model tool call flows through the `llm/stream` waterfall (both the agent
loop's `preparedCall.stream` and `llm.stream` route through
`streamWithRegistration` → `ctx.waterfall(this, 'llm/stream', ...)`), so this is
the single interception point that covers every adapter, including child agents
running in-process. Adapters emit a `block-end` chunk carrying the fully
assembled tool-call block at the end of the stream. This plugin rewrites that
block: it parses the arguments object, deletes the offending top-level keys, and
re-serializes. Session logs and replay both see the cleaned arguments, so
nothing downstream disagrees.

Only the keys listed above are touched; every other argument — and every other
empty string anywhere in the object — is preserved verbatim. A new block is
produced only when something was actually removed — otherwise the original block
object is passed through unchanged (zero cost). Invalid JSON, non-object
arguments, and non-tool-call blocks are left untouched.

## Install

Published on npm. Install with:

```sh
dsh plugin --profile <your-profile> add dsh-strip-sandbox-permissions
```

Restart DSH after installing. Verify:

```sh
dsh plugin --profile <your-profile> list
```

## Package / publish

```sh
npm pack          # produce dsh-strip-sandbox-permissions-<version>.tgz
npm publish       # publish a new version to the npm registry
```

A granular access token with **Bypass 2FA** enabled and **Read and write**
package access is required to publish; a token without bypass 2FA is rejected
with a 403 even when otherwise valid.

## 中文说明

一个零依赖的 DeepSeek Harness（DSH）插件：把模型硬塞进工具调用参数、随后被 DSH
拒收的占位参数清理掉。很多调用本来不写这些字段就能正常跑通，是被这些多余字段拖垮的。

处理两类字段，毛病同源——模型非要在自己没有意见的可选字段上填一个空占位，而不是直接省略：

| 字段 | 何时删除 | 不删会坏在哪 |
|---|---|---|
| `sandbox_permissions`、`justification` | 一律删除（不看值） | 沙箱权限误拒绝 |
| `reasoning_effort` | 仅在空值时（`""`、纯空白、`null`） | 子代理派发被拒 |

**第一类：沙箱权限误拒绝。** 部分模型（后训练倾向）会自动在工具调用里带上
`sandbox_permissions` 及其配套的 `justification`。当会话已经处于足够权限（例如完整
访问权限）时，带上一个并非严格更宽的值会触发 DSH 沙箱的误拒绝，本该正常执行的命令
被挡下。这两个键无论值是什么都属于升级噪声，因此一律删除。

**第二类：子代理派发里的空 `reasoning_effort`。** `reasoning_effort` 是子代理派发
工具上一个可选的子模型路由字段，省略它会继承已配置的或父级的推理档位，或退回所选
模型的默认档。但有些模型非要写上 `"reasoning_effort": ""`。这个空串在运行时看来
并不是"不指定"，派发工具只要看到这个键存在就认定模型做了显式路由选择，接着拒绝这个
空值并抛出 `child LLM reasoning_effort must be non-empty`。空占位的含义和省略完全
一样，所以直接删掉，让调用按"模型什么都没说"继续走。非空的档位值是真实的路由意图，
原样保留。

**实现方式。** 所有模型工具调用都要经过 `llm/stream` 瀑布流，因此这是覆盖全部适配器
的唯一拦截点，进程内运行的子代理同样覆盖。适配器在流末尾用 `block-end` 块携带组装完整
的工具调用块，本插件解析其参数对象、从顶层删除需要清理的键、再序列化回去。会话日志和
重放看到的都是清理后的参数，下游不会出现分歧。

只动上面列出的键，其余参数原样保留，对象里其它空字符串也不碰。只有在确实删掉了东西时
才新建块，未命中时原对象零开销透传。非法 JSON、非对象参数、非工具调用块一律不动。

安装：

```sh
dsh plugin --profile <你的profile名> add dsh-strip-sandbox-permissions
```

安装完成后重启 DSH 即生效。

## License

MIT
