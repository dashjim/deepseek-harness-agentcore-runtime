# 本地 Web 全链路证据（分离架构，真浏览器点亮）

**日期：** 2026-08-19 · **Region：** us-west-2 · **模型：** `us.openai.gpt-5.6-sol`

本文件记录"把 DSH Web UI 通过本地 BFF 连到 AgentCore Runtime adapter"的本地验证——这是 Phase 2「部署 web」的前置。

## 分离架构（本地已跑通）

```
浏览器(headless chromium) 
  → web-bff (托管/反代 DSH Web UI + 接管 /api/* 与两条下行 WS)
  → adapter POST /invocations (AgentCore 契约)
  → DSH Python SDK (source-launch)
  → Amazon Bedrock (us.openai.gpt-5.6-sol)
```

Agent 只在 adapter 侧跑；BFF 不跑 agent，只做协议桥接（对齐设计文档 §1 目标 2、§6）。

## 两级验证

### 1) 无头链路 smoke（`web-bff/smoke.mjs`）
浏览器形状的 `session.prompt` → BFF → adapter → Bedrock → assistant 回复 `"pong"` 从 mux WS 推回。每种下行帧用 DSH 仓库真实 zod schema（`muxFrameSchema`/`hostFrameSchema`/`serverRequestSchema`）解析通过。`SMOKE_EXIT=0`。

### 2) 真浏览器端到端（`web-bff/browser_smoke.mjs`）
本机缓存 chromium 1228 + playwright-core 加载真实 DSH Web UI，输入 prompt，回复渲染在会话面。
- 断言通过：`BROWSER SMOKE PASS: assistant reply rendered AND contains the echoed marker "hello-from-dsh-web".`
- 助手 DOM 文本：`hello-from-dsh-web`（真实 bash 工具输出）；模型选择器 `us.openai.gpt-5.6-sol`；footer `1 turns · 1 steps · LLM 3.5s`。
- 截图：`web-bff/artifacts/{01-empty-session,02-prompt-typed,03-reply}.png`。

## 让真实 DSH UI 连上的关键 boot 契约（源码核实）

冷启动握手：先开两条下行 WS（`/api/events.mux`、`/api/events.host`），并行调 `POST /api/host.describe`——**host.describe 必须 `ok:true` 否则整代连接失败重试**；成功后调 `workspace.list` + `session.list`，两者都成功才认为会话视图 ready。

BFF 补齐的桩（关键坑）：
- `workspace.list` 的 `WorkspaceView.createdAt/updatedAt` **必须是 ISO 字符串**（client 会 `Date.parse`），用数字会导致 `baselinesReady` 永不为真、不自动连接。
- `session.models` 必须返回 `current`（非 `selected`）且 **`routable:true`**，否则输入框显示 "This model is unavailable" 而失效。
- `settings.describe` 必须让 `ui-onboarding` namespace **预确认**（`welcomeNoticeVersion`），否则 "Internal Testing Notice" 模态遮住输入框。
- assistant 文本渲染：mux `session/event` 帧的 **`surfaceOp:"append"` 必须是 `event` 顶层字段（与 `data` 平级）**，`event.data.message.content[].text` 承载文本；先发 `session/subscribed {lastSeq:-1}` 再按连续 `seq` 发事件。

## 残留非致命缺口

- `dynamicCordisRunner`（工具巡检插件）的两个 RPC 桩形状未补全 → 控制台有两条报错、"工具面板"会空；**聊天主链路不受影响**。
- 事件目前非流式：BFF 把 adapter 的最终回复一次性作为一个 `assistant/message` 帧推出（详见 design-deviations.md）。

## 复现方式

```bash
# 1) adapter
DSH_REPO_ROOT=/home/ubuntu/g-repo/dsh/deepseek-harness \
  PYTHONPATH=$DSH_REPO_ROOT/python/sdk/src AWS_REGION=us-west-2 \
  python3 runtime/app.py            # :8080
# 2) DSH web（仅供 UI 静态资源；勿把 DSH_TOOLS_MODE 设为空串）
cd /home/ubuntu/g-repo/dsh/deepseek-harness && pnpm dsh web --port 3080
# 3) BFF + 无头浏览器证明
cd web-bff && node server.mjs        # :3090
TMPDIR=/dev/shm node browser_smoke.mjs
```
