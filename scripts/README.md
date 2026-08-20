# 部署脚本（云端复现）

这些脚本把 `config/deployment-env.md` 记录的实际架构参数化为可复现的部署流程：
AgentCore Runtime（VPC 模式，无公网出站）+ Web BFF（CloudFront → ALB → ECS Fargate，
Cognito 登录，SigV4 调 Runtime）。

> 脚本**只做部署动作**；仓库里跟踪的文件不含任何真实账号/VPC/ARN/密钥——真实值放在
> gitignored 的 `scripts/deploy.env`（或环境变量）里。

## 文件

| 文件 | 作用 |
|---|---|
| `deploy.env.example` | 所有可配置参数样例（占位符）。拷成 `scripts/deploy.env` 填真实值。 |
| `build-image.sh` | 构建自包含 ARM64 Runtime 镜像（已有；被 `deploy-runtime.sh` 调用）。 |
| `run-local.sh` | Phase-1 本地容器化运行（已有）。 |
| `deploy-runtime.sh` | 部署 AgentCore Runtime（ECR/执行角色/VPC/create-agent-runtime/轮询/可选冒烟）。 |
| `deploy-web.sh` | 部署 Web 层（Cognito/DynamoDB/Secrets/BFF 镜像/IAM/ECS/ALB/CloudFront）。 |
| `teardown.sh` | 回收本项目按命名前缀创建的资源（谨慎，不可逆）。 |

## 前置

1. AWS 凭证已配置（`aws sts get-caller-identity` 可用），有创建上述资源的权限。
2. 目标区已**开通模型访问**（`us.openai.gpt-5.6-sol` inference profile 可用）。
3. Docker 可构建 `linux/arm64`（buildx / binfmt）。
4. DSH monorepo 已 checkout 并 `pnpm run build`（`DSH_REPO_ROOT` 指向它）——Runtime 镜像
   与 DSH Web 静态闭包捕获都需要。
5. `web-bff/static/`（gitignored 的 DSH web 闭包）——BFF 镜像需要。**无需手动再生**：
   `deploy-web.sh` 在构建 BFF 镜像前，若该目录缺失或 `CAPTURE_STATIC=true`，会自动调用
   `node web-bff/capture-static.mjs`（读 `DSH_REPO_ROOT`）从 `dsh web` 捕获。也可手动跑：
   `DSH_REPO_ROOT=<dsh> node web-bff/capture-static.mjs`。
6. 配置：`cp scripts/deploy.env.example scripts/deploy.env` 后填真实值（`deploy.env` 已 gitignore）。

## 部署顺序

```bash
# 1) Runtime 先行（Web 依赖它的 ARN）
bash scripts/deploy-runtime.sh
#   末尾打印 RUNTIME_ARN；把它写进 deploy.env 的 RUNTIME_ARN，或 export 后再跑下一步。
SMOKE=true bash scripts/deploy-runtime.sh   # 可选：带 invoke 冒烟

# 2) Web 层（读取 RUNTIME_ARN）
export RUNTIME_ARN="arn:aws:bedrock-agentcore:...:runtime/<id>"
bash scripts/deploy-web.sh
#   末尾打印公网 CloudFront URL；测试用户密码只存 Secrets Manager，不打印。
```

### 各脚本产出

- **deploy-runtime.sh** → ECR 仓库、最小权限执行角色、（复用或新建的）VPC 网络、
  `READY` 的 AgentCore Runtime，打印 `RUNTIME_ID` / `RUNTIME_ARN`。
- **deploy-web.sh** → （必要时先 `capture-static.mjs` 捕获 DSH Web 静态闭包）、
  Cognito 池+机密客户端（secret 入 Secrets Manager）、测试用户
  （密码入 Secrets Manager）、DynamoDB 会话目录表、BFF 三个密钥、BFF 镜像、
  BFF 任务/执行角色、ECS 集群+任务定义+服务、ALB+TG+监听器、CloudFront，
  打印公网 URL。

## 幂等与非幂等

- 幂等（先探测后创建 / 覆盖）：ECR 仓库、IAM 角色与内联策略、DynamoDB 表、
  Secrets（`put-secret-value`）、ECS 集群/服务（存在则 `update-service`）、
  日志组、安全组（按名探测）、ALB/TG/监听器（按名/端口探测）、Runtime（存在则
  `update-agent-runtime` 全量重发）。
- **非幂等**（脚本按名/comment 探测，命中则复用，否则新建一个）：Cognito User Pool、
  CloudFront distribution。重复跑要留意别造出重复资源。

## 关键设计约束（务必保持）

- Runtime 走 **VPC 模式、无 NAT/无 IGW**，出站仅 VPC 端点 + S3 前缀列表；执行角色
  `bedrock:InvokeModel*` 精确到 4 个 ARN（inference-profile + 3 region foundation-model），
  无通配。
- ALB 入站仅 CloudFront 托管前缀列表；ECS SG 仅允许 ALB SG；CloudFront 是唯一公网入口
  （HTTPS-only，带 `X-Origin-Verify` 自定义头）。
- 全部密钥/密码只在 Secrets Manager，绝不入镜像/git。
- IAM 无 `Resource:"*"`（唯一例外 `ecr:GetAuthorizationToken`）、无通配 action。

## 回收

```bash
CONFIRM=yes bash scripts/teardown.sh
```

只删本项目命名前缀的资源；**不删** Runtime 复用的 VPC/子网/端点，也不删他人资源。
CloudFront 删除需先 disable 再等 `Deployed` 才能 delete，脚本给出手动步骤而非长时间阻塞。
若 `REUSE_RUNTIME_VPC=false` 新建过专用 VPC，确认归属后手动删其端点/SG/子网/VPC。
