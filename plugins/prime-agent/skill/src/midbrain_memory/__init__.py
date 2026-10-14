"""MidBrain Memory for Prime Agent.

Prime Agent imports every installed Python skill when a session's kernel
starts. Importing this one starts MidBrain's conversation capture: a
detached `prime-agent-hook watch` process (the stable shim the MidBrain
installer writes) that stores the session's turns while the kernel's owner
process runs. Calling the module, `await midbrain_memory(query)`, runs the
`memory_search` tool of the `midbrain-memory` MCP server.

Nothing here may break the kernel: every failure is swallowed.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any

SERVER = "midbrain-memory"
_OWNER_ENV = "PRIME_AGENT_KERNEL_OWNER_PID"
_DISABLE_ENV = "MIDBRAIN_PRIME_CAPTURE"


def _shim_path() -> Path:
    state_dir = os.environ.get("MIDBRAIN_STATE_DIR", "").strip()
    base = Path(state_dir) / "bin" if state_dir else Path.home() / ".midbrain" / "bin"
    return base / ("prime-agent-hook.cmd" if os.name == "nt" else "prime-agent-hook")


def _start_capture() -> None:
    """Launch the capture watcher for this kernel's owner process, once per import."""
    if not os.environ.get(_OWNER_ENV) or os.environ.get(_DISABLE_ENV) == "0":
        return
    shim = _shim_path()
    if not shim.is_file():
        return
    try:
        options: dict[str, Any] = {
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
            "close_fds": True,
        }
        if os.name == "nt":
            options["creationflags"] = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(
                subprocess, "CREATE_NEW_PROCESS_GROUP", 0
            )
        else:
            options["start_new_session"] = True
        subprocess.Popen([str(shim), "watch"], **options)  # noqa: S603 - fixed argv, no shell
    except Exception:  # noqa: BLE001 - capture must never break the kernel
        pass


async def run(query: str, limit: int = 10, memory_type: str = "all") -> Any:
    """Search MidBrain memory (memory_search on the midbrain-memory MCP server).

    memory_type: "all", "episodic" (conversations) or "semantic" (documents).
    limit: 1-50; start near 10, repeat at 50 when the target is missing.
    """
    from rlm import mcp  # the kernel's MCP client; present only inside Prime Agent

    return await mcp.call_tool(SERVER, "memory_search", {"query": query, "limit": limit, "memory_type": memory_type})


_start_capture()
