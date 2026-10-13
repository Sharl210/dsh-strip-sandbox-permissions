# dsh-strip-sandbox-permissions

A zero-dependency DeepSeek Harness (DSH) plugin that removes placeholder
arguments some models attach to tool calls — arguments that DSH then rejects
even though the call would have worked fine without them.

Two kinds of junk are handled. Both come from the same habit: a model fills in
an optional field it has nothing to say about, instead of leaving it out.

| Field | When it is removed | What it otherwise breaks |
|---|---|---|
| `sandbox_permissions`, `justification` | always (any value) | false sandbox escalation rejection |
| `reasoning_effort` | empty values by default; any value with `reasoningEffort: always` | subagent delegation rejected |

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

## Problem 2 — `reasoning_effort` on subagent delegation

`reasoning_effort` is an optional child-LLM routing field on the subagent
delegation tools. Omitting it inherits a compatible configured/parent effort, or
falls back to the selected model's default. The runtime rejects a supplied value
in two distinct ways, and both mean the field should not have been sent:

**(a) Empty placeholder** — the delegation tool treats the mere presence of the
key as an explicit route selection, so even `""` is rejected:

```
Error: child LLM `reasoning_effort` must be non-empty
```

**(b) Unsupported value** — the value survives to the provider preflight, but the
target model advertises no reasoning efforts, so it is refused:

```
Error: provider "my" model "[copilot]deepseek-v4-pro" does not support reasoning effort "high"
```

Case (a) is fixed unconditionally: an empty placeholder means exactly what
omission means, so the key is deleted and the call proceeds as if the model had
said nothing.

Case (b) depends on the routes a deployment actually uses, so it is opt-in. If
**none** of your routes advertises reasoning efforts, a stray effort can only
ever kill the call, and you want `reasoningEffort: always` (see below).

## Configuration

```yaml
# in your profile's cordis.patch.yml
- id: strip-sandbox-permissions
  config:
    reasoningEffort: always     # "empty" (default) | "always"
```

| Value | Behaviour |
|---|---|
| `empty` (default) | Remove `reasoning_effort` only when it is `""`, whitespace-only, or `null`. A non-empty effort is a deliberate routing choice and is passed through. |
| `always` | Remove `reasoning_effort` whatever it carries. Use when no route in the deployment supports reasoning efforts, so any value is guaranteed to fail. |

Any other or missing value falls back to the conservative `empty` mode.

## How it works

Every model tool call flows through the `llm/stream` waterfall (both the agent
loop's `preparedCall.stream` and `llm.stream` route through
`streamWithRegistration` → `ctx.waterfall(this, 'llm/stream', ...)`), so this is
the single interception point covering every adapter that goes through the
harness LLM runtime. The listener is registered with `global: true`, which skips
Cordis' context filter so it also reaches child agents and other sub-contexts;
without it a host-level listener could miss them. Adapters emit a `block-end`
chunk carrying the assembled tool-call block at the end of the stream. This
plugin rewrites that block: it parses the arguments object, deletes the
offending top-level keys, and re-serializes.

Only the keys listed above are touched; every other argument — and every other
empty string anywhere in the object — is preserved verbatim. A new block is
produced only when something was actually removed — otherwise the original block
object is passed through unchanged (zero cost). Invalid JSON, non-object
arguments, and non-tool-call blocks are left untouched.

### What the rewrite covers, and what it does not

These limits were verified against the running harness rather than assumed:

- **The assembled tool call is cleaned.** What actually executes, and what the
  durable `assistant/message` carries, uses the rewritten block. That is the part
  that decides whether the call succeeds.
- **Raw incremental deltas are not.** Adapters emit `tool-call-chunks` deltas
  *before* `block-end`, and those pass through untouched, so a session log's
  delta records still contain the original key. This was confirmed empirically: a
  probe whose model output contained `"reasoning_effort":"high"` kept that text in
  its delta records while its `block-end` came out clean. Rewriting deltas in
  flight is not possible — a key can straddle a delta boundary. Tooling that
  rebuilds a call from deltas may therefore still see the key.
- **Only model-issued calls are seen.** In PTC mode (`tools` mode `ptc`/`both`), a
  program inside `run_code` that calls a tool programmatically builds its
  arguments in code and never produces a model `block-end`, so this plugin cannot
  clean it. The gap is inert while `tools` mode is `native` (the default); it
  becomes live if a deployment selects `ptc`/`both`. Method is `llm/stream` only.
- **Escalation arguments have real meaning.** `sandbox_permissions` /
  `justification` are legitimate optional arguments on the bash/fs/pwsh/run_code
  tools, not pure noise. They are stripped unconditionally because the common
  failure mode is a model attaching them out of habit and losing the call to a
  "not strictly wider" rejection. In a genuinely *restricted* session this also
  drops a deliberate, valid escalation request: the tool then runs under the
  standing policy and may simply be denied. If a restricted deployment needs
  model-driven escalation, do not install this plugin there as-is.

## Install

Published on npm. Install with:

```sh
dsh plugin --profile <your-profile> add dsh-strip-sandbox-permissions
```

