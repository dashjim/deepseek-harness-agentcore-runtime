# DSH Web BFF

浏览器面向的 DSH Web UI 与**云端 AgentCore Runtime** 之间的 Backend-For-Frontend。
它承担：Cognito 登录、服务端会话（浏览器只拿 HttpOnly cookie，不持 JWT）、
Session Directory 归属校验（防 IDOR）、以及经 SigV4 调云端 Runtime。参考设计见
`../docs/auth-design.md`。

## 组件职责

- **登录**：`POST /auth/login {username,password}` → 服务端 `USER_PASSWORD_AUTH`
  （算 `SECRET_HASH = base64(HMAC-SHA256(clientSecret, username+clientId))`，
  clientSecret 从 Secrets Manager 读入）→ 成功后签发
  `Secure + HttpOnly + SameSite=Lax` 会话 cookie（`dsh_sess`，值为
  `sessionId.HMAC(cookieSecret,sessionId)`）。JWT 只在服务端短暂持有以取 `sub`，
  随即丢弃。`POST /auth/logout` 清会话；`GET /auth/me` 探测登录态；`GET /login`
  提供极简登录页；未登录访问 `/` → 302 `/login`。
- **认证守卫**：`/api/*` 与两条 WS 升级都要求有效会话 cookie（否则 401 / 断开），
  并校验 `Origin`（配合 `SameSite=Lax` 做 CSRF 防护）。WS 升级重复校验，不只在 HTTP 层。
- **身份 / Session Directory**：`actorId = HMAC(memoryKey, tenantId+":"+sub)`（服务端派生），
  `userHash = actorId[:16]`。workspace 存 DynamoDB：`PK=TENANT#{tenantHash}#USER#{userHash}`，
  `SK=WORKSPACE#{workspaceId}`，字段 `runtimeArn/runtimeSessionId/state/lastActivityAt/optimisticVersion`。
  `runtimeSessionId = ses_{userHash}_{workspaceHash}`（服务端生成、≥33 字符、**浏览器永不可见**）。
  每个带 workspace 的请求先做 **owner lookup**（认证用户 + 公开 workspaceId），查不到即 403；
  绝不用 runtimeSessionId 反查。
- **调用云端 Runtime**：`session.prompt` → owner 校验 → 取该 workspace 的 runtimeSessionId
  → `InvokeAgentRuntime`（SigV4，凭本机默认凭证链/实例角色；上云换 ECS task role；
  同一 runtimeSessionId 保证 microVM 粘性）→ 回复作为 mux `assistant/message` 帧推回浏览器。

## 环境变量（全部走 env / Secrets Manager，绝不硬编码密钥）

| 变量 | 说明 | 本地默认 |
|---|---|---|
| `AWS_REGION` | 资源所在区（须与各 ARN 一致） | `us-west-2` |
| `COGNITO_POOL_ID` | User Pool ID | `<COGNITO_POOL_ID>` |
| `COGNITO_CLIENT_ID` | 机密客户端 ID | `<COGNITO_CLIENT_ID>` |
| `COGNITO_SECRET_ARN` | client secret 的 Secrets Manager id/ARN（启动时读取） | `dsh-agentcore/cognito-client-secret` |
| `COGNITO_CLIENT_SECRET` | （可选）直接给 secret，覆盖上面的 Secrets Manager 读取 | — |
| `RUNTIME_ARN` | 云端 AgentCore Runtime ARN | 项目默认 |
| `RUNTIME_QUALIFIER` | endpoint qualifier | `DEFAULT` |
| `DDB_TABLE` | Session Directory 表名 | `dsh-session-directory` |
| `TENANT_ID` | 租户标识（进入 actorId/PK 派生，非明文入库） | `default` |
| `SESSION_COOKIE_SECRET` | 会话 cookie 签名密钥 | **未设则每次启动随机**（生产必须固定，走 Secrets Manager/env） |
| `MEMORY_KEY` | actorId / hash 的固定盐 | **未设则每次启动随机**（生产必须固定；否则 actorId 不跨重启稳定） |
| `COOKIE_SECURE` | cookie 是否带 `Secure`（本地 http 需设 `false`） | `true` |
| `ALLOWED_ORIGINS` | 允许的 Origin（逗号分隔，CSRF 校验用） | `http://127.0.0.1:{PORT}` 等 |
| `SESSION_TTL_SECONDS` | 会话有效期 | `28800`（8h） |
| `BFF_HOST` / `BFF_PORT` | 监听地址 | `127.0.0.1` / `3090` |
| `DSH_WEB_URL` | 静态 UI 源（`dsh web`） | `http://127.0.0.1:3080` |

