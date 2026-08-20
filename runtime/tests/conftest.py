"""Make the adapter modules and the DSH SDK importable during tests."""

import os
import sys
from pathlib import Path

_RUNTIME_DIR = Path(__file__).resolve().parents[1]
_SDK_SRC = Path(
    os.environ.get("DSH_REPO_ROOT", "/home/ubuntu/g-repo/dsh/deepseek-harness")
) / "python" / "sdk" / "src"

for p in (str(_RUNTIME_DIR), str(_SDK_SRC)):
    if p not in sys.path:
        sys.path.insert(0, p)
