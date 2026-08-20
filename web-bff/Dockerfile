# Production BFF image for the DeepSeek Harness (DSH) Web UI.
#
# One process serves everything the browser needs:
#   - the BFF on 0.0.0.0:3090 -> Cognito login, /api/*, mux/host WebSockets,
#     SigV4 InvokeAgentRuntime to the CLOUD AgentCore Runtime, and the DSH Web
#     UI as a BAKED static closure (static/): index.html carries the injected
#     window.__DSH_BOOT__ manifest; static/assets/* and static/plugins/<id>/
#     client.js are the captured client bundles. No co-located `dsh web`
#     process and no DSH monorepo in the image.
#
# The agent does NOT run here (it runs in the cloud Runtime). No AWS secrets are
# baked in: cookie/HMAC/origin-verify secrets and Cognito client secret are read
# from env / ECS secrets / Secrets Manager at start (see README).
#
# Build context is this web-bff/ directory. ARM64 (Fargate Graviton). ECR Public
# base avoids Docker Hub rate limits.
#   docker build --platform linux/arm64 -t dsh-bff .
FROM public.ecr.aws/docker/library/node:22-slim

WORKDIR /app

# BFF runtime deps only (playwright-core is a devDependency, skipped here).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.mjs ./
# Baked DSH Web UI static closure (captured once from `dsh web`).
COPY static/ ./static/

ENV AWS_REGION=us-west-2 \
    AWS_DEFAULT_REGION=us-west-2 \
    BFF_HOST=0.0.0.0 \
    BFF_PORT=3090 \
    STATIC_DIR=/app/static \
    COOKIE_SECURE=true

EXPOSE 3090

# PID 1 is node so SIGTERM from ECS reaches the server directly.
CMD ["node", "/app/server.mjs"]
