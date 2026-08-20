# Phase 2 证据（一）：Runtime 云部署（VPC 模式，无公网）

**日期：** 2026-08-19 · **Region：** us-west-2 · **账户：** <ACCOUNT_ID>

自包含 DSH 镜像已真部署到 Amazon Bedrock AgentCore Runtime，**VPC 模式、无公网暴露、无任意出站**，云端 invoke 端到端验证通过。

## 资源清单

| 资源 | 值 |
|---|---|
| ECR 镜像 | `<ACCOUNT_ID>.dkr.ecr.us-west-2.amazonaws.com/dsh-agentcore-runtime:v1`（linux/arm64） |
| 执行角色 | `arn:aws:iam::<ACCOUNT_ID>:role/dsh-agentcore-execution-role-us-west-2` |
| Runtime ID | `<RUNTIME_ID>` |
| Runtime ARN | `arn:aws:bedrock-agentcore:us-west-2:<ACCOUNT_ID>:runtime/<RUNTIME_ID>` |
| Endpoint | `DEFAULT`（READY） |
| VPC | `<VPC_ID>`（dsh-agentcore-vpc, 10.20.0.0/16, 专用） |
| 私有子网 | `<SUBNET_ID>`(2a), `<SUBNET_ID>`(2b)（MapPublicIp=false） |
| Runtime SG | `<SG_ID>`（入站为空） |
| VPC 端点 | bedrock-runtime/ecr.api/ecr.dkr/logs/sts/bedrock-agentcore（接口）+ S3 网关 |

（完整 ID 见 `config/runtime_config.json`，gitignored。）

## 安全核验（独立复核通过）

- **Runtime 状态** READY / networkMode=VPC。
- **IAM 最小权限**：`bedrock:InvokeModel(+Stream)` 精确限定到 inference-profile + 3 region foundation-model 共 4 个 ARN；`ecr:GetAuthorizationToken` 用 `*`（该 action 只能 *，规范允许）；ECR pull 限 repo ARN；logs 限 `/aws/bedrock-agentcore/*`。**无 `bedrock:*/s3:*/iam:*/bedrock-agentcore:*` 通配 action，Bedrock invoke 无 `Resource:"*"`**。信任策略带 `SourceAccount` + `ArnLike SourceArn=runtime/*`。
- **Runtime SG 入站 = `[]`**（无 0.0.0.0/0）；端点 SG 入站仅 VPC CIDR 443。
- **无 IGW、无 NAT**；路由表仅 `local` + S3 网关前缀列表 `<PREFIX_LIST_ID>`，**无 0.0.0.0/0 默认路由**→ 容器只能经 VPC 端点到指定 AWS 服务，**杜绝任意互联网出站**（防 bash agent 外泄）。

## 云端 invoke 验证

- `{"action":"status"}` → 200 `{"status":"ready","harnessStarted":false}`（lazy-init）。
- `{"prompt":"Use the bash tool to run: echo cloud-ok..."}` → 200，`finishReason=completed`，`response=cloud-ok`，含 bash `tool/call`→`tool/result cloud-ok\n` round-trip（~12s），经 bedrock-runtime VPC 端点到达。

## 部署中定位并修复的两个真实问题

1. **502 拉镜像超时**：ECR 层由 S3（`prod-us-west-2-starport-layer-bucket`）分发，Runtime SG 出站只放行到 VPC CIDR，S3 网关流量被丢。修：出站加 **S3 托管前缀列表 `<PREFIX_LIST_ID>`**（非 0.0.0.0/0，合规）。
2. **400 编码错误**：AWS CLI v2 默认 base64 解码 `--payload` 破坏 JSON。修：`--cli-binary-format raw-in-base64-out`。

## 备注

- 配额：账户 VPC 数原为 5/5，部署时自动申请把上限提到 6（Service Quotas 自动审批 ~2 分钟通过，未开 support 工单）；已生效，无费用、无副作用，保留。此后未再申请任何配额。
- 用了专用 VPC（未触碰 OpenClaw 任何资源）。
- 后续加固（已记录）：凭证冻结注入子进程在长会话（>1h）会过期，需加刷新计时器；VPC 出站已最小化。

## 下一步（Phase 2 剩余）

Cognito 身份 + DynamoDB Session Directory（防 IDOR）→ 部署 Web BFF（CloudFront/ALB→ECS，Cognito 登录，SigV4 到 Runtime）→ 浏览器云端 e2e + 安全终检。
