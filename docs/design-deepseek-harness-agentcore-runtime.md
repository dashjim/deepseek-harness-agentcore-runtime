# 设计文档：基于 AgentCore Runtime 的多用户 DeepSeek Harness

**日期：** 2026-08-18  
**部署模型：** AgentCore Runtime 自定义 ARM64 容器  
**Agent 实现：** Python HTTP/WebSocket Adapter + `deepseek-harness-sdk`  
**Web 实现：** 动态 DSH Web Host/BFF  
**记忆实现：** 一个全局 AgentCore Memory 资源，通过 namespace 隔离

**DeepSeek Harness 官方仓库：** https://github.com/deepseek-ai/deepseek-harness

---

## 实现回顾与偏差（实测标注，2026-08-19）

> 本节由实现方在把本设计真正落地、部署上云并端到端验证后回填，记录**实际做法与本设计的差异**及本设计未覆盖的落地事实。原设计正文未改，观察集中于此。完整代码/脚本/证据见开源实现仓库 `deepseek-harness-agentcore-runtime`（另有 `docs/design-deviations.md`、`docs/review-of-design-doc.md`、`docs/PHASE2-runtime-deploy.md`、`docs/auth-design.md`）。

### 落地状态
Phase 1（本地真 Bedrock）与 Phase 2（真云部署：Runtime + 身份/权限 + Web + 浏览器 e2e）**已完成并验证**：真实浏览器经 CloudFront(HTTPS)→Cognito 登录→云端 AgentCore Runtime 执行 bash 工具→回复渲染在 DSH Web 界面；两用户隔离（跨用户 workspace 访问 403）实测通过；安全姿态独立复核（无 0.0.0.0/0、IAM 无通配、Runtime VPC 无 NAT/IGW）。

### A. 有意的架构偏差
| 设计章节 | 设计说法 | 实际实现 | 理由 |
|---|---|---|---|
| §4.3 传输 | prompt 走 HTTP 只回 receipt，模型/工具事件走 `/ws` **流式** | adapter 用**阻塞 `/invocations`** 一次性返回最终结果；BFF 再合成 mux 事件 | MVP 已验证阻塞足够；流式 `/ws` 列为后续增量。**与异步事件模型的实质差异** |
| §6 Web BFF | 跑 DSH 的 "Web-only Cordis profile"，裁剪 agent-plane rows | **独立最小 BFF**（Node+ws）：托管 DSH 静态 UI + 自接管 `/api/*` 与两条 WS，转发到云端 Runtime | 更简、对 DSH 版本更鲁棒，不做脆弱的 plugin roster 手术 |
| 浏览器↔Runtime | （build-agent 通用建议：浏览器直连 Runtime 带 JWT） | **保留 BFF 中间层**，浏览器不直连 Runtime | DSH 浏览器协议 ≠ AgentCore 契约，必须 BFF 翻译；且用 HttpOnly cookie 比浏览器持 JWT 更安全 |

### B. 设计未覆盖 / 说得不够的落地事实
- **§9 DSH runtime 打包**：预编译二进制**不随仓库分发**，零配置 `DeepSeekHarness()` 会失败。实际用 `pnpm deploy` 把 DSH runtime **闭包烘焙进自包含 ARM64 镜像**（云端无挂载）；本地开发用 source 模式。设计 §17 的两行 build 远不够。
- **模型 provider（§9/pi-ai）**：pi-ai 的 Bedrock 认证**不探测 IMDS**，EC2 实例角色/容器角色下需用 boto3 冻结凭证注入子进程 env；且需显式 custom cordis 选 `dsh-llm-pi-ai` 的 `amazon-bedrock` 路由。（长会话 >1h 冻结凭证会过期，需刷新计时器——后续项。）
- **DSH web boot 契约（§5/§6 未枚举）**：冷启动必答 `host.describe`(gate)/`workspace.list`(时间戳须 ISO 字符串)/`session.list`；`session.models` 须 `routable:true`；`settings.describe` 须预确认 onboarding notice；`assistant/message` 事件的 `surfaceOp:"append"` 必须是**顶层字段**（与 `data` 平级）才渲染。
- **AgentCore/网络运行时坑**：`update-agent-runtime` 与 ECS task-def 更新都是**全量替换**（漏传 env/secrets 会被清空）；Runtime name 须匹配 `^[a-zA-Z][a-zA-Z0-9_]{0,47}$`；下行 WebSocket 需**服务端 ~25s ping keepalive**，否则 ALB 60s 空闲超时会断连、客户端反复 "connection lost"；VPC 无 NAT 模式下容器拉 ECR 镜像需放行 **S3 网关前缀列表**出站。
- **§16 session.export**：是 **GET 下载端点**，且 DSH 下载按钮**先 HEAD 探测再 GET**——BFF 两个方法都要处理（只处理 GET 会 404）。

### C. 与本设计一致、已按设计实现
- §7 身份/Session Directory：`actorId=HMAC` 服务端派生、`runtimeSessionId` 服务端生成不暴露、DynamoDB 每请求归属校验（防 IDOR）——已实现并实测隔离。
- §16/§17 安全/网络：CloudFront 唯一公网入口(HTTPS)、ALB 入站仅 CloudFront 前缀列表、Runtime VPC 无 NAT/IGW 仅端点出站、IAM 最小权限（Bedrock invoke 精确到模型 ARN）——已实现并独立复核。
- §1 目标 6「不改 DSH 核心」：**严格遵守**，DSH 上游仓库全程零改动，全部外围适配。

### D. 尚未实现（按设计记录为后续）
流式 `/ws` 逐 token 渲染、§11 全局 AgentCore Memory、托管 Web Search、§4/§8 完整交互协议（turn-cancel/approval/user-question/subagent 控制）、DSH 工具巡检面板（`dynamicCordisRunner` 已返回合法空值消除报错，但面板未接真数据）。

---

## 0. 文档目的、系统背景与术语

### 0.1 本文解决什么问题

本文设计一个多用户云端 Coding Agent 系统：保留 DeepSeek Harness（下文简称 DSH）的
完整 Web 界面和主要交互方式，同时把真正执行模型、工具、Git 和编译任务的 agent 部署到
Amazon Bedrock AgentCore Runtime。

本文是独立可读的设计文档。读者不需要预先了解 DSH、AgentCore，也不需要阅读本项目之前
的讨论。

### 0.2 DSH 是什么

DSH 是 DeepSeek 开源的 agent harness。它不是单一聊天程序，而是一个可组合的 Coding
Agent 运行框架，核心特点是“everything is a plugin”：

- Agent loop 是可组合组件。
- LLM provider 是插件。
- Bash、文件、Web Search、subagent 和 workflow 是工具插件。
- Session 使用 append-only event log。
- Web UI 由多个动态 client plugins 组合。
- Profile 和 Cordis YAML 决定一个 DSH 进程实际加载哪些能力。

DSH 当前仍处于 developer preview，版本升级可能带来协议和配置变化。因此本设计要求固定
DSH commit、Python SDK 版本和 custom runtime artifact。

**源码依据：**

- [DSH 项目 README](/home/ubuntu/g-repo/dsh/deepseek-harness/README.md)
- [DSH 架构说明](/home/ubuntu/g-repo/dsh/deepseek-harness/docs/architecture.md)
- [Cordis 入门](/home/ubuntu/g-repo/dsh/deepseek-harness/docs/cordis-primer.md)
- [DSH Base Bundle](/home/ubuntu/g-repo/dsh/deepseek-harness/packages/bundle/base/cordis.patch.yml)

### 0.3 DSH 的核心组件如何协作

DSH 使用 Cordis 作为组合和生命周期框架。理解以下概念后，才能理解为什么本设计可以把
Web Host、Agent 和工具拆分到不同部署模块。

