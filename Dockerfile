# Self-contained AgentCore Runtime container for the DeepSeek Harness coding agent.
#
# The image bakes in a prebuilt DSH Node runtime closure (bundled mode): the
# packaged-bin entry resolves bare @deepseek-ai/dsh-* plugin names from its own
# node_modules, so NO bind mount or repo checkout is needed at run time. The
# adapter (Python) lazily launches that Node runtime, which talks to Bedrock.
#
# Build context inputs are staged by scripts/build-image.sh:
#   .build/dsh-runtime/  the Node runtime closure (pnpm-deploy of dsh-jsonrpc-agent-pkg)
#   .build/dsh-sdk/src/   the Python SDK (deepseek_harness; pydantic-only, not on PyPI)
#
# Base is Node (the DSH runtime needs Node >=22.19); Python is added for the
# adapter. ECR Public base avoids Docker Hub rate limits. ARM64 required.
FROM public.ecr.aws/docker/library/node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv git bash ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY runtime/requirements.txt /app/requirements.txt
RUN pip3 install --break-system-packages --no-cache-dir -r /app/requirements.txt

COPY runtime/ /app/runtime/
COPY config/ /app/config/

# Python SDK (not published to PyPI) + the self-contained Node runtime closure.
COPY .build/dsh-sdk/src/ /app/dsh-sdk/src/
COPY .build/dsh-runtime/ /app/dsh-runtime/

# Bundled mode: no repo mount. DSH_BUNDLED_RUNTIME defaults (in dsh_client.py)
# to the packaged-bin path below; DSH_RUNTIME_MODE=bundled makes the choice
# explicit so a missing closure fails loud instead of silently trying source.
ENV DSH_RUNTIME_MODE=bundled \
    PYTHONPATH=/app/dsh-sdk/src:/app/runtime \
    AWS_REGION=us-west-2 \
    AWS_DEFAULT_REGION=us-west-2 \
    PYTHONUNBUFFERED=1

EXPOSE 8080

# BedrockAgentCoreApp serves the AgentCore contract (/ping + /invocations) on 8080.
CMD ["python3", "/app/runtime/app.py"]
