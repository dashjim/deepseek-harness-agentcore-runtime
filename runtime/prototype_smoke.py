"""Prove a Bedrock-driven DeepSeek Harness coding turn runs end to end.

Run: AWS_REGION=us-west-2 python runtime/prototype_smoke.py

Success criteria (all must hold):
- The model responds through Bedrock (non-empty final response).
- At least one bash tool round-trip is observed in the session events.
"""

from __future__ import annotations

import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import dsh_client

PROMPT = (
    "List the files in the current directory using the bash tool, "
    "then tell me how many there are."
)


def main() -> int:
    print(f"provider={dsh_client.PROVIDER} model={dsh_client.MODEL} region={dsh_client.BEDROCK_REGION}")
    print(f"cordis={dsh_client._CORDIS_CONFIG}")
    print(f"runtime_entry={dsh_client._RUNTIME_ENTRY}")
    print(f"prompt={PROMPT!r}")
    print("-" * 72)

    try:
        result = dsh_client.run_turn(PROMPT, session_id=f"bedrock-smoke-{uuid.uuid4().hex[:8]}")
    finally:
        dsh_client.close()

    print("event_types:")
    print("  " + ", ".join(result["event_types"]))
    print("-" * 72)
    print(f"tool_calls ({len(result['tool_calls'])}):")
    print(json.dumps(result["tool_calls"], ensure_ascii=False, indent=2))
    print("-" * 72)
    print(f"finish_reason={result['finish_reason']}")
    print("final_response:")
    print(result["final_response"])
    print("-" * 72)

    used_bash = bool(result["tool_calls"])
    non_empty = bool(result["final_response"].strip())
    print(f"used_tool={used_bash} non_empty_final={non_empty}")
    if used_bash and non_empty:
        print("SMOKE PASS: Bedrock turn ran a tool round-trip and returned a final response.")
        return 0
    print("SMOKE FAIL: missing tool round-trip or empty final response.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