| DSH 概念 | 含义 | 在本设计中的作用 |
|---|---|---|
| `Context` | 一个 Cordis 运行作用域，保存当前可见 services 和 plugins | 区分 Host plane、Agent plane 和 session scope |
| Service | 插件向 Context 提供的能力，例如 `tools`、`llm`、`sessions` | 模块之间通过 service 协作，而不是直接互相 import |
| `inject` | 插件声明其启动前必须存在的 services | 决定插件激活顺序和依赖是否完整 |
| Plugin | 向 Context 注册 service、tool、event listener 或 UI slot 的代码单元 | 本设计通过 out-of-tree plugins 增加 AgentCore 能力 |
| Profile | 一个可运行的 DSH 组合，例如 `web`、`headless` | Web BFF 和 Runtime 分别使用不同 profile |
| Bundle/Patch | 向 profile 插入、覆盖或禁用 plugin rows 的配置层 | 不修改 upstream 即可替换 transport/provider |
| Host plane | 一个 DSH 进程共享的服务，例如 persistence、workspace、API proxy | 当前 `dsh web` 的服务端能力 |
| Agent plane | 每个 agent/session 可见的工具和 prompt 组合 | Runtime 中实际运行 Coding Agent |
| Tool Registry | 模型可以调用的工具定义和执行管线 | 保留 DSH 的 Bash、文件、Search、subagent 工具 |
| Session | Append-only event log 及其当前 surface | 是历史、恢复和 UI event 的事实源 |
| Client Plugin | 浏览器中动态加载的 UI/transport plugin | 由 BFF 继续提供 |

插件依赖示例：

```text
tool-bash
  injects -> tools, shell, systemPrompt

llm-pi-ai
  injects -> llm

client-connection
  browser side provides -> connection
  host side bridges      -> /api + WebSocket
```

一次普通 DSH turn 的内部链路是：

```text
Browser session.prompt
  -> Host API Proxy
  -> Session inbox
  -> Agent loop
  -> LLM adapter
  -> model emits tool call
  -> Tool Registry dispatch
  -> Bash/File/Web/Subagent provider
  -> tool result appended to Session
  -> next model step
  -> assistant message appended to Session
  -> Browser receives Session events
```

Session event log 同时服务于：

- 模型后续上下文。
- Web UI 实时展示。
- JSONL 持久化。
- crash recovery。
- session history、fork、search 和 subagent lineage。

**源码依据：**

- [Cordis Service 与依赖](/home/ubuntu/g-repo/dsh/deepseek-harness/docs/cordis-tutorial/03-services.md)
- [DSH Agent 生命周期](/home/ubuntu/g-repo/dsh/deepseek-harness/docs/agent-lifecycle.md)
- [DSH Session 子系统](/home/ubuntu/g-repo/dsh/deepseek-harness/docs/subsystems/session.md)
- [DSH Tool Pipeline](/home/ubuntu/g-repo/dsh/deepseek-harness/docs/tool-execution-pipeline.md)
- [DSH Tool Catalog](/home/ubuntu/g-repo/dsh/deepseek-harness/docs/tool-catalog.md)

### 0.4 DSH 当前是如何运行的

执行：

```bash
dsh web
```

会启动一个本地 Node.js Host。默认运行链路是：

```text
Browser
  |
  | GET index/assets/plugins
  | POST /api/*
  | WS /api/events.mux
  | WS /api/events.host
  v
DSH Node Host
  |
  ├─ WebServer
  ├─ Client Module Host
  ├─ API Proxy
  ├─ Agent/Session Registry
  ├─ Tool Registry
  ├─ LLM Adapters
  ├─ Workspace/File Services
  └─ JSONL Session Persistence
```

Browser 并不是一次性下载一个完整 SPA。DSH Host 会：

1. 向 `index.html` 注入 `window.__DSH_BOOT__`。
2. 根据当前 Cordis composition 生成 client plugin 清单。
3. 从 `/plugins/<id>/client.js` 动态提供每个浏览器插件。
4. 通过 HTTP 接收短 RPC。
5. 通过两条 WebSocket 向浏览器推送 session/tool 和 host 事件。

**源码依据：**

- [Web App Bundle](/home/ubuntu/g-repo/dsh/deepseek-harness/packages/bundle/web-app/cordis.patch.yml)
- [Web Boot Kernel](/home/ubuntu/g-repo/dsh/deepseek-harness/packages/client/web/src/boot.tsx)
- [Client Module Host](/home/ubuntu/g-repo/dsh/deepseek-harness/packages/client/modules/src/index.ts)
- [Browser Connection](/home/ubuntu/g-repo/dsh/deepseek-harness/packages/client/connection/src/client/web-api-client.ts)
- [Host Connection](/home/ubuntu/g-repo/dsh/deepseek-harness/packages/client/connection/src/index.ts)
- [DSH RPC Map](/home/ubuntu/g-repo/dsh/deepseek-harness/packages/host/apiproxy/src/api/rpc-map.ts)

### 0.5 DSH Python SDK 是什么

`deepseek-harness-sdk` 不是 DSH Web Host。它是一个 Python client：

```text
Python process
  |
  | newline-delimited JSON-RPC over stdin/stdout
  v
dsh-jsonrpc-agent subprocess
```

Python SDK 负责：

- 启动 DSH runtime 子进程。
- 执行 initialize。
- 向某个 DSH session 提交 prompt。
- 接收 session event、状态和 subagent notification。
- 在进程退出时关闭 runtime。

Stock SDK 不提供完整 DSH Web API，因此无法独立支撑现有 Web UI。本文中的
`deepseek-harness-sdk` 是 Python 控制入口；完整 Web 兼容还需要 custom DSH runtime 和
扩展 JSON-RPC server。

**源码依据：**

- [Python SDK 说明](/home/ubuntu/g-repo/dsh/deepseek-harness/python/sdk/README.md)
- [Python SDK API](/home/ubuntu/g-repo/dsh/deepseek-harness/python/sdk/src/deepseek_harness/api.py)
- [Python SDK Client](/home/ubuntu/g-repo/dsh/deepseek-harness/python/sdk/src/deepseek_harness/client.py)
- [SDK Protocol](/home/ubuntu/g-repo/dsh/deepseek-harness/packages/sdk/protocol/README.md)

### 0.6 AgentCore Runtime 是什么

AgentCore Runtime 是 AWS 面向 agent workload 的托管运行环境。每个
`runtimeSessionId` 对应隔离的运行 session，可在多次 invocation 之间保留内存、子进程和
session 文件状态。自定义 HTTP agent 容器需要监听 `0.0.0.0:8080` 并实现 Runtime service
contract。AgentCore 还支持 `/ws` 双向 WebSocket。

**AWS 官方依据：**

- [AgentCore Runtime HTTP 协议](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html)
- [AgentCore WebSocket 指南](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-websocket.html)
- [AgentCore Runtime Session 隔离](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html)
- [AgentCore 文件系统配置](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html)

### 0.7 为什么需要兼容层

DSH 与 AgentCore 的边界不同：

| 对比项 | DSH 当前实现 | AgentCore Runtime |
|---|---|---|
| Web 静态内容 | DSH Host 动态提供 | Runtime 不提供任意静态路由 |
| 短 RPC | `POST /api/<method>` | `POST /invocations` |
| 实时事件 | 两条下行 WebSocket | 一条双向 `/ws` |
| Agent 进程 | DSH Node Host 内部 | 隔离 Runtime session |
| Python SDK | stdio JSON-RPC client | AgentCore 不理解该协议 |
| 用户身份 | 本地单用户假设 | 应用自行实现多用户所有权 |

所以系统必须增加：

1. Web BFF：保留 DSH browser contract。
2. AgentCore Python Adapter：实现 `/ping`、`/invocations`、`/ws`。
3. Custom DSH Runtime：补齐 stock SDK 缺失的 Web API。

### 0.8 术语表