所需 IAM（本机实例角色 / 上云 ECS task role）：`bedrock-agentcore:InvokeAgentRuntime`
（限本 Runtime ARN）、`secretsmanager:GetSecretValue`（限本项目 secret）、
`dynamodb:GetItem/PutItem/Query/UpdateItem`（限 Session Directory 表）。

## 本地对云验证

```bash
# 资源在 us-west-2；本机 shell 的 AWS_REGION 可能是别的区，脚本已固定 us-west-2。
cd web-bff
npm install                 # 首次
node cloud_smoke.mjs        # 起 BFF -> 未登录被拒 -> alice 登录 -> 云端回复 -> bob 越权被拒
```

`cloud_smoke.mjs` 自起 BFF、无需浏览器、无需本地 adapter（改调云端 Runtime）。
可选真浏览器：`COOKIE_SECURE=false` 起 BFF + `dsh web`(:3080)，再跑 `browser_smoke.mjs`。

## 容器化（Dockerfile；本步只备好，不 build/deploy）

`Dockerfile` 基于 `public.ecr.aws` node:22-slim（ARM64），单容器内跑 `dsh web`(:3080 静态源) +
BFF(:3090)，BFF 反代 UI 资源。构建前需由部署步骤把 DSH web 静态闭包 stage 到
`.build/dsh-web/`（pnpm-deploy 闭包，其 bin 可跑 `dsh web`；对应现有
`../scripts/build-image.sh` 与 `../.build/dsh-runtime` 的约定）。镜像不含任何密钥。

## 关于 web-bff/static/（gitignored）

`web-bff/static/` 是 DSH Web UI 一次性渲染出的闭包（index.html 含 `window.__DSH_BOOT__`
+ dist assets + 38 个 `/plugins/<id>/client.js`，约 15M / 152 文件），是**派生产物、不入 git**。
镜像构建（`web-bff/Dockerfile`）会 `COPY static/`。

**再生（脚本化）**：用 `web-bff/capture-static.mjs`。它自动起一次 `dsh web`（源码方式，
指向 DSH 仓库）、等就绪、解析 `GET /` 注入的 `window.__DSH_BOOT__` 插件清单，跟随 index.html
与 JS/CSS 里的引用（`/assets/**` 含 dist/fonts/langs、sourceMappingURL）以及每个
`/plugins/<id>/client.js` 全量下载落盘，最后自验证（index 含 `__DSH_BOOT__`、38 个插件
client.js 齐全、重新起静态服务 0 个 404）。

```bash
# 需 DSH monorepo 已 pnpm run build。默认 OUT_DIR=web-bff/static、PORT=3080。
DSH_REPO_ROOT=/path/to/deepseek-harness node web-bff/capture-static.mjs

# 对着一台已在跑的 dsh web 抓取（跳过自起）：
BASE_URL=http://127.0.0.1:3080 node web-bff/capture-static.mjs

# 与已有闭包做文件集比对（回归校验）：
DSH_REPO_ROOT=/path/to/deepseek-harness REFERENCE_DIR=./web-bff/static \
  OUT_DIR=/tmp/static-new node web-bff/capture-static.mjs
```

环境变量：`DSH_REPO_ROOT`（自起模式必填）、`PORT`(3080)、`OUT_DIR`(默认 `web-bff/static`)、
`BASE_URL`（给已在跑的 dsh web 则不自起）、`DSH_WEB_CMD`（自起命令，默认 `pnpm dsh web --port {PORT}`，
`{PORT}` 会被替换）、`READY_TIMEOUT_MS`(90000)、`REFERENCE_DIR`（可选比对基准）。
部署时 `scripts/deploy-web.sh` 会在构建 BFF 镜像前按需自动调用它（见 `docs/DEPLOY.md`）。
