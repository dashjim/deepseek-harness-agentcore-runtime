# CLAUDE.md — DeepSeek Harness on AgentCore Runtime

Project-specific guidance for working in this repo. Hosts the DeepSeek Harness (DSH) coding
agent on Amazon Bedrock AgentCore Runtime, with a Node BFF fronting DSH's Web UI.

## Hard rules (do not violate)

1. **Never modify the DSH upstream checkout.** All integration is out-of-tree: the Python
   adapter (`runtime/`), the custom cordis config (`config/cordis.bedrock.yml`), and the BFF
   (`web-bff/`). After any task, the DSH repo's `git status` must be clean.
2. **No secrets in git or image layers.** Client secret, test passwords, cookie/HMAC/origin-verify
   secrets live only in AWS Secrets Manager and are injected as env at deploy time. Real
   deployment IDs live only in the gitignored `config/deployment-env.md` — the tracked files use
   `<PLACEHOLDER>` tokens (account, VPC/subnet/SG, ARNs, URLs, Cognito pool/client). Keep it that way.
3. **No `0.0.0.0/0` and no public exposure.** CloudFront is the only public entry (HTTPS-only);
   ALB inbound = CloudFront prefix list only; ECS SG admits only the ALB; the Runtime VPC has
   no NAT/IGW (only VPC endpoints). IAM is least-privilege — Bedrock invoke scoped to the model
   ARNs, no wildcard actions, no `Resource:"*"` (except `ecr:GetAuthorizationToken`).
4. **Verify against the real trigger, not a proxy for it.** (Bug learned the hard way: the
   session-export download button probes with **HEAD** then GET; testing only GET missed the 404.)

## Layout

- `runtime/app.py` — AgentCore contract (`/ping`, blocking `/invocations`). Lazy singleton init.
- `runtime/dsh_client.py` — launches DSH. Two modes via `DSH_RUNTIME_MODE`: `bundled` (baked closure,
  cloud) / `source` (bind-mounted repo, local dev). Auto-detects.
- `Dockerfile` + `scripts/build-image.sh` — self-contained ARM64 Runtime image.
- `web-bff/server.mjs` — the BFF: Cognito login, Session Directory (DynamoDB), SigV4→Runtime,
  DSH `/api/*` + two downlink WebSockets, baked static UI. `web-bff/README.md` lists required env.
- `web-bff/static/` — **gitignored** derived DSH web closure (regenerate per `web-bff/README.md`).
- `docs/` — design review, deviations, auth design, phase evidence.

## Key gotchas (verified, non-obvious)

- **DSH runtime is not shipped as a binary.** Zero-config `DeepSeekHarness()` fails; use the
  bundled closure (`pnpm deploy` of `dsh-jsonrpc-agent-pkg`, baked into the image) or source mode.
- **pi-ai (Bedrock provider) does not probe IMDS.** The adapter freezes ambient AWS creds via boto3
  and injects them as env into the DSH subprocess. (Long sessions >1h would need cred refresh — a
  documented follow-up.)
- **DSH web boot contract** (what the UI needs to connect): `host.describe` gates the connection;
  then `workspace.list` (ISO-string timestamps) + `session.list`; `session.models` must return
  `routable:true`; `settings.describe` must pre-ack the onboarding notice. The assistant text
  renders only if the `assistant/message` event carries `surfaceOp:"append"` as a **top-level**
  field (sibling of `data`), with text at `event.data.message.content[].text`.
- **Downlink WebSockets** need a server-side keepalive **ping (~25s)**: the ALB idle timeout (60s)
  otherwise drops idle sockets and the client loops on "connection lost".
- **`update-agent-runtime` / ECS task-def updates are full-replace** — always resend the complete
  env + secrets + roles + network, or you silently wipe them.
- **AgentCore Runtime name** must match `^[a-zA-Z][a-zA-Z0-9_]{0,47}$` (underscores, not hyphens).

## Environment

Region `us-west-2`. Model `us.openai.gpt-5.6-sol` (inference profile; provider `amazon-bedrock`
via DSH `dsh-llm-pi-ai`). Runtime networkMode VPC. BFF on ECS Fargate (arm64).

## Behavioral defaults

- Surgical changes; match existing style; every changed line traces to the request.
- Prefer real end-to-end verification (deploy + browser) over local-only claims; state failures plainly.
- Docs in Chinese are fine; code and identifiers stay in English.