| 术语 | 含义 |
|---|---|
| DSH | DeepSeek Harness |
| DSH Host | 当前 `dsh web` 启动的 Node.js 宿主 |
| DSH Client Plugin | 浏览器中动态加载的 Cordis plugin |
| BFF | Backend for Frontend，本设计中的动态 Web 兼容层 |
| Runtime | Amazon Bedrock AgentCore Runtime |
| Runtime Adapter | Runtime 容器中的 Python HTTP/WebSocket 服务 |
| DSH Runtime | Python SDK 启动的 `dsh-jsonrpc-agent` 子进程 |
| `runtimeSessionId` | AgentCore microVM/session 身份 |
| `dshSessionId` | DSH 内部对话和事件日志身份 |
| mux events | DSH session、message、tool、subagent 等事件 |
| host events | DSH host 级别事件 |
| 全局 Memory | 全系统唯一的 AgentCore Memory 资源 |

---

## 1. 总体设计目标

本系统不是把 `dsh web` 原样搬到云端，而是要同时满足以下目标。

### 目标 1：保留完整 DSH Web 体验

- 保留 DSH Web shell、动态 client plugins、session sidebar、workspace、tool cards、
  subagent 展示、model selector 和主要交互布局。
- 浏览器侧尽量继续使用 DSH 当前协议，不重写全部 React 组件。
- 本地桌面语义必须改成云端语义，例如目录选择变成远程 workspace browser。

### 目标 2：Agent 必须运行在 AgentCore Runtime

- DSH agent loop、工具执行、Git、编译器、PTY 和工作区在 AgentCore Runtime 中运行。
- 使用 Linux ARM64 自定义容器。
- 使用 Python Adapter 管理 `deepseek-harness-sdk` 和 DSH runtime 子进程。
- ECS 只运行 Web/BFF，不运行 agent。

### 目标 3：支持多用户和多租户

- Cognito 用户必须彼此隔离。
- 一个用户可以拥有多个 workspace。
- 一个 workspace 可以拥有多个 DSH session。
- 一个 workspace 对应一个稳定的 AgentCore `runtimeSessionId`。
- 生产模式支持每租户独立 Runtime、IAM role 和 EFS access point。

### 目标 4：支持完整 Coding Agent 环境

- 支持 Git、Bash、Python、Node.js、pnpm 和常用编译工具。
- 支持文件读写、搜索、测试、构建、后台任务和 subagent。
- 工作区在 Runtime 重启后仍可恢复。
- 交付文件可通过浏览器预览或下载。

### 目标 5：使用 AWS 托管能力

- Amazon Bedrock GPT 作为模型。
- 一个全局 AgentCore Memory 资源提供共享知识和私有记忆。
- AgentCore Gateway Web Search 提供联网搜索。
- AgentCore Observability、CloudWatch Logs 和 X-Ray 提供可观测性。

### 目标 6：尽量不修改 DSH 核心

- 不修改 DSH agent loop、tool registry、session event 格式和主要 UI 组件。
- 通过 out-of-tree Cordis plugins、custom SDK runtime、Web BFF 和 Python Adapter 适配。
- 对 DSH upstream 的修改应限制在可独立维护的扩展包中。

### 目标 7：明确“无侵入”的真实边界

本文中的“尽量无侵入”不是“零代码、零构建变化”，而是：

| 变更级别 | 是否允许 | 说明 |
|---|---|---|
| 修改 DSH agent loop | 不允许 | 继续复用 upstream agent 行为 |
| 修改 SessionEvent 格式 | 不允许 | 保持日志、回放和 UI 兼容 |
| 修改现有 tool schema | 原则上不允许 | AgentCore provider 应实现现有 seam |
| 新增 out-of-tree Cordis plugin | 允许 | Memory、Web Search、cloud artifact 等 |
| 替换 SDK JSON-RPC server plugin | 允许 | 通过公开 DSH services 扩展 Web API |
| 构建 custom runtime closure | 允许 | 将扩展插件编译进 ARM64 runtime |
| 修改 Python SDK upstream package | 不作为首选 | 优先使用 wrapper/subclass；公共接口不足时才提 upstream PR |
| Fork DSH core | 风险升级项 | 只有公开 seam 无法实现需求时才能进入 |

因此本文最终目标是“核心行为不改，部署边界和协议层扩展”，而不是声称完全无修改。

---

## 2. 总体系统挑战

### 挑战 1：DSH 与 AgentCore 的网络协议不一致

DSH Web 当前使用：

```text
HTTP:
  POST /api/<method>
  POST /api/respond

WebSocket:
  /api/events.mux
  /api/events.host
```

AgentCore Runtime 对容器要求：

```text
HTTP:
  GET  /ping
  POST /invocations

WebSocket:
  /ws
```

二者不能通过“修改一个 backend URL”直接兼容。

**引用：**

- [DSH API Path 定义](/home/ubuntu/g-repo/dsh/deepseek-harness/packages/client/connection/src/api-path.ts)
- [DSH WebSocket 下行实现](/home/ubuntu/g-repo/dsh/deepseek-harness/packages/client/connection/src/client/web-api-client.ts)
- [AgentCore HTTP 协议](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html)
- [AgentCore WebSocket 协议](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-websocket.html)

### 挑战 2：DSH Web UI 不是普通静态 SPA

DSH Web 启动依赖：

```text
window.__DSH_BOOT__
/plugins/<package>/client.js
```

这些内容由 DSH Host 动态生成。只上传 `apps/web/dist` 到 S3 无法启动完整 UI。

### 挑战 3：Stock Python SDK 能力远少于完整 DSH Web API

当前 SDK JSON-RPC 仅直接支持：

```text
initialize
session/prompt
shutdown

notifications:
  session.event
  session.status
  subagent.started
  subagent.finished
```

完整 DSH Web API 还需要：

```text
session list/history/search/fork/cancel
workspace CRUD
file browser
subagent prompt/interrupt
settings/credentials
model catalog
approval/user questions
goals
agent presets
```

因此“完整 DSH UI + stock Python SDK”本身存在功能缺口。

**引用：**

- [SDK Wire Methods](/home/ubuntu/g-repo/dsh/deepseek-harness/packages/sdk/protocol/README.md)
- [完整 DSH RpcMethodMap](/home/ubuntu/g-repo/dsh/deepseek-harness/packages/host/apiproxy/src/api/rpc-map.ts)

### 挑战 4：DSH 与 AgentCore 有两套 Session

```text
AgentCore runtimeSessionId
  = microVM、CPU、内存、文件系统和路由隔离

DSH dshSessionId
  = 一次对话、事件日志、agent、subagent 和历史
```

如果把二者混成同一个 ID，无法支持一个 workspace 下的多个 DSH 对话。

### 挑战 5：多用户身份与 Runtime session 所有权

AgentCore 隔离 `runtimeSessionId`，但不会替应用判断这个 ID 属于哪个 Cognito 用户。

系统必须防止：

- 用户伪造其他人的 workspace ID。
- 用户提交其他人的 `runtimeSessionId`。
- 用户读取其他人的 DSH session、文件、Memory 和 artifact。

### 挑战 6：文件系统的生命周期和租户隔离

- Runtime 本地磁盘不是永久项目存储。
- Managed session storage 容量有限，且不应作为长期事实源。
- EFS/S3 Files 是共享挂载，必须增加租户边界。
- DSH shell 可以执行任意路径命令，不能只依赖 UI 层隐藏路径。

### 挑战 7：Python SDK 是同步子进程客户端

- `deepseek-harness-sdk` 会启动一个 DSH runtime 子进程。
- `Session.run()` 是阻塞操作。
- FastAPI、WebSocket 和多个用户请求是异步的。
- 同一 SDK process 的并发、重启和 notification routing 必须明确设计。

### 挑战 8：完整 UI 的交互能力尚未进入 SDK 协议

当前 SDK server 不发送 server-to-client request，因此以下能力不能直接工作：

