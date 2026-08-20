# 设计文档评审：基于 AgentCore Runtime 的多用户 DeepSeek Harness

**评审对象：** `codex-doc/deepseek-harness-agentcore-runtime/docs/design-deepseek-harness-agentcore-runtime.md`（2026-08-18，20 章）
**评审人：** Claude（本项目实施方）
**评审日期：** 2026-08-18
**立场：** 本文是独立意见文档，**不修改**原设计文档。原文档保持只读。

---

## 总评

这是一份**质量相当高**的设计文档：问题分解清晰、AgentCore 协议契约理解准确、把"无侵入"的真实边界（§1 目标 7 的变更级别表）诚实地讲清楚了，安全上也抓住了全局 Memory 与多用户隔离这个最难的点。它的**主要问题不在设计本身，而在工程量与阶段排序**——文档把一个至少 3-6 个月的完整系统一次性铺开，而落地必须先证明最小可行链路。下面分四部分。

---

## 一、优点（值得保留的判断）

1. **协议桥接的三段式切分准确**（§4）。"浏览器↔BFF 用 DSH 原协议 / BFF↔Runtime 用 AgentCore /invocations+/ws / Adapter↔DSH 用 stdio JSON-RPC"这个分层是对的，且和 DSH 现有"HTTP 上行 + WebSocket 下行"的分工同构。把 `session.prompt` 走 HTTP 只返回 receipt、真实事件全走 `/ws`（§4.3 末）——这与 DSH 语义一致，是正确的映射，避免了"全 HTTP 丢事件流"或"全 WebSocket 让短 RPC 变复杂"两个极端。

2. **诚实界定"无侵入"的边界**（§1 目标 7、§20）。用一张"变更级别表"明确"agent loop / SessionEvent 格式 / tool schema 不改，但新增 out-of-tree Cordis plugin、替换 SDK JSON-RPC server、构建 custom runtime closure 允许"——这比空喊"零侵入"务实得多，也和 DSH "everything is a plugin" 的架构吻合。

3. **抓住了 stock SDK 的能力缺口**（§2 挑战 3、§9）。文档明确列出 stock 协议只有 `initialize/session/prompt/shutdown` + 4 类通知，而完整 UI 需要 list/history/search/fork/cancel/approval/user-question——并把这些归入需要扩展的 `sdk-web-bridge`。这个判断已被实测证实（`packages/sdk/protocol/src/types.ts` 只有那三个 client→server 方法）。

4. **两套 Session 的区分是对的**（§2 挑战 4、§7）。`runtimeSessionId`（microVM/隔离）与 `dshSessionId`（对话/事件日志）解耦，一个 workspace 一个 runtimeSessionId、内含多个 dshSessionId——这是支持"一个工作区多个对话"的正确前提，也避免了把二者混成一个 ID 的常见错误。

5. **全局 Memory 的安全模型考虑得深**（§11、§16）。承认"一个 Memory ARN 无法用普通 IAM 按动态 namespace 对终端用户隔离"，因此把 `MemoryAccessService` 设为 Trusted Computing Base、不给 DSH 子进程 Memory client、只暴露 `read_user_memory(authenticated_actor)` 这类不接受原始 namespace 的方法——这是对的。`submit_global_candidate()` 只写审核队列、全局写用独立 admin role——把"用户内容污染全局知识"这个投毒面堵住了。

6. **沙箱 fail-closed 的要求正确**（§10）。"Bubblewrap 和 Landlock 都不可用时 Runtime 启动失败，而不是降级为无沙箱"、"`danger-full-access` 只允许本地开发"——这是安全默认值应有的姿态。

---

## 二、风险（会在落地时咬人的地方）

1. **【高】DSH 是 developer preview，且预编译 runtime 二进制不随仓库分发。** 文档 §1 提到要固定 commit（对），但没点明一个实操事实：零配置 `DeepSeekHarness()` 在当前 checkout 会直接 `FileNotFoundError`（bundled exe/node 闭包都不在仓库里）。本地必须走 source-launch 或先 `scripts/build-exe-for-python-sdk.ts` 现场构建（@yao-pkg/pkg 6.21.0 + node24），云镜像必须烘焙已构建的 runtime。**这决定了 Dockerfile 的构建阶段远比文档 §17 的两行 Stage 描述复杂**（要拉起 ~110 个 workspace 包）。

