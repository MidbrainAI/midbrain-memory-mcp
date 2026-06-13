<!-- midbrain-memory-rules:start -->
## MidBrain Memory Rules

- Use `check_session_status` at session start to detect recent activity from
  other sessions or clients. If it reports recent activity, use
  `get_episodic_memories_by_date` to fetch full context.
- Use `memory_search` at session start and before any work that depends on
  prior context.
- Use `grep` for exact pattern matches (names, IDs, code, URLs).
- Use `list_files` and `read_file` to browse semantic memory documents.
- Use `get_episodic_memories_by_date` for conversation history by date or
  to continue prior work.
- When the user asks to "continue", "pick up where we left off", or similar,
  use `get_episodic_memories_by_date` with today's date to retrieve context.
- If a tool response includes a recency hint about newer episodic memories,
  fetch them with `get_episodic_memories_by_date` if relevant.
- NEVER create semantic memories. Semantic memories are managed by dream
  consolidation.
- NEVER create episodic memories. Episodic capture is automatic via hooks.
- Procedural knowledge (PK) is injected automatically before each user turn.
  Do not call or expect a PK MCP tool.
- When asked to set up MidBrain memory for a project, ALWAYS use the
  `memory_setup_project` tool. Never manually create key files or configs.
<!-- midbrain-memory-rules:end -->