- `ask_user_question`
- tool approval
- plan approval
- turn-scoped cancel

完整兼容必须扩展 DSH SDK JSON-RPC server。

### 挑战 9：一个全局 Memory 既要共享又要隔离

一个 Memory 资源必须同时承载：

- 所有用户可读的审核后知识。
- 租户内部知识。
- 用户私有偏好。
- workspace 私有事实。

不能因为资源是全局的，就让所有 namespace 都全局可见。

---

## 3. 总体模块划分

```text
┌──────────────────────────────────────────────────────────────────────┐
│ 1. DSH 浏览器客户端                                                  │
│    Web shell + client plugins + existing DSH wire protocol           │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                               │ DSH HTTP + 两条 DSH WebSocket
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 2. 动态 Web Host / BFF                                               │
│    Cognito、多用户授权、DSH UI hosting、协议转换、Runtime session 映射 │
└──────────────┬───────────────────────┬───────────────────────────────┘
               │                       │
               │ DynamoDB              │ AgentCore HTTP + 单 WebSocket
               ▼                       ▼
┌──────────────────────┐    ┌──────────────────────────────────────────┐
│ 3. Session Directory │    │ 4. AgentCore Runtime Python Adapter      │
│ user/workspace owner │    │ /ping + /invocations + /ws               │
└──────────────────────┘    └─────────────────────┬────────────────────┘
                                                  │ JSON-RPC over stdio
                                                  ▼
                              ┌──────────────────────────────────────────┐
                              │ 5. Custom DSH SDK Runtime                │
                              │ agent loop + tools + session + plugins   │
                              └──────┬──────────┬───────────┬────────────┘
                                     │          │           │
                              ┌──────▼───┐ ┌────▼────┐ ┌────▼──────────┐
                              │6. Storage│ │7. Global│ │8. Model/Search│
                              │EFS/S3    │ │ Memory  │ │Bedrock/Gateway│
                              └──────────┘ └─────────┘ └───────────────┘
```

### 模块列表

| 编号 | 模块 | 核心职责 |
|---|---|---|
| M1 | DSH 浏览器客户端 | 保留完整 UI 和现有浏览器协议 |
| M2 | 动态 Web Host/BFF | 认证、授权、动态插件、协议桥接 |
| M3 | Session Directory | 多用户 workspace 与 Runtime session 映射 |
| M4 | AgentCore Runtime Python Adapter | AgentCore contract、SDK 生命周期和流式桥接 |
| M5 | Custom DSH SDK Runtime | DSH agent loop、工具和扩展 JSON-RPC |
| M6 | Workspace/Artifact Storage | Git workspace、session log 和交付文件 |
| M7 | 全局 AgentCore Memory | 全局知识、用户记忆和 workspace 记忆 |
| M8 | Bedrock Model | GPT 模型推理 |
| M9 | AgentCore Web Search | 托管联网搜索 |
| M10 | Observability/Admin | 日志、追踪、配额和管理 |

---

## 4. 传输通道设计

## 4.1 最终结论

本系统同时使用 HTTP、WebSocket 和 stdio，三者用途不同。

```text
浏览器 <-> BFF:
  HTTP + 两条 WebSocket

BFF <-> AgentCore Runtime:
  HTTP /invocations + 一条 WebSocket /ws

Python Adapter <-> DSH Runtime:
  JSON-RPC over stdio
```

不选择“全部 HTTP”，因为 DSH UI 需要实时 event stream。

不选择“全部 WebSocket”，因为 DSH 的大量 API 本质是短请求/短响应，HTTP 更简单、更容易
重试和实现幂等。

**设计依据：**

- DSH 本身已经采用“HTTP 上行 + WebSocket 下行”的分工。
- AgentCore 同时提供 `/invocations` 和 `/ws`，可以保持相同的职责分离。
- HTTP 用于有明确完成边界的 RPC，WebSocket 用于持续事件。

### 4.2 第一段：浏览器到 BFF

保持 DSH 当前协议不变。

| DSH 浏览器请求 | 传输 |
|---|---|
| `POST /api/session.list` | HTTP |
| `POST /api/session.create` | HTTP |
| `POST /api/session.prompt` | HTTP |
| `POST /api/session.history` | HTTP |
| `POST /api/workspace.*` | HTTP |
| `POST /api/respond` | HTTP |
| `/api/events.mux` | WebSocket，只下行 |
| `/api/events.host` | WebSocket，只下行 |
| `/plugins/*` | HTTP |
| Web assets | HTTP |

这样做的原因：

- 不修改现有 `WebApiClient`。
- 不修改 DSH `ConnectionController`。
- 不修改大多数 UI plugins。
- BFF 可以继续满足 DSH 的 same-origin 假设。

### 4.3 第二段：BFF 到 AgentCore Runtime

使用 AgentCore 原生通道。

| AgentCore 通道 | 用途 |
|---|---|
| `POST /invocations` | DSH unary RPC、prompt enqueue、history、workspace、respond、cancel |
| `/ws` | DSH mux/host 实时事件、状态、重连和 resync |
| `GET /ping` | Runtime 健康检查，仅 AgentCore 调用 |

#### HTTP 调用方式

BFF 使用 ECS task role 对以下请求做 SigV4 签名：

```text
POST https://bedrock-agentcore.<region>.amazonaws.com/
     runtimes/<url-encoded-agentRuntimeArn>/invocations?qualifier=DEFAULT

Headers:
  Content-Type: application/json
  Accept: application/json
  X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: <runtimeSessionId>
```

BFF role 需要：

```text
bedrock-agentcore:InvokeAgentRuntime
```

HTTP 409 `RetryableConflictException` 使用短指数退避，并保持同一 `idempotencyKey`。

#### WebSocket 调用方式

BFF 作为 Node.js 服务端，可以设置 WebSocket handshake headers，因此使用 SigV4 headers，
不使用浏览器 OAuth subprotocol，也不把 presigned URL 发给浏览器。

连接地址：

```text
wss://bedrock-agentcore.<region>.amazonaws.com/
    runtimes/<url-encoded-agentRuntimeArn>/ws
```

`agentRuntimeArn` 必须进行 URL percent-encoding，至少编码 `:` 和 `/`。

必须在 SigV4 handshake 中传入与 HTTP invocation 相同的：

```text
X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: <runtimeSessionId>
```

BFF role 还需要：

```text
bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream
```

WebSocket 建立失败处理：

| HTTP 状态 | 处理 |
|---|---|
| 400 | 请求或 session ID 非法，不重试 |
| 401/403 | 认证或权限错误，不重试并告警 |
| 409 RetryableConflict | 100ms 起始的短指数退避 |
| 424 | Runtime container 错误，查询 Runtime logs |
| 429 | 遵守 backoff 和 Retry-After |
| 500 | 有界重试 |

连接建立后的 close code：

| Close code | 处理 |
|---|---|
| 1000 | 正常关闭 |
| 1001 | 重新建立连接并 resync |
| 1008 | 策略或配额错误，停止重试 |
| 1009 | 消息过大，检查分片实现 |
| 1011 | Runtime 错误，有界重试并告警 |

**AWS 官方依据：**

- [AgentCore WebSocket 地址、SigV4 与 session_id](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-websocket.html)
- [InvokeAgentRuntime Headers](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeAgentRuntime.html)

关键决策：

- `session.prompt` 通过 HTTP `/invocations` 提交。
- `/invocations` 只返回 prompt 已入队的 receipt，例如 `messageId`。
- 模型回复、tool calls 和 subagent events 不从该 HTTP response 返回。
- 所有持续事件从 AgentCore `/ws` 返回。

这与 DSH 当前语义一致：

```text
DSH:
  HTTP 提交 prompt
  WebSocket 持续收事件

AgentCore mapping:
  /invocations 提交 prompt
  /ws 持续收事件
```

### 4.4 第三段：Python Adapter 到 DSH Runtime

