# 部署手册（端到端）

把 DeepSeek Harness (DSH) 托管为 Amazon Bedrock AgentCore Runtime 上的多用户云端 Coding Agent 的
可复现部署流程：**Runtime（Agent 平面，VPC 模式无公网出站）** + **Web BFF（Web 平面，
CloudFront → ALB → ECS Fargate，Cognito 登录，SigV4 调 Runtime）**。

> 本仓库跟踪的文件不含任何真实账号/VPC/子网/SG/ARN/CloudFront 域名/Cognito 池/密钥；一律用
> `<占位符>`。真实值只放在 gitignored 的 `scripts/deploy.env`（或环境变量）与 AWS Secrets Manager。
> 本文所有 ID 均为占位示例。

关联文档：架构与设计 `docs/design-deepseek-harness-agentcore-runtime.md`、认证设计
`docs/auth-design.md`、脚本说明 `scripts/README.md`、BFF 与静态闭包 `web-bff/README.md`。

---

## 0. 前置

1. **AWS 凭证**：`aws sts get-caller-identity` 可用，且有创建 ECR / IAM / VPC 端点 / AgentCore /
   Cognito / DynamoDB / Secrets Manager / ECS / ELBv2 / CloudFront 的权限。资源区固定 `us-west-2`
   （脚本内已固定；本机 shell 的默认区可为其它）。
2. **开通模型访问**：目标区已开通 `us.openai.gpt-5.6-sol` inference profile（跨区 `us.` profile 会
   路由到 us-east-1 / us-east-2 / us-west-2 三个 region 的 foundation model）。
3. **Docker 可构建 `linux/arm64`**（Fargate Graviton）：已装 buildx / binfmt。
4. **DSH monorepo 已构建**：`git clone` DSH 后 `pnpm install && pnpm run build`；`DSH_REPO_ROOT`
   指向它。Runtime 镜像的运行闭包与 DSH Web 静态闭包捕获都依赖它。
5. **配置**：`cp scripts/deploy.env.example scripts/deploy.env`，填入真实值（`scripts/deploy.env`
   已 gitignore）。至少要填：`ACCOUNT_ID`、VPC/子网/SG（Runtime 与 Web 两套）、
   `S3_PREFIX_LIST_ID`、`CLOUDFRONT_PREFIX_LIST_ID`、`DSH_REPO_ROOT`、各命名前缀。

前缀列表查法（不要写 `0.0.0.0/0`）：
```bash
# Runtime 路由表用的 S3 网关端点前缀列表（让 ECR 经 S3 拉层，无需公网路由）
aws ec2 describe-prefix-lists --region us-west-2 \
  --filters Name=prefix-list-name,Values=com.amazonaws.us-west-2.s3
# ALB 入站只放行 CloudFront 的源站前缀列表
aws ec2 describe-managed-prefix-lists --region us-west-2 \
  --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing
```

---

## Step 0（新增）· 捕获 DSH Web 静态闭包

BFF 镜像把 DSH Web UI 以**烘焙静态**方式内置在 `web-bff/static/`（`Dockerfile` 里
`COPY static/ ./static/`）。这是**派生产物、gitignored**（约 15M / 152 文件：`index.html`
含注入的 `window.__DSH_BOOT__`、`assets/**` 的 dist/fonts/langs、以及 38 个
`plugins/<id>/client.js`）。clone 后该目录不存在，必须先从 `dsh web` 捕获。

用 `web-bff/capture-static.mjs`（Node 脚本，无第三方依赖）：

```bash
# 自起 dsh web（源码方式，指向 DSH 仓库）、抓取、落盘到 web-bff/static、并自验证。
DSH_REPO_ROOT=/path/to/deepseek-harness node web-bff/capture-static.mjs
```

脚本做了什么：自起 `dsh web`（默认命令 `pnpm dsh web --port {PORT}`，`{PORT}` 会被替换；可用
`DSH_WEB_CMD` 覆盖）→ 等 `GET /` 就绪 → 解析注入的 `window.__DSH_BOOT__` 得到 38 个 client 插件
清单 → 跟随 index.html 与 JS/CSS 里的引用（`/assets/**`、`./langs/*`、KaTeX `fonts/*`、
`sourceMappingURL`）以及每个 `/plugins/<id>/client.js` 全量下载 → **幂等**（先清空 OUT_DIR）→
**自验证**（index 含 `__DSH_BOOT__`、38 个插件 client.js 齐全非空、index 引用的 asset 都在、
起临时静态服务重放 0 个 404）。可选的 sourcemap（如插件 `client.js.map`）若 host 不提供则跳过、
不算失败。

