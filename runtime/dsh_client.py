"""Run a DeepSeek Harness coding turn driven by Amazon Bedrock (GPT via pi-ai).

This wraps the DeepSeek Harness Python SDK and launches its JSON-RPC agent
runtime, pointing it at ``config/cordis.bedrock.yml``. That config selects the
``@deepseek-ai/dsh-llm-pi-ai`` adapter on its ``amazon-bedrock`` catalog route,
so the agent talks to Bedrock Converse Stream with SigV4 over the ambient AWS
credential chain (the EC2 instance role here).

Two launch modes, chosen by ``DSH_RUNTIME_MODE`` (auto-detected when unset):

- ``bundled`` (self-contained image): a prebuilt Node runtime *closure* baked
  into the image runs the ``packaged-bin.js`` entry, which resolves bare
  ``@deepseek-ai/dsh-*`` plugin names from its own ``node_modules``. No repo
  checkout or bind mount is needed. The closure is produced by ``pnpm deploy``
  of the ``dsh-jsonrpc-agent-pkg`` deploy root (see ``scripts/build-image.sh``).
- ``source`` (local dev, bind-mounted repo): launches the repo's JSON-RPC agent
  ``bin.ts`` through Node + tsx, resolving bare plugin names against the pnpm
  workspace ``node_modules`` (runtime cwd = repo root).

Auto-detection: ``bundled`` when the bundled entry exists, else ``source``.

Environment:
- ``DSH_RUNTIME_MODE`` — ``bundled`` | ``source`` (optional; auto-detected).
- ``DSH_BUNDLED_RUNTIME`` — path to the closure's ``packaged-bin.js`` (bundled
  mode; defaults to the in-image location).
- ``DSH_REPO_ROOT`` — the deepseek-harness checkout (source mode).
- AWS credentials resolvable by the AWS SDK default chain; region us-west-2.

The SDK itself is imported from ``<repo>/python/sdk/src`` (source mode) or from
the copy baked into the image (bundled mode); it needs only ``pydantic``.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

from deepseek_harness import DeepSeekHarness
from deepseek_harness.errors import JsonRpcError
from deepseek_harness.models import InitializeResponse, Notification

# --- Fixed deployment choices ------------------------------------------------

BEDROCK_REGION = "us-west-2"
PROVIDER = "amazon-bedrock"
MODEL = "us.openai.gpt-5.6-sol"

_PROJECT_ROOT = Path(__file__).resolve().parents[1]
_CORDIS_CONFIG = _PROJECT_ROOT / "config" / "cordis.bedrock.yml"
# Keep durable session logs inside this project, never in the DSH checkout
# (whose cwd is the runtime subprocess cwd, where ./.sessions would land).
_SESSION_ROOT = _PROJECT_ROOT / ".sessions"

# --- Runtime launch resolution (bundled vs source) ---------------------------

# Bundled mode: a self-contained Node runtime closure baked into the image. The
# packaged-bin entry resolves bare @deepseek-ai/dsh-* plugin names from its own
# node_modules, so no repo checkout is needed. Its cwd must be the closure root
# (the directory holding node_modules) for that bare-name resolution.
_BUNDLED_ENTRY = Path(
    os.environ.get(
        "DSH_BUNDLED_RUNTIME",
        "/app/dsh-runtime/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js",
    )
).resolve()

# Source mode: the DeepSeek Harness monorepo checkout (bind-mounted in local
# dev). Bare plugin names resolve against its pnpm workspace node_modules.
_DSH_REPO = Path(
    os.environ.get("DSH_REPO_ROOT", "/home/ubuntu/g-repo/dsh/deepseek-harness")
).resolve()
_SOURCE_ENTRY = _DSH_REPO / "packages/examples/jsonrpc-demo/src/bin.ts"


def _resolve_launch() -> tuple[str, tuple[str, ...]]:
    """Return ``(runtime_cwd, launch_argv)`` for the selected runtime mode.

    Mode selection: explicit ``DSH_RUNTIME_MODE`` (``bundled`` | ``source``)
    wins; otherwise ``bundled`` when its entry exists, else ``source``.
    """
    mode = os.environ.get("DSH_RUNTIME_MODE")
    if mode is None:
        mode = "bundled" if _BUNDLED_ENTRY.is_file() else "source"
    if mode == "bundled":
        if not _BUNDLED_ENTRY.is_file():
            raise FileNotFoundError(
                f"missing bundled DSH runtime entry: {_BUNDLED_ENTRY} "
                "(set DSH_BUNDLED_RUNTIME, or DSH_RUNTIME_MODE=source for a repo checkout)"
            )
        # closure root = <root>/node_modules/@deepseek-ai/<pkg>/lib/packaged-bin.js
        closure_root = _BUNDLED_ENTRY.parents[4]
        return str(closure_root), ("node", str(_BUNDLED_ENTRY))
    if mode == "source":
        if not _SOURCE_ENTRY.is_file():
            raise FileNotFoundError(
                f"missing DSH runtime entry: {_SOURCE_ENTRY} "
                "(set DSH_REPO_ROOT to the deepseek-harness checkout)"
            )
        return str(_DSH_REPO), ("node", "--import", "tsx", str(_SOURCE_ENTRY))
    raise ValueError(
        f"unsupported DSH_RUNTIME_MODE {mode!r}: expected 'bundled' or 'source'"
    )

# Generous timeout: a Bedrock turn that runs a tool round-trip can take a while.
_REQUEST_TIMEOUT_SECONDS = 240.0

# The JSON-RPC server (first plugin) starts reading stdin before the later
# pi-ai plugin finishes registering its adapter, and initialize rejects an
# unregistered non-default provider outright. The stock deepseek-official
# provider is exempt from that check, so the bundled flow never sees this;
# a custom Bedrock route does. Retry initialize until the adapter appears.
_INIT_RETRY_SECONDS = 30.0
_INIT_RETRY_INTERVAL = 0.25

_harness: DeepSeekHarness | None = None


def _resolve_aws_env() -> dict[str, str]:
    """Freeze ambient AWS credentials into explicit env vars for the subprocess.

    pi-ai's Bedrock auth only recognizes credentials advertised through env-var
    signals (access keys, AWS_PROFILE, ECS/web-identity URIs, or a bearer
    token); it does not probe IMDS. On an EC2 instance role the credentials
    live behind IMDS with no such signal, so we resolve them here through the
    AWS SDK default chain and hand them to the runtime as access-key env vars.
    Credentials stay in the subprocess environment only — never written to disk.
    """
    import boto3

    session = boto3.Session(region_name=BEDROCK_REGION)
    creds = session.get_credentials()
    if creds is None:
        raise RuntimeError(
            "no AWS credentials resolvable by the default chain; "
            "Bedrock auth cannot proceed"
        )
    frozen = creds.get_frozen_credentials()
    env = {
        "AWS_REGION": BEDROCK_REGION,
        "AWS_DEFAULT_REGION": BEDROCK_REGION,
        "AWS_ACCESS_KEY_ID": frozen.access_key,
        "AWS_SECRET_ACCESS_KEY": frozen.secret_key,
    }
    if frozen.token:
        env["AWS_SESSION_TOKEN"] = frozen.token
    return env


def _build_harness(workspace_cwd: str | None) -> DeepSeekHarness:
    if not _CORDIS_CONFIG.is_file():
        raise FileNotFoundError(f"missing cordis config: {_CORDIS_CONFIG}")

    runtime_cwd, launch_argv = _resolve_launch()

    cwd = workspace_cwd or str(_PROJECT_ROOT)
    return DeepSeekHarness(
        provider=PROVIDER,
        model=MODEL,
        # cwd -> DSH_CWD, which the bash + fs providers use as their working dir.
        cwd=cwd,
        # runtime_cwd -> the Node subprocess cwd; must hold the node_modules that
        # bare @deepseek-ai/dsh-* plugin names resolve against (closure root in
        # bundled mode, DSH repo root in source mode).
        runtime_cwd=runtime_cwd,
        session_root=str(_SESSION_ROOT),
        cordis=str(_CORDIS_CONFIG),
        launch_args_override=launch_argv,
        # AWS_REGION drives pi-ai's Bedrock region resolution; the frozen
        # access keys let pi-ai's Bedrock auth recognize the credentials and
        # feed SigV4 signing.
        env=_resolve_aws_env(),
        request_timeout_seconds=_REQUEST_TIMEOUT_SECONDS,
        shutdown_timeout_seconds=5.0,
    )


def _start_with_initialize_retry(harness: DeepSeekHarness) -> None:
    """Start the runtime subprocess and initialize once the adapter is live.

    Drives the low-level client directly (rather than ``harness.start()``) so a
    NO_ADAPTER rejection from the startup race is retried in place instead of
    tearing down the subprocess.
    """
    client = harness.client
    client.start()
    payload = {
        "cwd": harness._cwd,
        "provider": harness.config.provider,
        "model": harness.config.model,
    }
    deadline = time.monotonic() + _INIT_RETRY_SECONDS
    last: JsonRpcError | None = None
    while True:
        try:
            client.request("initialize", payload, response_model=InitializeResponse)
            harness._initialized = True
            return
        except JsonRpcError as exc:
            if "no adapter registered" not in str(exc) or time.monotonic() >= deadline:
                client.close()
                raise
            last = exc
            time.sleep(_INIT_RETRY_INTERVAL)
        except BaseException:
            client.close()
            raise
    assert last is not None  # unreachable; loop returns or raises


def get_harness(workspace_cwd: str | None = None) -> DeepSeekHarness:
    """Return a lazily-started singleton harness bound to the Bedrock config."""
    global _harness
    if _harness is None:
        harness = _build_harness(workspace_cwd)
        _start_with_initialize_retry(harness)
        _harness = harness
    return _harness


def is_started() -> bool:
    """Whether the singleton harness has been started (does not start it)."""
    return _harness is not None


def close() -> None:
    """Tear down the singleton runtime subprocess, if any."""
    global _harness
    if _harness is not None:
        _harness.close()
        _harness = None


def _summarize_tool_calls(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Extract model tool-call attempts and their results from session events.

    Tool activity surfaces as ``tool/call`` events (name + JSON arguments) and
    ``tool/result`` events (the tool output message), so this scans both to
    prove a real tool round-trip happened and to expose the command run.
    """
    calls: list[dict[str, Any]] = []
    for event in events:
        etype = str(event.get("type") or "")
        if "tool" not in etype.lower():
            continue
        data = event.get("data")
        summary: dict[str, Any] = {"event_type": etype}
        if isinstance(data, dict):
            if "name" in data:
                summary["name"] = data["name"]
            if "callId" in data:
                summary["callId"] = data["callId"]
            if "arguments" in data:
                summary["arguments"] = _clip(data["arguments"])
            result_text = _tool_result_text(data)
            if result_text is not None:
                summary["result"] = _clip(result_text)
        calls.append(summary)
    return calls


