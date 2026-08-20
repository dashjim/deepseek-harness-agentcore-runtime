# Phase 2 用户登录 / 认证与授权设计

**日期：** 2026-08-19 · **Region：** us-west-2 · **账户：** <ACCOUNT_ID>
**参考：** build-agent `webui-auth-patterns.md` + `security-checklist.md`；GPT 设计 §7（身份/Session Directory）、§16（安全）、§17（网络）。

回答用户问题："Phase II 的用户登录设计还没有"——**本文即补上该设计**。

## 0. 为什么不用 build-agent 的"浏览器直连 Runtime(JWT)"

build-agent 的唯一推荐架构是**浏览器直连 AgentCore Runtime、带 Cognito JWT Bearer、无代理**。它假设前端说的是 AgentCore 契约（简单 `{prompt}`→`{result}`）。**我们的 DSH 不适用**：DSH Web UI 说自己的 `/api/*` + 两条 WebSocket 协议，必须有 BFF 翻译成 AgentCore `/invocations`(+`/ws`)。因此我们保留 BFF，但**把 build-agent 的安全要求全套采用**，并采用比它更强的 token 处置（HttpOnly cookie，token 不进浏览器 JS）。

## 1. 认证架构（本方案）

```
                 (1) Authorization Code + PKCE
浏览器  ────────────────────────────────────►  Cognito Hosted UI / User Pool
   │  ◄──────── (2) code ────────────────────
   │  (3) code → BFF /auth/callback
   ▼
CloudFront(HTTPS) → ALB(私网, 仅 CloudFront 前缀列表 SG) → ECS Fargate BFF
   │   (4) BFF 用 code 换 token（拿 client secret 的机密客户端），
   │       验证 id/access token（issuer/aud/exp/JWKS），只在服务端持有 token，
   │       给浏览器下发 Secure + HttpOnly + SameSite=Lax 的会话 cookie
   │   (5) 浏览器后续 /api/* 与两条 WS 都带该 cookie；浏览器 JS 永远拿不到 JWT
   ▼   (6) BFF 用 ECS task role 对 AgentCore Runtime 做 SigV4 调用
AgentCore Runtime (VPC, IAM/SigV4 auth)  →  DSH  →  Bedrock
```

要点（对齐 build-agent 安全清单 + 设计 §16）：
- **浏览器不持有 JWT**：token 只在 BFF 服务端；浏览器只有 HttpOnly 会话 cookie。比 build-agent 的 localStorage JWT 更抗 XSS。
- **BFF→Runtime 用 SigV4（IAM auth）**，凭 ECS task role；Runtime 侧用 IAM 认证（默认）。（可选防御纵深：也可在 Runtime 上加 `customJWTAuthorizer`，但 BFF 走 SigV4 时以 IAM 为准。）
- **WebSocket 劫持防护**：校验 `Origin`；会话 cookie `SameSite=Lax` + CSRF token；WS 升级请求校验 cookie。
- **CloudFront 是唯一公网入口**；ALB 在私有子网、SG 仅允许 CloudFront 托管前缀列表；ECS task SG 仅允许 ALB SG。**无 0.0.0.0/0**。

## 1b. WebSocket 与用户绑定（参考 OpenClaw web-ssh spec）

参考：`sample-host-openclaw-on-amazon-bedrock-agentcore/docs/superpowers/specs/2026-05-12-web-ssh-into-agentcore-runtime.md`（§4.1、§5.2、第 384-392 行的 session 路由）。

该 spec 是**浏览器直连 Runtime**，因此用 **SigV4 Pre-signed WSS URL**（浏览器 WebSocket API 不能设自定义 header，spec §3 表：浏览器场景必须用 SigV4QueryAuth；服务端/CLI 才用 SigV4 Header）。**我们不同**：中间有 BFF，浏览器根本不直连 Runtime，所以：

| 段 | 连接 | 认证 | 绑定 |
|---|---|---|---|
| 浏览器 ↔ BFF | DSH 两条 WS（mux/host） | **HttpOnly 会话 cookie**（BFF 从 cookie 知道是哪个用户）+ Origin 校验 + CSRF | 由 cookie 确定 user |
| BFF ↔ AgentCore | 一条 `/ws` | **SigV4 Header**（BFF 是 Node 服务端，能设 handshake header；不用 pre-signed URL、不发给浏览器） | `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header |

绑定流程（每次连接）：
1. 浏览器开两条 WS 到 BFF，仅凭会话 cookie；BFF 据 cookie 解析出 `cognitoSub → actorId`。
2. BFF 在 Session Directory 查 `user → workspaceId → runtimeSessionId`（**服务端生成、≥33 字符、`ses_{userHash}_{workspaceHash}` 之类，浏览器永不可见**）。做 owner 校验（防 IDOR）。
3. BFF 开（或复用）**一条** AgentCore `/ws`，带 SigV4 header + `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id=<runtimeSessionId>`。**同一 runtimeSessionId → 同一 microVM**（会话粘性，spec 第 387 行）；`/invocations` 与 `/ws` 必须带同一个 session id。
4. BFF 把浏览器的 mux+host 两条下行，按 `channel` 字段从这一条上游 `/ws` 复用拆分（设计 §4.7）。
5. WS 升级请求也重复 owner 校验，不只在 HTTP 层校验。

要点：`runtimeSessionId` 由服务端按认证用户+workspace 派生并存在 Session Directory，浏览器永不接触；用户无法伪造他人的 runtimeSessionId（对齐 spec 的"不同 session→不同容器"隔离 + 设计 §7 防 IDOR）。首版事件可先非流式（BFF 合成 mux 帧）；真流式再让 adapter 增开 `/ws` 把 DSH `session.event` 逐条外推。

## 2. Cognito 配置

- **User Pool**：`dsh-agentcore-users`，`username-attributes=email`，`auto-verified-attributes=email`，MFA 可选（生产建议 OPTIONAL/ON）。
- **App Client（机密客户端，给 BFF 用）**：`GenerateSecret: true`，`AllowedOAuthFlows=code`，`AllowedOAuthScopes=openid email profile`，callback = `https://<cloudfront-domain>/auth/callback`，logout URL 同域。
  - 注：这是**机密客户端**（BFF 是服务端，能安全保管 secret），与 build-agent 的"浏览器公共客户端 `--no-generate-secret`"不同——因为 token 交换在 BFF 而非浏览器。secret 存 Secrets Manager，不进代码/git。
