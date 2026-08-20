"""Unit tests for the AgentCore adapter.

These never launch the DSH runtime subprocess or call Bedrock — the real
end-to-end turn is proven by ``runtime/prototype_smoke.py``. Here we isolate
the adapter's envelope validation, lazy-init behaviour, and single-owner
harness semantics with monkeypatching.
"""

import dsh_client
from app import invoke


# --- envelope validation -----------------------------------------------------

def test_non_dict_payload_is_rejected():
    out = invoke("not a dict")
    assert out["error"]["code"] == "INVALID_ENVELOPE"


def test_missing_prompt_is_rejected():
    out = invoke({})
    assert out["error"]["code"] == "INVALID_ENVELOPE"


def test_blank_prompt_is_rejected():
    out = invoke({"prompt": "   "})
    assert out["error"]["code"] == "INVALID_ENVELOPE"


def test_versioned_envelope_prompt_is_accepted(monkeypatch):
    seen = {}

    def fake_run_turn(prompt, *, session_id=None, workspace_cwd=None):
        seen["prompt"] = prompt
        return {"final_response": "ok", "finish_reason": "completed",
                "session_id": "s1", "tool_calls": []}

    monkeypatch.setattr(dsh_client, "run_turn", fake_run_turn)
    out = invoke({"operation": "session.prompt", "payload": {"prompt": "hello"}})
    assert seen["prompt"] == "hello"
    assert out["response"] == "ok"
    assert out["finishReason"] == "completed"
    assert out["sessionId"] == "s1"


def test_prompt_routes_to_run_turn(monkeypatch):
    def fake_run_turn(prompt, *, session_id=None, workspace_cwd=None):
        return {"final_response": f"echo:{prompt}", "finish_reason": "completed",
                "session_id": session_id or "auto", "tool_calls": [{"name": "bash"}]}

    monkeypatch.setattr(dsh_client, "run_turn", fake_run_turn)
    out = invoke({"prompt": "list files", "dshSessionId": "conv1"})
    assert out["response"] == "echo:list files"
    assert out["sessionId"] == "conv1"
    assert out["toolCalls"] == [{"name": "bash"}]


def test_runtime_error_is_wrapped_not_leaked(monkeypatch):
    def boom(prompt, *, session_id=None, workspace_cwd=None):
        raise RuntimeError("subprocess died")

    monkeypatch.setattr(dsh_client, "run_turn", boom)
    out = invoke({"prompt": "x"})
    assert out["error"]["code"] == "RUNTIME_ERROR"
    assert "subprocess died" in out["error"]["message"]
    assert "Traceback" not in out["error"]["message"]


# --- lazy init ---------------------------------------------------------------

def test_status_action_does_not_start_harness(monkeypatch):
    # Ensure a clean slate: no harness started.
    monkeypatch.setattr(dsh_client, "_harness", None)
    out = invoke({"action": "status"})
    assert out["status"] == "ready"
    assert out["harnessStarted"] is False
    assert dsh_client.is_started() is False


def test_module_import_does_not_start_harness():
    # Importing the adapter + client must not spawn the DSH runtime.
    assert dsh_client.is_started() is False


# --- single owner ------------------------------------------------------------

def test_get_harness_is_singleton(monkeypatch):
    monkeypatch.setattr(dsh_client, "_harness", None)

    build_calls = {"n": 0}
    sentinel = object()

    def fake_build(workspace_cwd):
        build_calls["n"] += 1
        return sentinel

    def fake_start(harness):
        # no-op: do not launch a real subprocess
        return None

    monkeypatch.setattr(dsh_client, "_build_harness", fake_build)
    monkeypatch.setattr(dsh_client, "_start_with_initialize_retry", fake_start)

    first = dsh_client.get_harness()
    second = dsh_client.get_harness()
    assert first is second is sentinel
    assert build_calls["n"] == 1  # built once, reused thereafter
