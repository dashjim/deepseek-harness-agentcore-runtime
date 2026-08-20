# DeepSeek Harness on AgentCore Runtime — 用例概述

## 解决什么问题

DeepSeek Harness（DSH）是开源的可组合 Coding Agent 框架（agent loop / 工具 / session 全是插件），默认单用户本地运行。本 Demo 把它做成**多用户云端 Coding Agent**：真正执行模型、bash、文件、Git 的 agent 跑在 **Amazon Bedrock AgentCore Runtime** 的每用户 microVM 里，浏览器仍用 DSH 原生 Web 界面，模型换成 **Amazon Bedrock 上的 GPT（us.openai.gpt-5.6-sol）**。

## 架构（分离）

```
浏览器 (DSH Web UI)
  → CloudFront (HTTPS, 唯一公网入口)
  → ALB (入站仅 CloudFront 前缀列表)
  → ECS Fargate BFF (Cognito 登录 / HttpOnly cookie / Session Directory 归属校验 / 协议桥接)
  → [SigV4] AgentCore Runtime (VPC 模式, 无公网/无任意出站, 每用户 microVM)
  → DeepSeek Harness (agent loop + bash/文件工具)
  → Amazon Bedrock (us.openai.gpt-5.6-sol)
```

## 亮点

- **无侵入托管**：不改 DSH 核心，通过 Python Adapter（AgentCore `/ping`+`/invocations` 契约）+ 自定义 cordis（选 amazon-bedrock provider）+ Web BFF 适配。
- **每用户隔离**：Cognito 身份 → 服务端派生 actorId 与 runtimeSessionId（浏览器不可见）→ DynamoDB Session Directory 每请求归属校验，防 IDOR（跨用户访问返回 403，已验证）。
- **安全优先**：无 0.0.0.0/0；CloudFront HTTPS-only + Origin 密钥防绕过；Runtime VPC 无 NAT/IGW，仅经 VPC 端点访问指定 AWS 服务（防 bash agent 外泄）；IAM 最小权限（Bedrock invoke 精确到模型 ARN，无通配）。

## 已验证

浏览器经公网 HTTPS 登录（Cognito）→ 输入 prompt → 云端 AgentCore Runtime 执行 bash 工具 → 回复渲染在 DSH Web 界面（见 screenshots/cloud-03-reply.png，回复文本 `web-cloud-e2e-ok`，模型 `us.openai.gpt-5.6-sol`）。

## 范围与延后

本 Demo 覆盖：Runtime 部署 + 身份/权限 + Web 部署 + 端到端。延后项（设计文档记录）：流式 `/ws`、全局 AgentCore Memory、托管 Web Search、完整交互协议（turn-cancel/approval/user-question/subagent 控制）。