def _tool_result_text(data: dict[str, Any]) -> str | None:
    """Pull the tool-result text out of a ``tool/result`` event payload."""
    message = data.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, list):
        return None
    parts: list[str] = []
    for block in content:
        inner = block.get("content") if isinstance(block, dict) else None
        if isinstance(inner, list):
            for piece in inner:
                if isinstance(piece, dict) and piece.get("type") == "text":
                    parts.append(str(piece.get("text") or ""))
    return "".join(parts) if parts else None


def _clip(value: Any, limit: int = 400) -> Any:
    text = value if isinstance(value, str) else repr(value)
    return text if len(text) <= limit else text[:limit] + "...<clipped>"


def run_turn(prompt: str, *, session_id: str | None = None,
             workspace_cwd: str | None = None) -> dict[str, Any]:
    """Run one agent turn against Bedrock and return a structured summary.

    Returns a dict with:
    - ``final_response``: the model's final assistant text.
    - ``finish_reason``: the turn-ending reason kind.
    - ``event_types``: ordered list of every session event type observed.
    - ``tool_calls``: summaries of tool-related events (proof of bash use).
    - ``session_id``: the session id used.
    """
    harness = get_harness(workspace_cwd)

    streamed: list[str] = []

    def on_notification(note: Notification) -> None:
        if note.method == "session.event":
            event = note.payload.get("event")
            if isinstance(event, dict):
                streamed.append(str(event.get("type") or ""))

    result = harness.run(prompt, session_id=session_id, on_notification=on_notification)

    return {
        "session_id": result.session_id,
        "final_response": result.final_response,
        "finish_reason": result.finish_reason,
        "event_types": [str(e.get("type") or "") for e in result.events],
        "tool_calls": _summarize_tool_calls(result.events),
    }
