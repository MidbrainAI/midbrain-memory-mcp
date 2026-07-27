import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'node:crypto';

const RULES_START = '<!-- midbrain-memory-rules:start -->';
const RULES_END   = '<!-- midbrain-memory-rules:end -->';

const CLIENT_ADAPTERS = {
  agents: `\
### Tool loading

- Codex/OpenCode: call visible MidBrain tools. If deferred, discover
  \`memory_search\` or the needed function, then call it. Discovery is the only
  allowed pre-recall action.`,
  claude: `\
### Tool loading

- Claude: if MidBrain is deferred, \`ToolSearch\` for \`memory_search\` or the
  needed function—not only the server name—then call it. Discovery is the only
  allowed pre-recall action. Continue externalized results only with \`Read\`.`,
  nanoclaw: `\
### Tool loading

- NanoClaw: if MidBrain is deferred, \`ToolSearch\` for \`memory_search\` or the
  needed function—not only the server name—then call it. Discovery is the only
  allowed pre-recall action. Continue externalized results only with \`Read\`.`,
  hermes: `\
### Tool loading

- Hermes: call visible \`mcp__midbrain_memory__*\` tools. If deferred,
  \`tool_search\` the needed function, then \`tool_describe\` and \`tool_call\`
  it. Discovery is the only allowed pre-recall action.`,
};

CLIENT_ADAPTERS['agents-hermes'] =
  `${CLIENT_ADAPTERS.agents}\n\n${CLIENT_ADAPTERS.hermes}`;

const RULES_BLOCK_BODY = `\
## MidBrain Memory

- Before substantive work, recall relevant MidBrain context; skip only trivial
  self-contained work or explicit opt-out. Start with contextual
  \`memory_search\`. Search one target per call. Treat every request ID, name,
  file, and date as a retrieval anchor: copy it verbatim into the query; never
  merge or generalize targets. Never use \`check_session_status\` as a default
  primer; use it only when the user signals session/client continuity or
  recent-session metadata is itself needed, then perform targeted search/date
  recall.
- Use recovered context. Refine irrelevant or incomplete results before acting
  and recall again only for a new material target.
- Tools: \`memory_search(all)\` for broad context; episodic search for prior
  conversations/decisions; \`get_episodic_memories_by_date\` for known periods
  or continuity; semantic search plus \`list_files\`/\`read_file\` for stored
  documents; \`grep\` for exact semantic anchors only. MidBrain
  \`list_files\`/\`read_file\` read remote memory, so local-filesystem bans do
  not prohibit them.
- Reliability outranks cost. Start near 10 results; if the target is absent or
  noisy, repeat at the supported maximum (currently 50). Then refine anchors or
  surfaces, paginate, or traverse dates while useful. Ranked misses are not
  absence; recall depth is uncapped. Stop on direct recovery.
- Current/latest claims require the underlying state-changing episode or direct
  current evidence; assistant restatements are insufficient. Current repos,
  configs, and live systems override memory.
- Report only \`found\`, \`maybe found\`, or \`not found after search\`; report
  tool failure separately. Never infer or reconstruct missing memory.
- Never query secrets/large sensitive blobs or create memories.
  \`memory_setup_project\` requires an explicit setup request.
- Procedural knowledge is not injected automatically unless
  \`MIDBRAIN_ENABLE_PK_INJECTION=1\`.`;

const LEGACY_RULES_BODIES = [
  `\
## MidBrain Memory Rules

- Use \`check_session_status\` at session start to detect recent activity from
  other sessions or clients. If it reports recent activity, use
  \`get_episodic_memories_by_date\` to fetch full context.
- Use \`memory_search\` at session start and before any work that depends on
  prior context.
- Use \`grep\` for exact pattern matches (names, IDs, code, URLs).
- Use \`list_files\` and \`read_file\` to browse semantic memory documents.
- Use \`get_episodic_memories_by_date\` for conversation history by date or
  to continue prior work.
- When the user asks to "continue", "pick up where we left off", or similar,
  use \`get_episodic_memories_by_date\` with today's date to retrieve context.
- If a tool response includes a recency hint about newer episodic memories,
  fetch them with \`get_episodic_memories_by_date\` if relevant.
- NEVER create semantic memories. Semantic memories are managed by dream
  consolidation.
- NEVER create episodic memories. Episodic capture is automatic via hooks.
- Procedural knowledge (PK) is injected automatically before each user turn.
  Do not call or expect a PK MCP tool.
- When asked to set up MidBrain memory for a project, ALWAYS use the
  \`memory_setup_project\` tool. Never manually create key files or configs.`,
  `\
## MidBrain Memory Rules

- Use \`check_session_status\` at session start to detect recent activity from
  other sessions or clients. If it reports recent activity, use
  \`get_episodic_memories_by_date\` to fetch full context.
- Use \`memory_search\` at session start and before any work that depends on
  prior context.
- Use \`grep\` for exact pattern matches (names, IDs, code, URLs).
- Use \`list_files\` and \`read_file\` to browse semantic memory documents.
- Use \`get_episodic_memories_by_date\` for conversation history by date or
  to continue prior work.
- When the user asks to "continue", "pick up where we left off", or similar,
  use \`get_episodic_memories_by_date\` with today's date to retrieve context.
- If a tool response includes a recency hint about newer episodic memories,
  fetch them with \`get_episodic_memories_by_date\` if relevant.
- NEVER create semantic memories. Semantic memories are managed by dream
  consolidation.
- NEVER create episodic memories. Episodic capture is automatic via hooks.
- Procedural knowledge is not injected automatically. Use explicit memory tools
  for recall; do not call or expect a PK MCP tool.
- Legacy PK injection only runs when \`MIDBRAIN_ENABLE_PK_INJECTION=1\` is set
  explicitly in the hook environment.
- When asked to set up MidBrain memory for a project, ALWAYS use the
  \`memory_setup_project\` tool. Never manually create key files or configs.`,
];