- **测试用户**：`admin-create-user` + `admin-set-user-password --permanent`（强密码，不硬编码，创建后仅存 Secrets Manager/口头交付）。
- **Discovery URL**：`https://cognito-idp.us-west-2.amazonaws.com/<POOL_ID>/.well-known/openid-configuration`。

## 3. 身份与多用户授权（设计 §7）

- `actorId = HMAC(memoryKey, tenantId + ":" + cognitoSub)`，**服务端派生**；不放邮箱/用户名/原始 sub 进任何 namespace。
- `runtimeSessionId` **服务端生成**，浏览器永不可见、永不接受客户端输入。
- **Session Directory（DynamoDB）**：`PK=TENANT#{tenantHash}#USER#{userHash}`，`SK=WORKSPACE#{workspaceId}`，存 `runtimeArn/runtimeSessionId/state/lastActivityAt/optimisticVersion`。
- **每个请求先做 owner lookup**（认证用户 + 公开 workspaceId → 校验归属）；不允许用 `runtimeSessionId` 反查 workspace（防 IDOR）。artifact/WS/后续调用都重复校验归属。
- 首版并发约束：一个 workspace 同时一个 active prompt（DynamoDB 条件更新维护 `activePromptCount`）。

## 4. IAM 最小权限（build-agent 安全清单 + 设计）

- **ECS task role**（BFF）：`bedrock-agentcore:InvokeAgentRuntime`（+ WS 变体）限定到本 Runtime ARN；Secrets Manager 读取限定到本项目 secret；DynamoDB 限定到 Session Directory 表；Cognito 无需（用 discovery/JWKS 公钥验签，token 交换用 client secret）。
- **Runtime 执行角色**：`bedrock:InvokeModel*` 的 **Resource 限定到批准的 foundation-model ARN + inference-profile ARN**（覆盖 `us.openai.gpt-5.6-sol`），**不用 `Resource:"*"`**；ECR pull；CloudWatch Logs；（Phase 后续）Memory/Gateway 按需。
- **红线**：不用 `iam:*`/`s3:*`/`bedrock-agentcore:*` 通配 action；`iam:PassRole` 限定到具体角色 ARN；无 Lambda `Principal:"*"`；无 Function URL `AuthType:NONE`；前端 S3 `BlockPublicAccess.BLOCK_ALL` + CloudFront OAI/OAC；密钥不进代码/git（`.env`、client secret、密码全走 Secrets Manager）。

## 5. 部署后安全核验（build-agent Post-Deployment）

- 未认证请求 → BFF 302 到登录 / 401；无效或过期 token 被拒；logout 清除会话。
- `aws ec2 describe-security-groups` 确认无 0.0.0.0/0（demo 端口）。
- `aws s3api get-bucket-policy` / public access block 确认前端桶不公开；CloudFront 是唯一公网入口。
- `aws lambda list-functions` 确认无公共资源策略（本方案默认不引入 Lambda 代理）。
- IAM 策略打印确认 Bedrock Resource 限定、无通配 action。
- 日志 grep 确认无 JWT/refresh token/密钥/源码正文泄漏（设计 §14 禁记项）。
- 双用户隔离：user B 用 user A 的 workspaceId 被拒（403），有证据。

## 6. 与 build-agent 的差异与理由（登记）

| build-agent 要求 | 本方案 | 说明 |
|---|---|---|
| 浏览器直连 Runtime、无代理 | 保留 BFF | DSH 浏览器协议 ≠ AgentCore 契约，必须翻译 |
| 浏览器公共客户端 `--no-generate-secret` | BFF 机密客户端 + code 换 token | token 交换在服务端，更安全；浏览器不持 JWT |
| Runtime 配 `customJWTAuthorizer` | BFF→Runtime 用 SigV4(IAM)；JWT 在 BFF 层校验 | 由 BFF 承担用户认证；可选加 JWT authorizer 作纵深 |
| 其余全部安全红线（无公网/IAM 限定/无密钥入库/CloudFront HTTPS） | **全部采用** | — |
