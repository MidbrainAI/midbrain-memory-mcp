---
name: midbrain-memory
description: Recall MidBrain memory - prior conversations, decisions and stored documents from this user's other sessions and clients. Use before substantive work and whenever earlier context, a past decision, or a named file, ID or date may already be in memory.
---

# MidBrain Memory

MidBrain is this user's persistent memory across sessions and coding agents.
Its tools come from the `midbrain-memory` MCP server. Recall before
substantive work; the project's AGENTS.md rules say how.

```python
# Shortcut: memory_search, all memory types, 10 results.
hits = await midbrain_memory("Prime Agent client support")
hits = await midbrain_memory("deploy decision", limit=50, memory_type="episodic")

# Any MidBrain tool through the generic MCP module:
tools = await mcp.list_tools("midbrain-memory")
day = await mcp.call_tool("midbrain-memory", "get_episodic_memories_by_date", {"date": "2026-10-12"})
exact = await mcp.call_tool("midbrain-memory", "grep", {"pattern": "PR #98"})
```

- `memory_search(query, limit, memory_type)`: `memory_type` is `all`,
  `episodic` (conversations) or `semantic` (documents). Start near 10
  results; repeat at the maximum, 50, when the target is missing.
- `grep(pattern)`: exact anchors (names, IDs, URLs, code).
- `get_episodic_memories_by_date(date)`: what happened on a day.
- `list_files` / `read_file`: stored semantic documents (remote memory, not
  the local disk).

Conversations are captured automatically. Never create memories yourself.