常用变量：`DSH_REPO_ROOT`（自起模式必填）、`PORT`(3080)、`OUT_DIR`(默认 `web-bff/static`)、
`BASE_URL`（给一台已在跑的 dsh web 则不自起）、`DSH_WEB_CMD`、`READY_TIMEOUT_MS`(90000)、
`REFERENCE_DIR`（可选：与既有闭包做文件集比对，回归校验）。

> **注意**：起 `dsh web` 走的是 DSH 的默认 profile，会加载 `dsh-llm-pi-ai`（Bedrock provider）；
> 因此 DSH 仓库需已 `pnpm install`（否则该插件依赖缺失、host 加载失败）。**不要**把
> `DSH_TOOLS_MODE` 设为空串（会触发插件加载失败）；不设即可。

**通常不必手动跑**：`scripts/deploy-web.sh` 在构建 BFF 镜像前，若 `web-bff/static/` 缺失或
`CAPTURE_STATIC=true`，会自动调用本脚本（读 `deploy.env` 里的 `DSH_REPO_ROOT`）。手动跑一次便于
先验证闭包无缺失。

---

## Step 1 · 构建并推送 Runtime 镜像 + 部署 AgentCore Runtime

```bash
# 自包含 ARM64 Runtime 镜像（烘焙 DSH 运行闭包）；被 deploy-runtime.sh 调用，也可单独跑。
bash scripts/build-image.sh

# 部署 Runtime：ECR 仓库、最小权限执行角色、（复用或新建的）VPC 网络、create-agent-runtime、
# 轮询到 READY，打印 RUNTIME_ID / RUNTIME_ARN。
bash scripts/deploy-runtime.sh
SMOKE=true bash scripts/deploy-runtime.sh   # 可选：带一次 InvokeAgentRuntime 冒烟
```

产出末尾会打印 `RUNTIME_ARN`。把它写进 `scripts/deploy.env` 的 `RUNTIME_ARN`，或 export 后再进
Step 2：

```bash
export RUNTIME_ARN="arn:aws:bedrock-agentcore:us-west-2:<ACCOUNT_ID>:runtime/<runtime-id>"
```

关键约束：Runtime 走 **VPC 模式、无 NAT / 无 IGW**，出站仅 VPC 接口端点 + S3 网关端点前缀列表；
执行角色 `bedrock:InvokeModel*` 精确到 4 个 ARN（inference-profile + 3 个 region 的
foundation-model），无通配。Runtime 名须匹配 `^[a-zA-Z][a-zA-Z0-9_]{0,47}$`（用下划线、不能连字符）。

---

## Step 2 · 部署 Web 层（含静态捕获 + BFF 镜像构建）

```bash
bash scripts/deploy-web.sh
# 或强制重新烘焙静态闭包：
CAPTURE_STATIC=true bash scripts/deploy-web.sh
```

`deploy-web.sh` 顺序（幂等处按名/ARN 探测后创建；见 `scripts/README.md`）：

1. Cognito User Pool + 机密 app client（`USER_PASSWORD_AUTH` + `REFRESH`），client secret → Secrets Manager。
2. 测试用户（密码随机生成、**只**入 Secrets Manager、绝不打印）。
3. DynamoDB Session Directory 表（PK/SK String，PAY_PER_REQUEST）。
4. BFF 三个密钥（session-cookie / memory-key / origin-verify）→ Secrets Manager。
5. **静态闭包**：若 `web-bff/static/` 缺失或 `CAPTURE_STATIC=true`，调用
   `node web-bff/capture-static.mjs`（读 `DSH_REPO_ROOT`）；随后 ECR 登录 + `docker build --platform
   linux/arm64` + push BFF 镜像。**缺失且未设 `DSH_REPO_ROOT` 会报错停**并给出手动捕获指引。
6. 最小权限任务角色（`InvokeAgentRuntime` 限本 Runtime + endpoint、DynamoDB 限本表）与执行角色
   （ECR 拉取限本仓库、日志限本组、Secrets 限这 4 个 secret）。
7. ECS 集群 + 日志组。
8. 安全组 + ALB + 目标组（健康检查 `/healthz`）+ 监听器：ALB 入站仅 CloudFront 前缀列表；
   ECS SG 仅允许 ALB SG。
9. CloudFront（源站 = ALB HTTP-only + `X-Origin-Verify` 自定义头；viewer 强制 HTTPS；禁用缓存；
   全量转发）。
10. ECS 任务定义（arm64，env + secret 引用，`ALLOWED_ORIGINS` = CloudFront URL）+ 服务
    （私有子网、ECS SG、挂到目标组）。

末尾打印公网 CloudFront URL、Cognito 池/客户端 ID、ALB DNS。测试用户密码只在 Secrets Manager。

---

## Step 3 · 线上验证（对 CloudFront URL）

拿到 Step 2 的 `${CLOUDFRONT_URL}`，取一个测试用户密码：

