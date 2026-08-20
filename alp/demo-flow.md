# 演示流程：DeepSeek Harness on AgentCore Runtime

预计 3-5 分钟。演示"多用户云端编码 Agent + 保留 DSH Web 界面 + 每用户隔离"。

## 前置
- 公网地址：https://<CLOUDFRONT_DOMAIN>
- 测试账号：`alice@dsh-agentcore.test`（密码见 Secrets Manager `dsh-agentcore/test-users`）。可选第二账号 `bob@dsh-agentcore.test` 演示隔离。

## 步骤

1. **打开公网地址** → 未登录会被重定向到 `/login`（演示"默认拒绝、必须登录"）。
2. **用 alice 登录** → BFF 服务端走 Cognito USER_PASSWORD_AUTH，签发 HttpOnly 会话 cookie（浏览器不持 JWT）。进入 DSH Web 界面（左侧 workspaces、Chat 面板）。
3. **发一个编码指令**，例如：`Use the bash tool to run: echo hello && ls, and summarize.`
   - 观察：DSH Web 界面显示助手回复；底部模型为 `us.openai.gpt-5.6-sol`；`N turns · N steps · LLM …s`。
   - 讲解：这句话经 CloudFront→ALB→BFF→（SigV4）AgentCore Runtime→DSH→Bedrock，bash 工具在云端每用户 microVM 里真实执行。
4. **（可选）隔离演示**：拿到 alice 的 workspaceId 后，用 bob 登录并尝试用该 workspaceId 操作 → 返回 403（Session Directory 归属校验，防 IDOR）。
5. **（可选）安全讲解**：Runtime 在 VPC 无公网/无任意出站；ALB 入站仅 CloudFront 前缀列表；IAM 最小权限（Bedrock invoke 精确到模型 ARN）。

## 截图
- `screenshots/cloud-03-reply.png`：登录后发 prompt，云端回复 `web-cloud-e2e-ok` 渲染在 DSH Web 界面。

## 备注
- 首次进入可能出现 DSH 的 "Internal Testing Notice" 提示，点 "Continue" 一次即可。
- 冷启动首条消息触发 microVM 创建，稍慢；之后同用户会话粘性到同一 microVM。
