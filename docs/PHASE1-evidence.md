# Phase 1 证据：本地跑通 DSH-on-AgentCore Runtime（真 Bedrock GPT）

**日期：** 2026-08-18 · **Region：** us-west-2 · **模型：** `us.openai.gpt-5.6-sol`（via DSH `dsh-llm-pi-ai` provider=amazon-bedrock）

## 验收结果（全部通过）

| # | 验收项 | 结果 |
|---|---|---|
| 0 | Bedrock GPT 模型访问探测 | ✅ `aws bedrock-runtime converse us.openai.gpt-5.6-sol` 返回 `PROBE_OK` |
| 1 | 设计文档 review（不改原文） | ✅ `docs/review-of-design-doc.md`（优点/风险/缺口/修改建议，逐条引用章节） |
| 2 | 原设计/需求文档未改动 | ✅ sha256 与基线一致（design: 2bf092…8f8）  |
| 3 | 独立项目 + 自己的 git | ✅ 本项目独立 `.git`，多次 commit，工作树干净 |
| 4 | `/ping` 健康 | ✅ HTTP 200 `{"status":"Healthy",...}`（进程态 + 容器态均验证） |
| 5 | lazy-init（/ping 不启动 SDK） | ✅ `{"action":"status"}` 返回 `harnessStarted=false`；首次 `/invocations` 后 `true` |
| 6 | `/invocations` 真跑 Bedrock tool-use turn | ✅ `finishReason=completed`，`bash` 工具真实 round-trip（列出真实文件），非空 final |
| 7 | adapter 单测 | ✅ `pytest` 9 passed（envelope 校验 / lazy-init / single-owner） |
| 8 | 本地运行命令记录 | ✅ 见下 |

## 关键运行证据

### /ping（容器态）
```
/ping HTTP 200 -> {"status":"Healthy","time_of_last_update":...}
```

### /invocations（容器态，真 Bedrock turn）
```
HTTP 200
finishReason: completed | sessionId: session-2c14d403...
toolCalls: 4 | bash used: True
final_response:
 Current directory: `/app`
 There is **1 file** (excluding directories): `requirements.txt`.
```
tool 事件序列含 `tool/call`(bash: pwd/ls) → `tool/result`(真实输出) → 后续 assistant 步骤，证明是真实工具 round-trip 而非幻觉。

### 只可能走 Bedrock 的证据
`config/cordis.bedrock.yml` 只接了一个 LLM 适配器 `@deepseek-ai/dsh-llm-pi-ai` 的 `amazon-bedrock` 路由 → `us.openai.gpt-5.6-sol`；**没有配置任何 DeepSeek/mock provider**。`dsh_client.py` 硬编码 `PROVIDER=amazon-bedrock / MODEL=us.openai.gpt-5.6-sol / region=us-west-2`。容器 stderr 出现 `bedrock` 活动。

## 本地运行方式（两条，均已实跑）

1. **进程态（最快）**
   ```bash
   export DSH_REPO_ROOT=/home/ubuntu/g-repo/dsh/deepseek-harness
   export PYTHONPATH=$DSH_REPO_ROOT/python/sdk/src AWS_REGION=us-west-2
   python3 runtime/app.py           # BedrockAgentCoreApp 在 0.0.0.0:8080 提供 /ping + /invocations
   ```
2. **容器态（`docker run`，Phase 1 用 DSH 源码 bind-mount）**
   ```bash
   scripts/run-local.sh             # 构建 ARM64 镜像 + 冻结凭证注入 + docker run -v <dsh>:/dsh -p 8080:8080
   ```

`agentcore configure` 已生成 `.bedrock_agentcore.yaml`（entrypoint=runtime/app.py, container, python）。注意：configure 默认 Network=Public / 自动建角色，**这些将在 Phase 2 改为 VPC + 最小权限执行角色**；`agentcore deploy --local` 的完整容器路径需要把已构建的 DSH runtime 烘焙进镜像（Phase 2 完成），Phase 1 的本地容器用源码 bind-mount 证明可行性。

## 已知取舍 / 交给 Phase 2

- 镜像目前用 **源码 bind-mount** 提供 DSH runtime（体积小、够本地证明）；生产镜像需烘焙已构建 runtime（exe 或 node 闭包）。
- 凭证：Phase 1 从实例角色冻结注入容器 env（仅内存，不落盘/不进 git）；Phase 2 用 AgentCore 执行角色。
- 未做（按计划延后）：Cognito 身份、Session Directory、真云部署、Web BFF/完整 UI、全局 Memory、完整协议（cancel/approval）。