2. **【高】模型 provider 分叉未在文档中标红。** 文档 §12 说用 `dsh-llm-pi-ai` + `provider=amazon-bedrock`，但 DSH bundled 默认 cordis 用的是 `dsh-llm-deepseek`（读 `DEEPSEEK_API_KEY`）。二者是**不同 provider 配置**，"本地跑通"若用默认配置跑的是 DeepSeek 官方 API，并不等于满足 Bedrock 需求。必须显式提供 custom cordis 选 bedrock provider——且需先验证 `dsh-llm-pi-ai` 确实支持 amazon-bedrock（这是本项目 Phase 1 正在实测的关键点）。

3. **【高】阶段排序把最难的留到最后，但它其实是主风险。** §18 的 5 阶段里，"完整协议兼容（turn cancel / approval / user-question / server→client 请求）"排在阶段 5。但 §2 挑战 8 已承认 stock SDK **根本不发 server→client request**。这意味着 `ask_user_question`、tool approval、plan approval 在扩展 `sdk-web-bridge` 之前**完全无法工作**——这是整个"完整 DSH Web 体验"目标（§1 目标 1）的命门，却被排在最后。建议：要么把它提前作为可行性验证，要么在早期就明确 MVP 砍掉这些交互（文档 §9 第一阶段其实已经这么做了，但目标 1 的措辞没有对齐这个妥协）。

4. **【中】Python SDK 是同步阻塞子进程客户端，并发模型是硬骨头。** §8 挑战 A 的方案（FastAPI 单 worker + dedicated thread + queue）方向对，但"一个 workspace 同时只允许一个 active prompt"（§7）是个明显的可用性限制，且 §4.8 的连接建立顺序、§8 挑战 C 的崩溃恢复（杀进程→从 JSONL 重启→resync）在真实并发/多标签页下容易出竞态。建议第一版就把"每 microVM 单 SDK owner + 串行 prompt"作为硬约束写死，别过早追求并行。

5. **【中】BFF 的 "Web-only Cordis profile"（§6）依赖对 DSH 内部 plugin roster 的精确裁剪。** 列了一长串保留/禁用的 rows，但 DSH 是 preview，这些 plugin id 和依赖关系随版本会变。"禁用所有 agent-plane rows 但保留浏览器 boot"是个脆弱的手术，CI 验证（§6 Profile 验证的 5 条）是必须的，否则升级 DSH 就炸。

6. **【中】真实云部署的爆炸半径与成本未量化。** §15/§17 的"每租户独立 Runtime + EFS access point + IAM role"在租户多时是运维和配额负担；"一个全局 Memory"又和"每租户独立一切"在心智模型上有点拉扯。文档没给出租户规模假设下的资源数量级估算。

7. **【低-中】模型 ID 用 `us.openai.gpt-5.6-sol`（OpenAI GPT on Bedrock）。** 需确认该 inference profile 支持 **tool use + streaming**（DSH 工具循环强依赖）。已实测该 profile 在 us-west-2 ACTIVE 且 converse 可调通，但 tool-use 行为需在 DSH 工具循环里端到端验证。

---

## 三、缺口（文档没说清或漏掉的）

1. **缺 Dockerfile 的真实构建细节。** §17 只有"Stage1 Node24 build runtime / Stage2 Python3.13"两行。缺：DSH runtime 怎么从 monorepo 构建成单文件 exe 或 node 闭包、镜像里要装哪些系统包（git/bash/ripgrep/PTY 依赖 `pty.node`/编译工具链）、如何 pin。这是落地第一天就要解决的，却是文档最薄的一章。

2. **缺"本地开发/最小验证"路径。** 文档直接跳到多用户云端全景，没有"如何在一台机器上先把 /ping + /invocations + 一次 DSH turn 跑起来"的最小闭环。而这恰恰是证明可行性、也是本项目 Phase 1 的目标。建议补一节 "local dev loop"（`agentcore deploy --local` / `agentcore dev`）。

