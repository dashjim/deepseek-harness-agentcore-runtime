# 部署指南：DeepSeek Harness on AgentCore Runtime

Region us-west-2，账户 <ACCOUNT_ID>。外部预构建 Agent（`runtime.source = register`）。

## 组件与部署次序

1. **自包含 Runtime 镜像**：`scripts/build-image.sh` 用 `pnpm deploy` 把 DSH runtime 闭包烘焙进 ARM64 镜像（不依赖挂载）；推送到 ECR `dsh-agentcore-runtime`。
2. **AgentCore Runtime**：`create-agent-runtime`（VPC 模式、私有子网、无 NAT/IGW、仅 VPC 端点出站），最小权限执行角色（Bedrock invoke 精确到模型 ARN）。Runtime `<RUNTIME_ID>`。
3. **身份**：Cognito User Pool（机密客户端，secret 入 Secrets Manager）；DynamoDB `dsh-session-directory`（每用户 workspace 归属，防 IDOR）。
4. **Web BFF**：`web-bff/` Node 服务（Cognito 登录 / HttpOnly cookie / Session Directory 校验 / SigV4 调 Runtime / 托管 DSH Web UI 烘焙静态）；镜像推 ECR `dsh-bff`。
5. **Web 网络**：CloudFront(HTTPS) → ALB（入站仅 CloudFront 前缀列表，无 0.0.0.0/0，+ X-Origin-Verify）→ ECS Fargate（私有子网）。公网 `https://<CLOUDFRONT_DOMAIN>`。

## 安全要点

- 无 0.0.0.0/0 入站；CloudFront 唯一公网入口，HTTPS-only。
- Runtime VPC 无任意出站（仅 VPC 端点到指定 AWS 服务）。
- IAM 最小权限：Bedrock invoke 限模型 ARN，无通配 action；BFF task role 限本 Runtime/表。
- 密钥全在 Secrets Manager（Cognito client secret、测试用户、BFF cookie/HMAC/origin-verify），不进 git/镜像。

## 验证

- Runtime：`agentcore`/`invoke-agent-runtime` 返回 `finishReason=completed` + bash 工具 round-trip。
- Web：浏览器 HTTPS 登录（Cognito）→ 发 prompt → 云端 Runtime 回复渲染（截图 `screenshots/cloud-03-reply.png`）。
- 隔离：user B 用 user A 的 workspaceId → 403。

详见源码包 `code.zip` 内 `docs/`（review-of-design-doc / design-deviations / auth-design / PHASE2-runtime-deploy）。
