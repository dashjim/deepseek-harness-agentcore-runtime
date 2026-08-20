# 实现与 GPT 设计文档的偏差汇总

**基准：** `codex-doc/deepseek-harness-agentcore-runtime/docs/design-deepseek-harness-agentcore-runtime.md`（原文只读、未改动）。
本文件汇总"实际落地"与设计文档的差异；分**架构取舍**和**设计未覆盖的落地事实**两类。

## A. 架构取舍（有意偏离，需知情）

| # | 方面 | 设计文档 | 实际实现 | 理由 |
|---|---|---|---|---|
| A1 | 事件传输 | §4.3：prompt 走 HTTP 只回 receipt，模型/工具事件走 `/ws` **流式** | adapter 用**阻塞 `/invocations`** 一次性返回最终结果；BFF 再合成 mux 事件 | MVP 已验证阻塞足够；流式 `/ws` 是明确的后续增量（见下 C 项）。**这是与设计异步事件模型的实质差异** |
| A2 | Web BFF 形态 | §6：运行 DSH 的 "Web-only Cordis profile"，裁剪禁用 agent-plane rows | **独立最小 BFF**（Node+ws）：反代 dsh web 静态 + 自接管 `/api`/两条 WS 转发到 adapter | 更简、更快、对 DSH 版本变化更鲁棒；不做脆弱的 plugin roster 手术 |
| A3 | 浏览器↔Runtime 连接 | build-agent 推荐"浏览器直连 Runtime(JWT)" | **保留 BFF 中间层** | DSH 浏览器协议 ≠ AgentCore 契约，必须 BFF 翻译。build-agent 的"直连"假设前端说 AgentCore 契约，不适用 DSH。安全要求仍全套采用 |

## B. 设计未覆盖 / 说得不够的落地事实（我们补充）

| # | 方面 | 落地事实 |
|---|---|---|
| B1 | DSH runtime 打包 | 预编译二进制**不随仓库分发**，零配置 `DeepSeekHarness()` 会 FileNotFoundError。本地用 **source-launch**（`launch_args_override` → jsonrpc-demo bin）。云镜像需**烘焙已构建 runtime**（`scripts/build-exe-for-python-sdk.ts`，@yao-pkg/pkg 6.21.0 + node24）——设计 §17 只有两行，远不够 |
| B2 | 模型 provider | 默认 cordis 用 DeepSeek provider；需显式 custom cordis 选 `dsh-llm-pi-ai` 的 `amazon-bedrock` 路由。pi-ai **不探测 IMDS**，EC2 实例角色下需 boto3 冻结凭证注入子进程 env；模型比 pi-ai bundled catalog 新，需给 `baseURL`；initialize 有启动竞态需重试 |
| B3 | DSH web boot 契约 | 设计未枚举。冷启动必答：`host.describe`（gate）/`workspace.list`（ISO 时间）/`session.list`；`session.models` 需 `routable:true`；`settings.describe` 需预确认 onboarding notice；`surfaceOp` 是事件顶层字段 |
| B4 | AgentCore 运行时硬限制 | 需对齐：`/ping` 秒回且不启动 SDK（已做 lazy-init）、容器寿命/空闲回收、初始化 ~120s 超时、WS 32KB 帧、`update-agent-runtime` 全量替换 env、换镜像需 stop-session |

## C. 尚未实现（按计划，Phase 2 / 延后）

- **Phase 2（进行中）**：真云部署 Runtime、Cognito 身份/权限（见 auth-design.md）、DynamoDB Session Directory（防 IDOR）、最小权限 IAM/VPC、部署 Web BFF、浏览器云端 e2e。
- **延后（非阻塞）**：流式 `/ws`（把 DSH `session.event`/`assistant/chunk` 逐条外推做逐 token 渲染）、全局 AgentCore Memory、托管 Web Search、完整协议（turn-cancel/approval/user-question/subagent 控制）、`dynamicCordisRunner` 工具巡检面板桩。

## 与设计文档"无侵入"原则的一致性

设计 §1「不改 DSH 核心」被严格遵守：**DSH 上游仓库 git status 全程 clean、HEAD 未移动**。所有适配都在外围（Python adapter、custom cordis、source-launch、独立 BFF），无 DSH upstream 改动。
