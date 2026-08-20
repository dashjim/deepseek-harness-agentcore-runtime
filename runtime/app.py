"""AgentCore Runtime adapter for the DeepSeek Harness coding agent.

Implements the AgentCore Runtime HTTP contract via ``BedrockAgentCoreApp``:
- ``GET /ping``  -> healthy (provided by the SDK; does NOT touch the harness, so
  the DSH runtime subprocess is only started on the first real invocation).
- ``POST /invocations`` -> routed to :func:`invoke` below.

The adapter validates a small request envelope, then drives the lazily-started
singleton :mod:`dsh_client` harness (Bedrock GPT via DSH pi-ai). One harness per
container process (per AgentCore microVM session), matching the design's
"one SDK owner per microVM" rule.
"""

from __future__ import annotations

from typing import Any

from bedrock_agentcore.runtime import BedrockAgentCoreApp

import dsh_client

app = BedrockAgentCoreApp()


class EnvelopeError(ValueError):
    """Raised when an /invocations request envelope is malformed."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _extract_prompt(payload: dict[str, Any]) -> str:
    """Pull the user prompt out of the supported envelope shapes.

    Accepts either a flat ``{"prompt": "..."}`` or the design's versioned
    envelope ``{"operation": "session.prompt", "payload": {"prompt": "..."}}``.
    """
    prompt = payload.get("prompt")
    if prompt is None and payload.get("operation") == "session.prompt":
        inner = payload.get("payload")
        if isinstance(inner, dict):
            prompt = inner.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise EnvelopeError(
            "INVALID_ENVELOPE",
            "request must include a non-empty string 'prompt' "
            "(or operation 'session.prompt' with payload.prompt)",
        )
    return prompt


def _status() -> dict[str, Any]:
    """Report readiness without starting the harness (lazy-init safe)."""
    return {"status": "ready", "harnessStarted": dsh_client.is_started()}


@app.entrypoint
def invoke(payload: Any) -> dict[str, Any]:
    """Handle a POST /invocations request.

    Routes by an optional ``action`` field:
    - ``action == "status"`` -> readiness probe (does not start the harness).
    - otherwise -> treat as a coding prompt and run one DSH/Bedrock turn.

    Returns a stable-shaped dict. On a malformed envelope, returns an error
    envelope with a stable code (never a raw stack trace).
    """
    if not isinstance(payload, dict):
        return {"error": {"code": "INVALID_ENVELOPE",
                          "message": "payload must be a JSON object"}}

    action = payload.get("action")
    try:
        if action == "status":
            return _status()

        prompt = _extract_prompt(payload)
        session_id = payload.get("dshSessionId") or payload.get("session_id")
        result = dsh_client.run_turn(prompt, session_id=session_id)
        return {
            "response": result["final_response"],
            "finishReason": result["finish_reason"],
            "sessionId": result["session_id"],
            "toolCalls": result["tool_calls"],
        }
    except EnvelopeError as exc:
        return {"error": {"code": exc.code, "message": exc.message}}
    except Exception as exc:  # noqa: BLE001 — never leak a stack trace to the caller
        return {"error": {"code": "RUNTIME_ERROR", "message": str(exc)}}


if __name__ == "__main__":
    # BedrockAgentCoreApp serves the AgentCore contract on 0.0.0.0:8080.
    app.run()