**A plugin change takes effect only after the DSH process restarts.** A
long-running `dsh web` keeps the plugin code it loaded at startup, so installing
or upgrading while it runs changes nothing until you restart. Check the process
start time against the install time if you are unsure whether a change is live.

Verify the plugin row is in the composed tree:

```sh
dsh --profile <your-profile> --dump-config | grep strip-sandbox
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
| `reasoning_effort` | 默认只删空值；配 `reasoningEffort: always` 后删任何值 | 子代理派发被拒 |

**第一类：沙箱权限误拒绝。** 部分模型（后训练倾向）会自动在工具调用里带上
`sandbox_permissions` 及其配套的 `justification`。当会话已经处于足够权限（例如完整
访问权限）时，带上一个并非严格更宽的值会触发 DSH 沙箱的误拒绝，本该正常执行的命令
被挡下。这两个键无论值是什么都属于升级噪声，因此一律删除。

**第二类：子代理派发里的 `reasoning_effort`。** 这个字段是子代理派发工具上一项可选的
子模型路由设置，省略它会继承已配置的或父级的推理档位，或退回所选模型的默认档。运行时
拒绝它的方式有两种，两种都说明这个字段本不该发出来：

- **空占位**：派发工具只要看到这个键存在，就认定模型做了显式路由选择，哪怕值是 `""`
  也照样拒绝，抛出 `child LLM reasoning_effort must be non-empty`。
- **值不被支持**：值虽然传下去了，但目标模型并没有声明任何推理档位，于是在路由预检那里
  被拒，抛出 `provider "..." model "..." does not support reasoning effort "high"`。

第一种情况**无条件修复**：空占位的含义和省略完全一样，直接删掉，让调用按"模型什么都没
说"继续走。第二种情况取决于部署实际用了哪些模型路由，因此做成**可选开关**：如果你所有
路由都不支持推理档位，那么带上任何档位值都只会把调用搞死，这时就该用
`reasoningEffort: always`。

**配置方式**（写进 profile 的 `cordis.patch.yml`）：

```yaml
- id: strip-sandbox-permissions
  config:
    reasoningEffort: always     # "empty"（默认）| "always"
```

`empty` 是默认值，只删空值，非空的档位值视为真实路由意图原样保留；`always` 则不看值一律
删除。填其它值或干脆不填，都会退回保守的 `empty`。

**实现方式。** 所有通过 harness LLM 运行时发起的模型工具调用都要经过 `llm/stream` 瀑布流，
因此这是覆盖全部适配器的唯一拦截点。监听器以 `global: true` 注册，会跳过 Cordis 的上下文
过滤，因此进程内运行的子代理、孙代理也能命中。适配器在流末尾用 `block-end` 块携带组装好的
工具调用块，本插件解析其参数对象、从顶层删除需要清理的键、再序列化回去。

只动上面列出的键，其余参数原样保留，对象里其它空字符串也不碰。只有在确实删掉了东西时
才新建块，未命中时原对象零开销透传。非法 JSON、非对象参数、非工具调用块一律不动。

**覆盖范围与已知边界**（以下均经真实运行时核验，不是推测）：

- **被清理的是"组装完成的工具调用"。** 真正执行的那份、以及持久化的
  `assistant/message` 里记录的那份，用的都是改写后的块——这决定了调用能否成功。
- **原始增量 delta 不在清理范围内。** 适配器在 `block-end` **之前**就发出
  `tool-call-chunks` 增量，这些原样透传，所以会话日志的 delta 记录里仍留有原始键。
  这一点已实测确认：某次探针的模型输出含 `"reasoning_effort":"high"`，它的 delta 记录
  保留了该文本，而同一调用的 `block-end` 出来是干净的。飞行中改写 delta 做不到——一个键
  可能跨越两个 delta 的分片边界。因此**从 delta 重建调用的工具（重放类）仍可能看到该键**。
- **只看得见模型发起的调用。** PTC 模式（`tools` 模式为 `ptc`/`both`）下，`run_code`
  程序里以代码方式调用的工具，其参数在代码里构造、不产生模型 `block-end`，本插件看不到。
  该缺口在 `tools` 模式为 `native`（默认值）时不触发；一旦部署选了 `ptc`/`both` 就会生效。
- **升级类参数有真实语义。** `sandbox_permissions`／`justification` 在 bash／fs／pwsh／
  run_code 上是合法的可选参数，并非纯噪声。本插件之所以无条件删除，是因为常见的故障形态是
  模型出于习惯带上它们、结果因"并非严格更宽"被拒。但在**真正受限**的会话里，这也会一并
  丢掉一次合法、刻意的提权请求：工具随后按原策略执行，可能直接被拒。若某个受限部署需要
  模型主动提权，就不要原样安装本插件。

**安装：**

```sh
dsh plugin --profile <你的profile名> add dsh-strip-sandbox-permissions
```

**插件改动必须重启 DSH 进程才生效。** 长期运行的 `dsh web` 用的是启动时加载的插件代码，
运行期间安装或升级都不会自动生效，必须重启。拿不准某个改动是否已经在跑，就比一下进程
启动时间和插件安装时间。

## License

MIT
