#!/usr/bin/env bash
# Build a SELF-CONTAINED ARM64 image for the DeepSeek Harness AgentCore runtime.
#
# "Self-contained" = the image carries a prebuilt DSH Node runtime closure and
# the Python SDK; `docker run` needs no bind mount, only AWS credential env vars.
#
# Two build-time inputs come from the host DSH checkout (analogous to a CodeBuild
# source checkout), staged into the Docker build context under .build/:
#   .build/dsh-runtime/  the Node runtime closure (packaged-bin + node_modules)
#   .build/dsh-sdk/       the Python SDK source (deepseek_harness, pydantic-only)
# The closure is produced by `pnpm deploy` of the dsh-jsonrpc-agent-pkg deploy
# root — the same node carrier the Python SDK's runtime-bin package is built
# around — then flattened (legacy-hoist restore + symlink materialization) so it
# copies cleanly into an image with no external symlinks.
#
# The host DSH checkout must already be built (lib/ present); this script never
# modifies it (deploy reads the workspace and writes only to .build/).
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_REPO="${DSH_REPO_ROOT:-/home/ubuntu/g-repo/dsh/deepseek-harness}"
IMAGE_TAG="${IMAGE_TAG:-dsh-agentcore-runtime:selfcontained}"
BUILD_DIR="${PROJECT_ROOT}/.build"
CLOSURE_DIR="${BUILD_DIR}/dsh-runtime"
SDK_DIR="${BUILD_DIR}/dsh-sdk"
DEPLOY_ROOT_PKG="dsh-jsonrpc-agent-pkg"
ENTRY_REL="node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js"

echo "== disk before =="; df -h / | tail -1

# --- 0. Preconditions --------------------------------------------------------
[ -d "${DSH_REPO}" ] || { echo "ERROR: DSH repo not found at ${DSH_REPO} (set DSH_REPO_ROOT)"; exit 1; }
[ -f "${DSH_REPO}/packages/examples/jsonrpc-demo/lib/packaged-bin.js" ] \
  || { echo "ERROR: DSH repo is not built (no packaged-bin.js in lib/). Run 'pnpm run build' in ${DSH_REPO}."; exit 1; }

# --- 1. Deploy the runtime closure into the build context --------------------
echo "== pnpm deploy runtime closure =="
rm -rf "${CLOSURE_DIR}"
( cd "${DSH_REPO}" && pnpm --filter "${DEPLOY_ROOT_PKG}" deploy \
    --legacy --prod \
    --config.node-linker=hoisted \
    --config.auto-install-peers=false \
    --config.link-workspace-packages=true \
    "${CLOSURE_DIR}" )

# --- 2. Restore direct deps the legacy hoister left in the deploy source -----
# pnpm's --legacy deploy hoists some direct dependencies beside the deploy-root
# package (python/sdk-runtime/node_modules) instead of into the target; copy
# every manifest dependency missing from the closure top-level (matching the
# repo's own scripts/build-exe-for-python-sdk.ts restoreLegacyHoists step).
echo "== restore legacy-hoisted direct deps =="
DSH_REPO="${DSH_REPO}" CLOSURE_DIR="${CLOSURE_DIR}" python3 - <<'PY'
import json, os, shutil
from pathlib import Path
repo = Path(os.environ["DSH_REPO"])
staging = Path(os.environ["CLOSURE_DIR"])
src_nm = repo / "python/sdk-runtime/node_modules"
manifest = json.loads((repo / "python/sdk-runtime/package.json").read_text())
deps = sorted((manifest.get("dependencies") or {}).keys())
restored, missing = [], []
for dep in deps:
    dest = staging / "node_modules" / dep
    if dest.exists():
        continue
    source = src_nm / dep
    if not source.exists():
        missing.append(dep); continue
    dest.parent.mkdir(parents=True, exist_ok=True)
    def ignore(d, names):
        return {"node_modules"} & set(names) if Path(d) == source else set()
    shutil.copytree(source, dest, symlinks=False, ignore=ignore)
    restored.append(dep)
if missing:
    raise SystemExit(f"ERROR: manifest deps missing from both closure and deploy source: {missing}")
print(f"restored {len(restored)} legacy-hoisted deps")
PY

# --- 3. Materialize any symlinks pointing outside the closure ----------------
# Vendored workspace packages (schemastery, cosmokit) deploy as symlinks into
# the DSH repo; replace them with real copies so the closure is self-contained.
echo "== materialize external symlinks =="
CLOSURE_DIR="${CLOSURE_DIR}" python3 - <<'PY'
import os
from pathlib import Path
import shutil
root = Path(os.environ["CLOSURE_DIR"]).resolve()
fixed = []
for link in root.rglob("*"):
    if not link.is_symlink():
        continue
    target = link.resolve()
    if str(target).startswith(str(root) + os.sep):
        continue  # internal link (e.g. .bin/*) — fine
    if not target.exists():
        raise SystemExit(f"ERROR: dangling external symlink {link} -> {target}")
    link.unlink()
    if target.is_dir():
        shutil.copytree(target, link, symlinks=False)
    else:
        shutil.copy2(target, link)
    fixed.append(str(link.relative_to(root)))
print(f"materialized {len(fixed)} external symlinks: {fixed}")
PY

[ -f "${CLOSURE_DIR}/${ENTRY_REL}" ] || { echo "ERROR: closure missing entry ${ENTRY_REL}"; exit 1; }
echo "closure size: $(du -sh "${CLOSURE_DIR}" | cut -f1)"

# --- 4. Stage the Python SDK source (not published to PyPI) ------------------
echo "== stage Python SDK =="
rm -rf "${SDK_DIR}"
mkdir -p "${SDK_DIR}"
cp -r "${DSH_REPO}/python/sdk/src" "${SDK_DIR}/src"

# --- 5. Build the image ------------------------------------------------------
echo "== docker build (linux/arm64) =="
docker build --platform linux/arm64 -t "${IMAGE_TAG}" "${PROJECT_ROOT}"

echo "== disk after =="; df -h / | tail -1
echo "== image =="; docker image ls "${IMAGE_TAG}" --format '{{.Repository}}:{{.Tag}}  {{.Size}}'
echo "Built ${IMAGE_TAG}"