继续使用 DSH SDK 的 newline-delimited JSON-RPC over stdio。

```text
Python HarnessClient
  -> stdin:  JSON-RPC requests
  <- stdout: JSON-RPC responses + notifications
  <- stderr: diagnostics
```

当前请求：

```text
initialize
session/prompt
shutdown
```

当前通知：

```text
session.event
session.status
subagent.started
subagent.finished
```

完整 UI 需要 custom `sdk-web-bridge` 扩展更多 JSON-RPC methods。

### 4.5 DSH 与 AgentCore 的逐项协议匹配

| DSH 侧 | AgentCore 侧 | BFF/Adapter 匹配方式 |
|---|---|---|
| `POST /api/<method>` | `POST /invocations` | BFF 将 method、rpcId、payload 包进 versioned envelope |
| `POST /api/session.prompt` | `POST /invocations` | Adapter 调用 SDK `session_prompt`，快速返回 receipt |
| `POST /api/respond` | `POST /invocations` | 映射为 `interaction.respond`，完整阶段由扩展协议处理 |
| `/api/events.mux` | `/ws` | BFF 从同一上游 WS 过滤 `channel=mux` |
| `/api/events.host` | `/ws` | BFF 从同一上游 WS 过滤 `channel=host` |
| 两条下行 WS | 一条双向 WS | 上游消息增加 `channel` 字段进行复用 |
| DSH rpcId | AgentCore request body | 原值透传，用于响应关联 |
| DSH sessionId | Adapter payload | 作为 `dshSessionId`，不能代替 `runtimeSessionId` |
| DSH Web reconnect | AgentCore WS reconnect | BFF 使用 sequence checkpoint 执行 resync |
| DSH attachment/download | 100 MB payload 或 S3 | 大文件走 S3 presigned，Runtime 只收 object reference |
| DSH boot/plugins | AgentCore 不托管任意静态路由 | 全部由 Web BFF 提供 |

### 4.6 BFF 到 Runtime 的 HTTP Envelope

```json
{
  "protocolVersion": "1.0",
  "requestId": "f2be...",
  "operation": "session.prompt",
  "actor": {
    "tenantHash": "t_xxx",
    "userHash": "u_xxx"
  },
  "workspaceId": "ws_xxx",
  "dshSessionId": "conv_xxx",
  "idempotencyKey": "idem_xxx",
  "payload": {}
}
```

### 4.7 AgentCore WebSocket Envelope

```json
{
  "protocolVersion": "1.0",
  "channel": "mux",
  "requestId": "f2be...",
  "sequence": 125,
  "fragment": {
    "index": 0,
    "count": 1
  },
  "payload": {}
}
```

支持的 channel：

```text
mux      DSH session/tool/subagent events
host     DSH host/global events
rpc      可选的双向 RPC
control  ready/ping/resync/error
```

单 frame 按 32 KB 进行安全分片。

### 4.8 连接建立顺序

```text
1. Browser 打开 /api/events.mux
2. Browser 打开 /api/events.host
3. BFF 根据用户 workspace 找到 runtimeSessionId
4. BFF 打开或复用 AgentCore /ws
5. Runtime Adapter 返回 control.ready
6. BFF 标记两条浏览器 WebSocket ready
7. Browser 调用 host.describe
8. Browser connection generation 进入 connected
9. Browser 才允许发送 session.prompt
```

这可以避免 prompt 先执行、事件订阅后建立导致的事件丢失。

---

## 5. 模块 M1：DSH 浏览器客户端

### DSH 当前状态

- 动态读取 `window.__DSH_BOOT__`。
- 从 `/plugins/<id>/client.js` 加载 plugins。
- unary 操作使用 `/api/*` HTTP。
- 实时事件使用两个下行 WebSocket。
- 假设 API 与页面同源。

### 挑战

- 不能直接放到 S3 后修改一个 Runtime URL。
- 不能直接理解 AgentCore EventStream。
- 不会管理 Cognito 与 `runtimeSessionId`。
- 本地目录选择和文件打开不适用于云端。

### 设计方案

- 浏览器协议保持不变。
- 增加登录 shell，但不修改 DSH 业务 UI。
- 本地功能由 BFF 返回 cloud capability descriptor。
- 无效的本地按钮隐藏或改为远程 workspace 操作。

### 本模块使用的传输

```text
HTTP + 两条 DSH WebSocket
```

---

## 6. 模块 M2：动态 Web Host/BFF

### 主要职责

1. 托管 DSH Web shell、boot manifest 和 client plugins。
2. 处理 Cognito 登录。
3. 校验用户、租户、workspace 和 DSH session ownership。
4. 保留 DSH `/api/*` 与两条 WebSocket。
5. 将请求转换为 AgentCore `/invocations` 和 `/ws`。
6. 维护浏览器连接与 AgentCore 上游连接之间的映射。

### Web-only Cordis Profile

BFF 不能直接运行完整 `dsh web` profile，否则会在 ECS 中重复启动本地 agent、LLM、tool 和
persistence。BFF 使用一个 Web-only profile，只保留浏览器启动所需的 Host rows。

#### 保留的 Host rows

```text
timer
loader
web-startup
webserver
cloud-web-runtime
frontend-static
client-modules
cloud-client-connection
client-hmr (production disabled)
```

#### 保留的浏览器 plugin rows

```text
api-remotes
client-runtime
cordis-client-runner
ui-theme
locale
ui-layout
ui-sidebar
ui-settings
ui-conversation
ui-tool
ui-workspace
ui-input-trigger
ui-commands
ui-skill
ui-subagent
ui-jobs
ui-goal
ui-model-selection
ui-plan
ui-user-questions
ui-trajectory
```

#### BFF 中禁止启动的 Agent rows

```text
agent-loop
llm adapters
tool executors
session persistence
workspace registry
local credentials
local settings writer
subagent providers
```

这些能力全部位于 AgentCore Runtime。

#### 需要 BFF 提供的 cloud stubs

部分浏览器 plugins 在激活时需要对应 client services。BFF 必须提供：

```text
connection
remote namespaces
host.describe capability descriptor
approved model catalog
approved preset roster
auth/session state
```

BFF 不在本地执行这些业务方法，而是通过 AgentCore transport 转发。

#### Profile 验证

CI 必须启动 Web-only profile 并验证：

1. `window.__DSH_BOOT__` 能生成。
2. 所有 client plugin fiber 都进入 ACTIVE。
3. 没有本地 `agent-loop`、LLM、Bash 或 persistence service。
4. 所有 `/api/*` 请求都到达 cloud connection plugin。
5. 缺少远端 Runtime 时 UI 显示 disconnected，而不是 boot failure。

**Profile 来源：**

- 以 [DSH Web App Bundle](/home/ubuntu/g-repo/dsh/deepseek-harness/packages/bundle/web-app/cordis.patch.yml)
  的 browser roster 为基础。
- 用 `cloud-client-connection` 替换原 Host connection。
- 禁用该 bundle 中所有 agent-plane 和本地宿主能力。

### 核心挑战

#### 挑战 A：BFF 必须是无状态的

ECS task 会扩缩容和重启，不能在单个 task 内保存 workspace ownership。

**方案：**

- DynamoDB 保存用户/workspace/Runtime 映射。
- BFF 内存只保存当前 WebSocket connection。
- 重连后从 DynamoDB 重新定位 Runtime session。

#### 挑战 B：两条下游 WS 对应一条上游 WS

**方案：**

```text
一个 workspace:
  1 个 AgentCore upstream WS
  N 个浏览器连接
    - 1 条 mux WS
    - 1 条 host WS
```

BFF 根据 `channel` 字段拆分事件。

#### 挑战 C：认证状态不能依赖 localStorage 初始化

**方案：**

- Cognito Authorization Code + PKCE。
- BFF 使用 Secure、HttpOnly cookie。
- DSH 页面只有认证成功后才加载。
- 浏览器插件不持有 JWT。