3. **缺协议版本协商失败与 DSH 升级的具体回归策略。** §9 提到 `bridgeProtocolVersion` 协商、fail-closed（好），但没说 DSH upstream 升级导致 SessionEvent 或 plugin roster 变化时，BFF/adapter/custom runtime 三者如何联动升级、如何回归测试。对一个 preview 依赖，这是运维刚需。

4. **缺 `/invocations` 与 `/ws` 的 session 生命周期与 AgentCore 限制对齐。** 文档 §4 讲了协议映射，但没提 AgentCore 的硬限制：容器最长寿命、空闲回收、初始化超时（~120s）、`/ping` 必须秒回且不能触发重活、WS 帧 32KB 上限（§4.7 提了 32KB 分片，好，但没和 AgentCore 的 payload/时限约束整体对账）。这些在 OpenClaw 那套实现里是反复咬人的坑。

5. **缺可观测性的落地细节。** §14 列了日志字段和禁记项（好），但没说 trace 如何贯穿 BFF→AgentCore→Adapter→DSH 四层（traceId 传递）、以及 AgentCore Observability 与 CloudWatch/X-Ray 的具体接线。

6. **缺回滚与多版本并存策略。** 一个 workspace 绑定一个 runtimeSessionId，但换镜像版本时正在运行的 session 如何迁移/是否强制新 session、旧版本容器如何优雅退出——没提（OpenClaw 的经验是：update-agent-runtime 不替换运行中容器，必须 stop-session）。

---

## 四、具体修改建议

1. **§17 容器构建单独扩成一章**，给出：DSH runtime 构建命令（exe 或 node 闭包二选一并说明取舍）、镜像系统依赖清单、pin 策略、镜像体积预期。这是文档当前最大的空白。

2. **§18 阶段计划重排**：把"provider=Bedrock 的本地最小 turn（/ping+/invocations+一次 bash 工具）"单列为阶段 0/1 的验收硬门槛，并把"server→client 交互能力（approval/user-question）"的可行性验证从阶段 5 提前到阶段 2，因为它是"完整 UI"目标能否成立的前提。若不提前，就在 §1 目标 1 明确写上"MVP 不含 approval/user-question/turn-cancel"，与 §9 第一阶段的 capability=false 对齐。

3. **在 §12 标红 provider 分叉**：明确"默认 cordis 是 DeepSeek 官方 provider，必须替换为 amazon-bedrock custom cordis 才满足需求"，并给出该 cordis 的样例片段（本项目 Phase 1 会产出可复用样例）。

4. **补一节 "Local Dev Loop"**：`agentcore deploy --local` / `docker run -p 8080:8080` + `curl /ping` + 一次 `/invocations`，凭证经 env 注入不落盘。降低新人上手成本，也是可行性的第一道证明。

5. **§7 并发约束写死为硬约束**：第一版明确"每 microVM 单 SDK owner、每 workspace 单 active prompt、串行执行"，把"多 DSH session 并行"标为"SDK 并发验证通过后再开放"的未来项，避免过早优化引入竞态。

6. **§16 增加 AgentCore 运行时硬限制清单**（容器寿命/空闲回收/初始化超时/ping 语义/WS 32KB/payload 上限/换镜像必须 stop-session），并把 IAM 写成"Action 可通配、Resource 必须限定到批准的 model ARN + inference-profile ARN；安全组绝不 0.0.0.0/0"。

7. **明确 developer-preview 依赖治理**：pin DSH commit（当前 47f94385 / 0.1.0-rc.5）、SDK/runtime 同版本、构建工具（@yao-pkg/pkg 6.21.0、node24、hatchling 1.30.1），并写出升级时的三层联动回归清单。

---

## 结论

设计方向**正确且可落地**，安全模型是亮点。落地的真正难点集中在两处文档偏薄的地方：**(a) DSH runtime 的构建与打包**、**(b) 阶段排序与 MVP 边界**。本项目采取的策略是：**Phase 1 先用 provider=Bedrock 的 custom cordis 在本地把 `/ping + /invocations + 一次真实 GPT tool-use turn` 跑通**（正面回应缺口 2、风险 1/2），再进入 Phase 2 的身份与真实云部署。完整 Web BFF、全局 Memory、完整协议兼容按文档 §18 的后续阶段推进，不在本次两相范围内。
