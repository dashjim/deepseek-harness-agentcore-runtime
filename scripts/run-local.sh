#!/usr/bin/env bash
# Phase-1 local containerized run: build the ARM64 image and run it locally with
# the DSH monorepo bind-mounted and AWS credentials frozen from the ambient chain
# (instance role) into the container env. Nothing is written to disk or git.
#
# Usage: scripts/run-local.sh   (from the project root)
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DSH_REPO_ROOT="${DSH_REPO_ROOT:-/home/ubuntu/g-repo/dsh/deepseek-harness}"
IMAGE="dsh-agentcore:local"
REGION="us-west-2"

echo ">> building ARM64 image ${IMAGE}"
docker build --platform linux/arm64 -t "${IMAGE}" "${PROJECT_ROOT}"

echo ">> freezing AWS credentials from the ambient chain"
eval "$(python3 - <<'PY'
import boto3
c = boto3.Session(region_name="us-west-2").get_credentials().get_frozen_credentials()
print(f'export AWS_ACCESS_KEY_ID={c.access_key}')
print(f'export AWS_SECRET_ACCESS_KEY={c.secret_key}')
if c.token:
    print(f'export AWS_SESSION_TOKEN={c.token}')
PY
)"

echo ">> running container on :8080 (DSH mounted at /dsh)"
docker rm -f dsh-agentcore-local >/dev/null 2>&1 || true
docker run -d --name dsh-agentcore-local -p 8080:8080 \
  -v "${DSH_REPO_ROOT}:/dsh" \
  -e AWS_REGION="${REGION}" -e AWS_DEFAULT_REGION="${REGION}" \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
  "${IMAGE}"

echo ">> container id:"; docker ps --filter name=dsh-agentcore-local --format '{{.ID}} {{.Status}}'