#### 挑战 D：长连接扩缩容

**方案：**

- ALB 支持 WebSocket。
- BFF task 设置 connection draining。
- CloudFront 与 ALB timeout 大于 heartbeat interval。
- WebSocket 断开后客户端按 DSH generation 机制重连。

### 本模块使用的传输

```text
Browser side: DSH HTTP + DSH WebSocket
Runtime side: AgentCore HTTP + AgentCore WebSocket
```

---

## 7. 模块 M3：身份与 Session Directory

### 标识层级

```text
tenantId
  -> userId
    -> workspaceId
      -> runtimeSessionId
        -> dshSessionId[]
```

### 关键原则

- `runtimeSessionId` 由服务端生成。
- 浏览器永远看不到 `runtimeSessionId`。
- 一个 workspace 对应一个 `runtimeSessionId`。
- 一个 workspace 内可以有多个 `dshSessionId`。
- 所有请求从认证用户和 public workspace ID 开始查 owner。

### DynamoDB 数据模型

```text
PK = TENANT#{tenantHash}#USER#{userHash}
SK = WORKSPACE#{workspaceId}

runtimeArn
runtimeSessionId
state
createdAt
lastActivityAt
idleExpiresAt
efsWorkspacePath
optimisticVersion
activePromptCount
```

### 核心挑战

#### IDOR

客户端可能猜测 workspace/session ID。

**方案：**

- 每个 RPC 都先执行 owner lookup。
- 不允许用 `runtimeSessionId` 直接查 workspace。
- artifact、Memory、WebSocket 都重复执行 ownership 校验。

#### 多标签页并发

同一 workspace 可能同时提交多个 prompt。

**方案：**

- 首个版本限制一个 workspace 同时一个 active prompt。
- DynamoDB conditional update 维护 `activePromptCount`。
- 不同 DSH session 的并行在完成 SDK 并发验证后再开放。

---

## 8. 模块 M4：AgentCore Runtime Python Adapter

### AgentCore 侧要求

```text
listen: 0.0.0.0:8080
GET  /ping
POST /invocations
WS   /ws
```

### Adapter 职责

- 验证 BFF envelope。
- 把 workspace 绑定到当前 Runtime session。
- 懒加载 DSH SDK runtime。
- 调用 SDK 或扩展 JSON-RPC。
- 将 DSH notifications 转成 mux/host channel。
- 管理 SDK 子进程重启和日志恢复。
- 调用 AgentCore Memory、Gateway 和 S3。

### 核心挑战

#### 挑战 A：SDK 是同步的

**方案：**

- FastAPI 保持单 worker。
- SDK 使用 dedicated thread。
- async route 通过 queue 与 worker 通信。
- boto3 blocking I/O 使用 `asyncio.to_thread()`。

#### 挑战 B：一个 microVM 只能有一个 SDK owner

**方案：**

- 每个 Runtime session 一个 `HarnessRuntimeManager` singleton。
- 不在 request handler 中创建 `DeepSeekHarness()`。
- `/ping` 不触发 SDK 启动。

#### 挑战 C：SDK process 崩溃

**方案：**

1. 标记当前 turn interrupted。
2. 关闭旧 process。
3. 从 JSONL session root 启动新 process。
4. 重新建立 notification subscription。
5. BFF 从 sequence checkpoint resync。

### Python 结构

```text
FastAPI event loop
  -> request queue
  -> SDK worker thread
  -> HarnessClient
  -> DSH runtime subprocess
```

---

## 9. 模块 M5：Custom DSH SDK Runtime

### 为什么不能只使用 stock runtime

Stock SDK server 不能满足完整 DSH UI：

| 功能 | Stock SDK |
|---|---|
| prompt | 支持 |
| event stream | 支持 |
| subagent start/finish | 支持 |
| session list/history | 不支持 |
| cancel | 不支持 |
| workspace | 不支持 |
| approval/user question | 不支持 |
| settings/credentials | 不支持 |

### 设计方案

保留 `deepseek-harness-sdk` Python API，但将 `runtime_bin` 指向自定义 ARM64 executable。

```text
deepseek-harness-sdk
  -> runtime_bin=/opt/dsh/dsh-agentcore-runtime
```

Custom runtime closure 增加：

```text
sdk-web-bridge
web-search-agentcore
memory-context
cloud-artifacts
cloud-workspace-policy
```

### sdk-web-bridge 扩展方法

```text
session/list
session/history
session/search
session/fork
session/cancel
subagent/list
subagent/prompt
subagent/interrupt
workspace/*
interaction/respond
```

### 扩展协议版本

Custom runtime 不直接冒充 stock SDK protocol。初始化时必须协商 bridge 版本：

```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "method": "initialize",
  "params": {
    "cwd": "/mnt/projects/...",
    "provider": "amazon-bedrock",
    "model": "us.openai.gpt-5.6-sol",
    "bridgeProtocolVersion": "1.0",
    "requestedCapabilities": [
      "session-management",
      "turn-cancel",
      "interactive-requests"
    ]
  }
}
```

响应：

```json
{
  "serverInfo": {
    "name": "dsh-agentcore-sdk-runtime",
    "dshVersion": "pinned-commit",
    "bridgeProtocolVersion": "1.0"
  },
  "capabilities": {
    "sessionManagement": true,
    "turnCancel": true,
    "interactiveRequests": true
  }
}
```

BFF 根据 capabilities 决定显示哪些 UI controls，不能仅根据部署版本猜测。

### 主要扩展方法契约

| Direction | Method | Params | Result |
|---|---|---|---|
| client→server | `session/list` | workspace scope, cursor | session headers/page |
| client→server | `session/history` | sessionId, cursor | folded events/page |
| client→server | `session/fork` | sourceId, cut | new sessionId |
| client→server | `session/cancel` | sessionId, turnId | cancel receipt |
| client→server | `subagent/list` | root sessionId | descendant descriptors |
| client→server | `subagent/prompt` | childId, content | message receipt |
| client→server | `subagent/interrupt` | childId | interrupt receipt |
| server→client | `interaction/request` | requestId, kind, schema, options | BFF/UI response required |
| client→server | `interaction/respond` | requestId, result | response receipt |

所有方法必须：

- 使用 JSON Schema/Pydantic 做严格输入验证。
- 返回稳定错误 code，不把 stack trace 发送给浏览器。
- 绑定 workspace、actor 和 session ownership。
- 支持 request timeout 和 cancellation。
- 写入与 DSH SessionEvent 一致的持久事件。

### Python Client 扩展

不直接修改 `DeepSeekHarness.run()`。新增 `AgentCoreHarnessClient` wrapper：

```text
AgentCoreHarnessClient
  wraps HarnessClient
  adds typed request helpers
  owns server-request dispatcher
  routes interaction requests to BFF
  maintains capability handshake
```

Python SDK 已有底层 `request()`、`next_request()` 和 `respond()` 基础能力；wrapper 在其上增加：

- async/thread-safe adapter。
- server-request handler registry。
- bridge method typing。
- request correlation。
- process generation fencing。

### 错误 Envelope

```json
{
  "code": "SESSION_NOT_FOUND",
  "message": "Session is unavailable.",
  "retryable": false,
  "details": {
    "requestId": "..."
  }
}
```

错误 code 必须在 bridge protocol 中固定，不直接复用任意 Python/Node exception message。

### 协议兼容测试

必须有以下 contract tests：

1. Stock SDK client 对 custom runtime 的基础 prompt 仍可工作。
2. 不兼容 `bridgeProtocolVersion` 时初始化 fail closed。
3. 每个扩展 method 的 params/result 与 schema 一致。
4. server-request 在 BFF 断线时返回明确取消结果。
5. runtime restart 后旧 generation response 不得进入新连接。

### 分阶段实现

#### 第一阶段

- prompt
- event stream
- session list/history
- workspace CRUD
- static model catalog
- skills list
- file browser

