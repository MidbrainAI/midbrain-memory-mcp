<!-- midbrain-memory-rules:start -->
### Tool loading

- Claude: if MidBrain is deferred, `ToolSearch` for `memory_search` or the
  needed function—not only the server name—then call it. Discovery is the only
  allowed pre-recall action. Continue externalized results only with `Read`.

## MidBrain Memory

- Before substantive work, recall relevant MidBrain context; skip only trivial
  self-contained work or explicit opt-out. Start with contextual
  `memory_search`. Search one target per call. Treat every request ID, name,
  file, and date as a retrieval anchor: copy it verbatim into the query; never
  merge or generalize targets. Never use `check_session_status` as a default
  primer; use it only when the user signals session/client continuity or
  recent-session metadata is itself needed, then perform targeted search/date
  recall.
- Use recovered context. Refine irrelevant or incomplete results before acting
  and recall again only for a new material target.
- Tools: `memory_search(all)` for broad context; episodic search for prior
  conversations/decisions; `get_episodic_memories_by_date` for known periods
  or continuity; semantic search plus `list_files`/`read_file` for stored
  documents; `grep` for exact semantic anchors only. MidBrain
  `list_files`/`read_file` read remote memory, so local-filesystem bans do
  not prohibit them.
- Reliability outranks cost. Start near 10 results; if the target is absent or
  noisy, repeat at the supported maximum (currently 50). Then refine anchors or
  surfaces, paginate, or traverse dates while useful. Ranked misses are not
  absence; recall depth is uncapped. Stop on direct recovery.
- Current/latest claims require the underlying state-changing episode or direct
  current evidence; assistant restatements are insufficient. Current repos,
  configs, and live systems override memory.
- Report only `found`, `maybe found`, or `not found after search`; report
  tool failure separately. Never infer or reconstruct missing memory.
- Never query secrets/large sensitive blobs or create memories.
  `memory_setup_project` requires an explicit setup request.
- Procedural knowledge is not injected automatically unless
  `MIDBRAIN_ENABLE_PK_INJECTION=1`.
<!-- midbrain-memory-rules:end -->