const LEGACY_RULES_BLOCKS = LEGACY_RULES_BODIES.map(
  (body) => `${RULES_START}\n${body}\n${RULES_END}`,
);

// Byte-exact managed blocks installed during the rule-parity rollout.
// Hashes let us migrate known generated output without matching or deleting
// user-authored MidBrain prose. Any user edit changes the hash and is preserved.
const RECOGNIZED_MANAGED_BLOCK_HASHES = new Set([
  'a7bc02935caf2ba8ac3225d2255a2783e9e69e6e24cdd3a07622c5de99e7',
  'b291ef0e795a38f42061fde07152f907454f47e88ffd7b3d80b33d56fbf38c78',
  'b3daa1470cabc89f7401bde1efa29b942514f2df90c24d1fdc663df318dd14cb',
  'e4d35347297d3af14bdddb0f6952c6fe84bced7081b757ac06d654a5aa851976',
]);

function isRecognizedManagedBlock(block) {
  if (LEGACY_RULES_BLOCKS.includes(block)) return true;
  const hash = createHash('sha256').update(block).digest('hex');
  return RECOGNIZED_MANAGED_BLOCK_HASHES.has(hash);
}

function buildRulesBlock(client = 'agents') {
  const adapter = CLIENT_ADAPTERS[client];
  if (!adapter) throw new Error(`Unsupported rules client: ${client}`);
  return `${RULES_START}\n${adapter}\n\n${RULES_BLOCK_BODY}\n${RULES_END}`;
}

function findCompleteRulesBlock(content) {
  let endIdx = content.indexOf(RULES_END);
  while (endIdx !== -1) {
    const startIdx = content.lastIndexOf(RULES_START, endIdx);
    if (startIdx !== -1) {
      return { startIdx, endIdx: endIdx + RULES_END.length };
    }
    endIdx = content.indexOf(RULES_END, endIdx + RULES_END.length);
  }
  return null;
}

function hasMalformedSentinel(content) {
  return content.includes(RULES_START) !== content.includes(RULES_END);
}

/** Read existing file content; ENOENT → ''; other errors → Error object. */
async function readExisting(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    return err;
  }
}

/** Write content to filePath; on error return { action: 'error' }. */
async function writeContent(filePath, content, action) {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
    return { action, path: filePath };
  } catch (err) {
    return { action: 'error', path: filePath, error: err };
  }
}

/**
 * Write or update the MidBrain rules block in a single file.
 * Returns { action: 'created'|'updated'|'skipped'|'preserved'|'error', ... }.
 * Never throws.
 */
async function writeAgentRules(filePath, opts = {}) {
  const readResult = await readExisting(filePath);
  if (readResult instanceof Error) {
    return { action: 'error', path: filePath, error: readResult };
  }

  const existing  = readResult;
  const block     = buildRulesBlock(opts.client || 'agents');
  const range     = findCompleteRulesBlock(existing);

  if (range) {
    const current  = existing.slice(range.startIdx, range.endIdx);
    if (current === block) return { action: 'skipped', path: filePath };
    if (isRecognizedManagedBlock(current)) {
      const newContent =
        existing.slice(0, range.startIdx) + block + existing.slice(range.endIdx);
      return writeContent(filePath, newContent, 'updated');
    }
    return {
      action: 'preserved',
      path: filePath,
      reason: 'custom-managed-block',
    };
  }

  if (hasMalformedSentinel(existing)) {
    return {
      action: 'preserved',
      path: filePath,
      reason: 'malformed-managed-block',
    };
  }

  for (const legacyBody of LEGACY_RULES_BODIES) {
    const startIdx = existing.indexOf(legacyBody);
    if (startIdx !== -1) {
      const newContent =
        existing.slice(0, startIdx) +
        block +
        existing.slice(startIdx + legacyBody.length);
      return writeContent(filePath, newContent, 'updated');
    }
  }

  const base       = existing.trim() === '' ? '' : existing;
  const newContent = base === '' ? block : base + '\n\n' + block;
  return writeContent(filePath, newContent, 'created');
}