```bash
aws secretsmanager get-secret-value --region us-west-2 \
  --secret-id dsh-agentcore/test-users --query SecretString --output text
```

逐项验证：

1. **登录**：浏览器开 `${CLOUDFRONT_URL}` → 未登录被 302 到 `/login` → 用测试用户登录 → 拿到
   `Secure + HttpOnly` 的 `dsh_sess` cookie（浏览器不持 JWT）。
2. **发消息**：新建会话，发一条如「用 bash 跑 `echo hello`，报告输出」→ 应看到助手回复渲染在
   会话区（回复经 SigV4 InvokeAgentRuntime → 云端 micro-VM → Bedrock）。
3. **隔离（防 IDOR）**：用另一个用户（如 bob）登录，确认看不到、也无法访问前一个用户（alice）的
   workspace / 会话；服务端按「认证用户 + 公开 workspaceId」做 owner lookup，查不到即 403，
   绝不用 `runtimeSessionId` 反查。
4. **session.export**：在 UI 触发会话导出下载。**务必验证真实触发路径**：DSH 客户端先发 `HEAD`
   探测、再 `GET` 下载 `/api/session.export`——两者都要 200（只测 GET 会漏掉 HEAD 的 404，是
   踩过的坑）。

命令行快速探针（可选）：
```bash
curl -sS -o /dev/null -w "%{http_code}\n" "${CLOUDFRONT_URL}/healthz"   # 200
curl -sS -o /dev/null -w "%{http_code}\n" "${CLOUDFRONT_URL}/"          # 302 -> /login（未带 cookie）
```

---

## Step 4 · 回收

```bash
CONFIRM=yes bash scripts/teardown.sh
```

只删本项目按命名前缀创建的资源；**不删** Runtime 复用的 VPC/子网/端点，也不删他人资源。
CloudFront 删除需先 `disable` 再等到 `Deployed` 才能 `delete`，脚本给出手动步骤而非长时间阻塞。
若 `REUSE_RUNTIME_VPC=false` 曾新建过专用 VPC，确认归属后手动删其端点/SG/子网/VPC。

---

## 常见坑（务必留意）

- **Runtime VPC 无 NAT/IGW**：出站只有 VPC 接口端点 + **S3 网关端点前缀列表**（`S3_PREFIX_LIST_ID`）。
  漏了 S3 前缀列表，ECR 拉镜像层会失败。
- **ALB 60s 空闲超时 → WS keepalive**：两条下行 WebSocket（`/api/events.mux`、`/api/events.host`）
  需要服务端 **~25s 一次 ping**；否则 60s 无流量时 ALB 断连，客户端反复「connection lost」。BFF
  已内置该 keepalive。
- **更新是全量替换**：`update-agent-runtime` 与 ECS 任务定义更新都是 full-replace——每次都要重发
  完整的 env + secrets + roles + network，漏字段会静默清空（例如把 `ALLOWED_ORIGINS` / callback
  清掉导致鉴权失败）。
- **静态需重新烘焙**：DSH 前端一旦更新（`pnpm run build` 后 assets 哈希/插件清单变化），必须重跑
  `capture-static.mjs`（或 `CAPTURE_STATIC=true bash scripts/deploy-web.sh`）重新烘焙
  `web-bff/static/` 并重建 BFF 镜像；旧闭包与新协议不匹配会白屏/连不上。
- **Runtime 名规则**：`^[a-zA-Z][a-zA-Z0-9_]{0,47}$`（下划线，不能用连字符）。
- **pi-ai 不探 IMDS**：adapter 把 ambient AWS 凭证冻结成环境变量注入 DSH 子进程；>1h 长会话需
  凭证刷新（已知待办）。
- **Cognito app client 更新会覆盖字段**：改任一字段务必带齐要保留的所有参数（如 callback URL），
  否则被清空导致 redirect_mismatch。本 BFF 用 `USER_PASSWORD_AUTH`，不依赖 hosted-UI callback。
- **CloudFront 只允许经它进入**：ALB 校验 `X-Origin-Verify` 共享密钥；直连 ALB（不带头）返回 403。
  `/healthz` 是唯一不带该头、无需鉴权的路径（供 ALB 目标组探活）。
- **凭证/密钥不落盘、不进 git**：所有密钥/密码只在 Secrets Manager；`scripts/deploy.env`、
  `config/deployment-env.md`、`web-bff/static/` 均已 gitignore。

---

## 一句话流程

```
clone → pnpm build DSH → cp deploy.env.example deploy.env（填值）
      → (Step0 自动) capture-static.mjs 烘焙 web-bff/static
      → deploy-runtime.sh（拿 RUNTIME_ARN）
      → deploy-web.sh（捕获静态→建镜像→ECS/ALB/CloudFront）
      → 打开 CloudFront URL 验证（登录/发消息/隔离/session.export）
      → teardown.sh 回收
```
