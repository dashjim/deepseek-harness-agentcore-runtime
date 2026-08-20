# DeepSeek Harness on Amazon Bedrock AgentCore Runtime

[English](README.md) · **中文**

把开源 **DeepSeek Harness (DSH)** 编码 Agent 托管成 **Amazon Bedrock AgentCore Runtime** 上的
**多用户云端 Coding Agent**——保留 DSH 原生 Web 界面，模型用 **Bedrock GPT**（`us.openai.gpt-5.6-sol`）。

> Agent（模型 + `bash`/文件工具）跑在每用户独立的 AgentCore micro-VM 里。浏览器仍讲 DSH 自己的
> Web 协议；一个薄 BFF 把它桥接到 AgentCore，并加上 Cognito 登录 + 每用户隔离。
> **DSH 本身零改动**（全部通过外围适配层）。

📄 **完整设计文档**（已合并实测标注与偏差）：
[docs/design-deepseek-harness-agentcore-runtime.md](docs/design-deepseek-harness-agentcore-runtime.md)

![DSH Web 界面渲染来自云端 AgentCore Runtime 的回复](alp/screenshots/cloud-03-reply.png)

## 架构

![部署架构](alp/architecture.png)

```
浏览器 (DSH Web UI)
  → CloudFront (HTTPS，唯一公网入口)
  → ALB (入站仅 CloudFront 前缀列表，+ X-Origin-Verify)
  → ECS Fargate BFF  (Cognito 登录 · HttpOnly cookie · Session Directory 归属校验 · DSH 静态 UI)
  → [SigV4 InvokeAgentRuntime]  AgentCore Runtime (VPC，每用户 micro-VM，无 NAT/IGW)
  → Python adapter (/ping + /invocations)  → DeepSeek Harness (agent loop + 工具)  → Amazon Bedrock
```

**两个平面：**
- **Agent 平面** —— 自包含 ARM64 镜像烘焙了预构建的 DSH runtime 闭包；一个小的 Python adapter 暴露
  AgentCore 契约（`/ping` + `/invocations`）并懒启动 DSH，DSH 经 `dsh-llm-pi-ai` 的 `amazon-bedrock`
  provider 调 Bedrock。
- **Web 平面** —— Node BFF 托管 DSH Web UI（烘焙静态），接管 `/api/*` 与两条下行 WebSocket，用 Cognito
  认证用户，用 DynamoDB Session Directory 做每用户归属校验，并用 SigV4 调用云端 Runtime。

## 亮点

- **零改 DSH 源码** —— 全部外围适配（Python adapter、自定义 cordis 配置、BFF）。
- **每用户隔离（防 IDOR）** —— `runtimeSessionId` 服务端派生、浏览器永不可见；每个请求都重新校验
  workspace 归属。
- **安全优先网络** —— 无 `0.0.0.0/0`；CloudFront 是唯一公网入口（仅 HTTPS）；Runtime 在 VPC 内**无
  NAT/IGW**（仅 VPC 端点 → 无任意出站）；IAM 最小权限（Bedrock invoke 精确到模型 ARN，无通配）。
- **密钥**只在 AWS Secrets Manager —— 绝不进 git 或镜像层。

## 目录结构

| 路径 | 内容 |
|---|---|
| `runtime/` | Python AgentCore adapter (`app.py`) + DSH 启动器 (`dsh_client.py`) + 测试 |
| `Dockerfile`、`scripts/build-image.sh` | 自包含 ARM64 Runtime 镜像（烘焙 DSH runtime 闭包） |
| `config/cordis.bedrock.yml` | 选 `amazon-bedrock` provider 的 DSH cordis 配置 |
| `web-bff/` | Node BFF（Cognito 登录、Session Directory、SigV4→Runtime、DSH 静态 UI）+ `Dockerfile` |
| `docs/` | 设计评审、偏差、认证设计、各阶段证据 |
| `alp/` | 架构图 + demo 包 |

## 构建与运行

**Runtime 镜像（自包含，无需挂载）：**
```bash
bash scripts/build-image.sh            # 构建 linux/arm64 镜像，DSH runtime 已烘焙进去
docker run -p 8080:8080 -e AWS_REGION=us-west-2 <image>   # /ping + POST /invocations {"prompt":"..."}
```

**本地开发（source 模式）：** 让 adapter 指向一个 DSH 检出——
`DSH_RUNTIME_MODE=source DSH_REPO_ROOT=/path/to/deepseek-harness python3 runtime/app.py`。

**云部署：** ECR + `create-agent-runtime`（VPC 模式），Cognito + DynamoDB，然后把 BFF 部到
ECS/ALB/CloudFront。所有部署具体 ID 通过 env / Secrets Manager 注入（不进 git）；所需变量见
`web-bff/README.md`，完整步骤见 `docs/PHASE2-runtime-deploy.md` + `docs/auth-design.md`。
📄 **端到端部署手册（clone → 捕获静态 → 构建 → 部署 → 验证 → 回收）：[docs/DEPLOY.md](docs/DEPLOY.md)。**

## 状态

Phase 1（本地、真 Bedrock）与 Phase 2（云部署 + 身份 + Web + 浏览器 e2e）已完成并验证。流式 `/ws`、
全局 AgentCore Memory、托管 Web Search、完整交互协议（取消/审批/子 agent）作为后续项记录在
`docs/design-deviations.md`。

## 说明

- Region `us-west-2`；模型 `us.openai.gpt-5.6-sol`。
- 本公开仓库中账号、VPC/子网/安全组、ARN、URL 等部署标识均以 `<占位符>` 呈现。
- DSH 是独立的上游项目，本项目零改动地使用它。