async function findHermesContext(projectDir) {
  for (const name of ['.hermes.md', 'HERMES.md']) {
    const filePath = path.join(projectDir, name);
    try {
      await fs.readFile(filePath, 'utf8');
      return { path: filePath };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        return { path: filePath, error: err };
      }
    }
  }
  return null;
}

async function nanoClawTargets(root) {
  if (!root) return [];
  const targets = [{
    path: path.join(root, 'container', 'CLAUDE.md'),
    client: 'nanoclaw',
  }];
  try {
    const entries = await fs.readdir(path.join(root, 'groups'), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      targets.push({
        path: path.join(root, 'groups', entry.name, 'CLAUDE.local.md'),
        client: 'nanoclaw',
      });
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      targets.push({
        path: path.join(root, 'groups'),
        error: err,
      });
    }
  }
  return targets;
}

/**
 * Keep every detected client's user-wide instruction surface current.
 * NanoClaw uses its shared container instructions plus each existing group's
 * writable CLAUDE.local.md; composed group CLAUDE.md files are never edited.
 */
async function writeGlobalRules(opts = {}) {
  const clients = new Set(opts.clients || []);
  const homeDir = opts.homeDir || process.env.HOME;
  const targets = [];

  if (clients.has('codex')) {
    targets.push({
      path: path.join(homeDir, '.codex', 'AGENTS.md'),
      client: 'agents',
    });
  }
  if (clients.has('opencode')) {
    targets.push({
      path: path.join(homeDir, '.config', 'opencode', 'AGENTS.md'),
      client: 'agents',
    });
  }
  if (clients.has('claude')) {
    targets.push({
      path: path.join(homeDir, '.claude', 'CLAUDE.md'),
      client: 'claude',
    });
  }
  if (clients.has('hermes')) {
    targets.push({
      path: path.join(
        opts.hermesHome || process.env.HERMES_HOME || path.join(homeDir, '.hermes'),
        'SOUL.md',
      ),
      client: 'hermes',
    });
  }
  if (clients.has('nanoclaw')) {
    targets.push(...await nanoClawTargets(opts.nanoclawRoot));
  }

  return Promise.all(targets.map((target) => {
    if (target.error) {
      return {
        action: 'error',
        path: target.path,
        error: target.error,
      };
    }
    return writeAgentRules(target.path, { client: target.client });
  }));
}

/**
 * Write MidBrain rules only to instruction surfaces used by detected clients.
 * Without opts.clients, retains the portable legacy behavior (all clients).
 */
async function writeProjectRules(projectDir, opts = {}) {
  const clients = new Set(opts.clients || [
    'codex', 'opencode', 'claude', 'nanoclaw', 'hermes',
  ]);
  const targets = [];

  const codeClients = clients.has('codex') || clients.has('opencode');
  let needsAgents = codeClients;
  const needsClaude = clients.has('claude') || clients.has('nanoclaw');
  let agentsClient = 'agents';

  if (clients.has('hermes')) {
    const hermesContext = await findHermesContext(projectDir);
    if (hermesContext?.error) {
      targets.push(Promise.resolve({
        action: 'error',
        path: hermesContext.path,
        error: hermesContext.error,
      }));
    } else if (hermesContext) {
      targets.push(writeAgentRules(hermesContext.path, { client: 'hermes' }));
    } else {
      // Creating .hermes.md would shadow AGENTS.md and other project rules.
      needsAgents = true;
      agentsClient = codeClients ? 'agents-hermes' : 'hermes';
    }
  }

  if (needsAgents) {
    targets.unshift(writeAgentRules(
      path.join(projectDir, 'AGENTS.md'),
      { client: agentsClient },
    ));
  }
  if (needsClaude) {
    const index = needsAgents ? 1 : 0;
    targets.splice(index, 0, writeAgentRules(
      path.join(projectDir, 'CLAUDE.md'),
      { client: 'claude' },
    ));
  }

  return Promise.all(targets);
}

export {
  LEGACY_RULES_BLOCKS,
  RECOGNIZED_MANAGED_BLOCK_HASHES,
  RULES_START,
  RULES_END,
  buildRulesBlock,
  writeAgentRules,
  writeGlobalRules,
  writeProjectRules,
};