首个版本的 capability response：

```json
{
  "turnCancel": false,
  "interactiveRequests": false,
  "approval": false,
  "userQuestions": false
}
```

对应 UI 行为：

- 不向模型注册 `ask_user_question`。
- 不启用依赖用户审批的 `exit_plan_mode`。
- 隐藏 approval 和 question modal 入口。
- Cancel 按钮显示为“停止当前工作区 Agent”。
- Cancel 执行时终止 SDK subprocess，并从持久日志启动新 generation。
- UI 明确提示该操作影响当前 workspace 的所有活跃 DSH sessions。
- `/api/respond` 返回 `CAPABILITY_UNAVAILABLE`，不得静默丢弃。

#### 第二阶段

- turn-scoped cancel
- subagent control
- approval/user questions
- goal commands
- restricted settings
- agent preset administration

完整阶段增加：

```text
session/cancel       turn-scoped AbortSignal
interaction/request server -> Python -> BFF -> Browser
interaction/respond Browser -> BFF -> Python -> DSH
```

每个 interaction 使用不可复用的 request ID，并在：

- 用户响应。
- 浏览器断线。
- timeout。
- turn cancel。
- SDK generation 切换。

任一条件发生时明确 settle。

---

## 10. 模块 M6：Workspace 与 Artifact Storage

### 存储分层

```text
/mnt/session
  Runtime session cache、DSH_HOME、checkpoint

/mnt/projects
  Git workspace，EFS

/mnt/artifacts
  上传文件和交付物，S3 Files

/mnt/tools
  只读语言工具链，EFS
```

### 挑战

#### 挑战 A：EFS 是共享文件系统

**方案：**

- 每租户独立 Runtime 和 EFS access point。
- workspace 路径包含 user/workspace scope。
- DSH sandbox 以 workspace root 运行。
- 禁止跨租户挂载。

#### 挑战 B：Shell 可以尝试越界

**方案：**

- 使用 DSH `workspace-write` sandbox。
- 验证 Bubblewrap/Landlock。
- canonical path、realpath 和 symlink escape 检查。
- 高合规环境不共享可写 EFS。

### Production Cordis Sandbox 组合

生产 Runtime 必须使用 sandboxed provider，不能使用示例中的 bare `fs-local`/`bash-local`
作为最终执行路径：

```yaml
- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'

- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'

- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: workspace-write
    workspaceRoot: !!js process.env.DSH_CWD

- id: bash
  name: '@deepseek-ai/dsh-bash-sandbox'

- id: fs
  name: '@deepseek-ai/dsh-fs-sandbox'

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
```

启动 canary 必须执行：

1. workspace 内读写成功。
2. workspace 外写入失败。
3. symlink 指向外部时写入失败。
4. child process 继承 sandbox。
5. Bubblewrap 和 Landlock 都不可用时 Runtime 启动失败，而不是降级为无 sandbox。

`danger-full-access` 只允许本地开发，禁止生产使用。

#### 挑战 C：大文件不能全走 Runtime payload

**方案：**

- 浏览器先向 BFF申请 presigned upload。
- 文件进入 S3/S3 Files。
- Runtime 只接收 object reference。
- 下载使用短期 presigned URL。

---

## 11. 模块 M7：一个全局 AgentCore Memory

### 设计目标

全系统只创建一个 AgentCore Memory 资源。

该资源同时承载：

```text
全局共享知识
租户知识
用户私有偏好
workspace 私有事实
session 摘要
episodic coding experience
```

### Namespace 设计

```text
/global/knowledge/
/global/coding-practices/

/tenant/{tenantHash}/user/{actorId}/preferences/
/tenant/{tenantHash}/user/{actorId}/sessions/{dshSessionId}/summary/
/tenant/{tenantHash}/user/{actorId}/episodes/

/tenant/{tenantHash}/workspace/{workspaceId}/facts/
```

### 挑战

#### 挑战 A：一个全局资源可能造成跨用户泄露

**方案：**

- 客户端不能提交 actorId 或 namespace。
- Adapter 根据认证身份生成允许访问的 namespace。
- 用户只能读取 `/global/*`、自己的 user namespace 和有权限的 workspace namespace。

AgentCore Memory data plane 看到的是调用它的 Runtime IAM role，不会自动确认本次请求代表
哪个终端用户。因此多用户隔离必须由 Adapter 正确设置 actorId 和 namespace，并在应用层
强制校验。

一个 Memory ARN 不能通过普通 IAM policy 按动态 namespace 对不同终端用户隔离。因此：

- 全局 Memory 的应用层授权模块属于 Trusted Computing Base。
- DSH runtime subprocess 不获得 Memory client、Memory ID 或直接 AWS API。
- 只有 Python Adapter 的 `MemoryAccessService` 可以调用 AgentCore Memory。
- `MemoryAccessService` 不接受原始 namespace，只接受：

```text
read_global()
read_user_memory(authenticated_actor)
read_workspace_memory(authorized_workspace)
write_user_memory(authenticated_actor)
write_workspace_memory(authorized_workspace)
submit_global_candidate()
```

- `submit_global_candidate()` 只写审核队列，不直接写 `/global/*`。
- 全局写入使用独立 admin role 或审核 worker role。
- 每次 Memory 调用记录 actor、resolved namespace、operation 和 requestId 的审计事件。
- 安全测试必须对任意 actorId/namespace 注入执行 fuzz testing。

**AWS 官方引用：**

- [Memory OAuth 与多用户隔离说明](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-gateway-oauth.html)
- [通过 Gateway 访问 Memory](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-gateway-connector.html)
- [AgentCore Memory](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html)

#### 挑战 B：用户内容污染全局知识

**方案：**

- 普通对话永远不自动写入 `/global/*`。
- 用户执行“共享到全局”后进入审核队列。
- 只有管理员或审核任务能写 global namespace。
- 全局记录保留来源、审核者、版本和有效期。

#### 挑战 C：Memory 结果可能包含错误指令

**方案：**

- Memory context 标记为 untrusted。
- 不能覆盖 system prompt 或工具权限。
- 设置 relevance、数量、token 和年龄上限。
- 显示 provenance。

### Prompt 数据流

```text
1. 检索 /global/*
2. 检索用户私有 namespace
3. 检索 workspace namespace
4. 去重和排序
5. 作为 untrusted context 注入
6. 执行 DSH turn
7. 把新事实写入私有 namespace
8. 异步执行长期记忆提取
```

---

## 12. 模块 M8：Bedrock GPT 模型

### DSH 侧

使用：

```text
@deepseek-ai/dsh-llm-pi-ai
provider = amazon-bedrock
```

### AgentCore/Bedrock 侧

Runtime execution role 调用：

```text
bedrock:InvokeModel
bedrock:InvokeModelWithResponseStream
```

默认模型：

```text
us.openai.gpt-5.6-sol
```

### 挑战

- DSH catalog 可能使用短模型 ID。
- AWS 推荐使用 cross-Region inference profile ID。
- 模型必须支持 tool use 和 streaming。

### 方案

- 在 custom Cordis config 中显式配置批准的模型 ID。
- 不使用 OpenAI API key。
- IAM scope 限制到批准的 inference profile 和 foundation model ARN。

---

## 13. 模块 M9：AgentCore Web Search

### DSH 侧

DSH 已有统一模型工具：

```text
web_search
```

工具背后使用 `WebSearchProvider`。

### AgentCore 侧

AgentCore Gateway 提供托管 Web Search connector，通过 MCP 暴露：

```text
WebSearch
```

AgentCore Web Search 是 AgentCore Gateway 的托管 MCP connector，不需要自行部署搜索 API、
管理 outbound search credential 或编写搜索结果解析基础设施。

**AWS 官方引用：**

- [AgentCore Web Search Tool](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-connector-web-search-tool.html)

### 挑战

直接把 MCP tool 注册到 DSH 会出现两个工具：

```text
web_search
mcp__agentcore__WebSearch
```

这会造成能力重复，并绕过 DSH 原有 UI card 和结果格式。

### 方案

```text
DSH web_search
  -> custom WebSearchProvider
  -> SigV4 AgentCore Gateway
  -> MCP WebSearch
  -> DSH WebSearchResult
```

模型始终只看到 `web_search`。

---

## 14. 模块 M10：可观测性与管理

### 日志字段

```text
tenantHash
userHash
workspaceId
runtimeSessionHash
dshSessionId
requestId
traceId
operation
toolName
latencyMs
status
errorCode
```

### 禁止记录

```text
JWT
refresh token
Git credentials
完整 prompt
源代码正文
文件内容
Memory 私有明文
```

### 管理功能

- 启用或禁用模型。
- 管理租户 Runtime。
- 管理 preset。
- 审核全局 Memory 写入。
- 配置 Web Search domain policy。
- 查看配额、错误和 session 状态。

---

## 15. 多用户与租户设计

### 默认生产模式

```text
一个租户:
  一个 AgentCore Runtime
  一个 Runtime execution role
  一个 EFS access point
  多个 user workspace runtimeSessionId

所有租户:
  共用一个 AgentCore Memory
  共用或按策略拆分 Web Search Gateway
```

### User/workspace 映射

```text
PK = TENANT#{tenantHash}#USER#{userHash}
SK = WORKSPACE#{workspaceId}

runtimeArn
runtimeSessionId
efsWorkspacePath
state
lastActivityAt
optimisticVersion
```

### actorId

```text
actorId = HMAC(memoryKey, tenantId + ":" + cognitoSub)
```

不把邮箱、用户名或原始 Cognito `sub` 放入 Memory namespace。

---

## 16. 安全设计

### 认证链路

```text
Browser
  -> Cognito Authorization Code + PKCE
  -> BFF HttpOnly session

BFF
  -> AgentCore Runtime SigV4

Runtime
  -> Bedrock / Memory / Gateway / S3 using execution role
```

### 关键安全控制

| 风险 | 控制 |
|---|---|
| Workspace IDOR | 每次请求服务端 ownership lookup |
| runtimeSessionId 伪造 | 不向浏览器暴露，不接受客户端输入 |
| Memory 跨用户泄露 | 服务端 namespace allowlist |
| 全局 Memory 污染 | 审核后写入 `/global/*` |
| 文件路径越界 | EFS AP + sandbox + realpath |
| WebSocket 劫持 | HttpOnly cookie + Origin + CSRF token |
| 插件供应链 | 版本固定、签名和管理员批准 |
| 资源耗尽 | 每用户 workspace/session/prompt/search 配额 |

---

## 17. 网络与部署设计

### Web/BFF

```text
CloudFront
  -> Public ALB
    -> ECS Fargate BFF
```

- ALB 只能放在有 IGW route 的 public subnets。
- ALB SG 只允许 CloudFront managed prefix list。
- ECS task 只允许 ALB SG。
- ECS task AZ 集合必须被 ALB AZ 集合覆盖。

### Runtime

```text
AgentCore Runtime
  networkMode = VPC
  filesystem = managed storage + EFS + S3 Files
```

- Runtime image 为 ARM64。
- 使用私有子网和受控 NAT/VPC endpoints。
- 启用 MMDSv2。
- Runtime agent 不运行在 ECS。

### 容器构建

```text
Stage 1:
  Node 24 ARM64
  build custom DSH runtime executable

Stage 2:
  Python 3.13 ARM64
  FastAPI + deepseek-harness-sdk + custom runtime
```

---

## 18. 实施阶段

### 阶段 1：证明 Runtime 可行

- ARM64 容器启动。
- `/ping` 正常。
- `/invocations` 可以提交 prompt。
- SDK 能运行 Bash、Git、read/write/edit。
- Bedrock GPT tool use 正常。

### 阶段 2：核心 Web 兼容

- DSH Web shell 加载。
- session list/create/history/prompt。
- 两条浏览器 WS 映射到一条 AgentCore WS。
- tool cards 和 subagent events 正常。

### 阶段 3：多用户和持久化

- Cognito。
- Session Directory。
- workspace ownership。
- EFS/S3 Files。
- 两用户隔离测试。

### 阶段 4：托管能力

- 全局 AgentCore Memory。
- AgentCore Web Search。
- Bedrock 模型 allowlist。
- Observability。

### 阶段 5：完整兼容

- turn cancel。
- approval/user question。
- subagent control。
- goals。
- 管理员 settings/preset。

---

## 19. 验证场景

### 协议验证

1. Browser 建立两条 DSH WebSocket。
2. BFF 建立一条 AgentCore `/ws`。
3. `host.describe` 成功。
4. HTTP `session.prompt` 返回 receipt。
5. 模型与 tool events 只通过 WS 到达。
6. 断开 AgentCore WS。
7. BFF 重连并从 sequence checkpoint 恢复。

### 多用户验证

1. User A 创建 workspace。
2. User B 猜测 A 的 workspace ID。
3. B 的 HTTP、WS、artifact 和 Memory 操作全部失败。
4. A、B 都能读取审核后的 `/global/*` 知识。
5. B 无法读取 A 的 user namespace。

### Coding Agent 验证

1. Clone Git repository。
2. 创建两个 DSH session。
3. 修改代码并运行测试。
4. 使用 `web_search` 查询最新资料。
5. 保存用户编码偏好。
6. 新 session 从全局 Memory 的私有 namespace 召回偏好。
7. 重启 SDK process，验证 Git 和 session log 恢复。

---

## 20. 最终架构结论

### HTTP 还是 WebSocket？

答案是两者都用：

```text
HTTP:
  短请求/短响应
  prompt enqueue
  session/workspace/history/settings

WebSocket:
  模型流式输出
  tool events
  subagent events
  host/mux 状态
  reconnect/resync

stdio:
  Python Adapter 与 DSH runtime 的内部 JSON-RPC
```

### DSH 和 AgentCore 如何匹配？

```text
DSH HTTP /api/*
  -> BFF
  -> AgentCore HTTP /invocations

DSH 两条下行 WebSocket
  -> BFF channel multiplex
  -> AgentCore 单一 /ws

DSH SDK JSON-RPC
  -> Python Adapter 内部 stdio
```

### 能否完全无侵入？

不能做到零代码适配，但可以做到不修改核心：

- DSH 浏览器协议不变。
- DSH agent loop 不变。
- DSH session event 格式不变。
- 新增 BFF、Python Adapter、custom JSON-RPC bridge 和 Cordis plugins。

这就是本设计采用的外围兼容方案。

---

## 21. 参考代码与文档

### DSH

- `/home/ubuntu/g-repo/dsh/deepseek-harness/packages/client/connection/`
- `/home/ubuntu/g-repo/dsh/deepseek-harness/packages/client/modules/`
- `/home/ubuntu/g-repo/dsh/deepseek-harness/packages/host/apiproxy/`
- `/home/ubuntu/g-repo/dsh/deepseek-harness/packages/sdk/protocol/`
- `/home/ubuntu/g-repo/dsh/deepseek-harness/python/sdk/`

### AgentCore Samples

- `/home/ubuntu/g-repo/sample-AgentCore-End2End-Solution-with-Visualization/`
- `/home/ubuntu/g-repo/amazon-bedrock-agentcore-samples/06-workshops/01-AgentCore-runtime/12-coding-agents/`
- `/home/ubuntu/g-repo/amazon-bedrock-agentcore-samples/01-features/03-connect-your-agent-to-anything/03-web-search/`
- `/home/ubuntu/g-repo/amazon-bedrock-agentcore-samples/06-workshops/04-AgentCore-memory/`

### AWS 官方文档

- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-websocket.html
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-security-best-practices.html
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-connector-web-search-tool.html
