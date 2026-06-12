import fs from 'fs/promises';
import path from 'path';

const RULES_START = '<!-- midbrain-memory-rules:start -->';
const RULES_END   = '<!-- midbrain-memory-rules:end -->';

const RULES_BLOCK_BODY = `\
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
  \`memory_setup_project\` tool. Never manually create key files or configs.`;

function buildRulesBlock() {
  return `${RULES_START}\n${RULES_BLOCK_BODY}\n${RULES_END}`;
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
    await fs.writeFile(filePath, content, 'utf8');
    return { action, path: filePath };
  } catch (err) {
    return { action: 'error', path: filePath, error: err };
  }
}

/**
 * Write or update the MidBrain rules block in a single file.
 * Returns { action: 'created'|'updated'|'skipped'|'error', path, error? }.
 * Never throws.
 */
async function writeAgentRules(filePath) {
  const readResult = await readExisting(filePath);
  if (readResult instanceof Error) {
    return { action: 'error', path: filePath, error: readResult };
  }

  const existing  = readResult;
  const hasStart  = existing.includes(RULES_START);
  const hasEnd    = existing.includes(RULES_END);
  const block     = buildRulesBlock();

  if (hasStart && hasEnd) {
    const startIdx = existing.indexOf(RULES_START);
    const endIdx   = existing.indexOf(RULES_END) + RULES_END.length;
    const current  = existing.slice(startIdx, endIdx);
    if (current === block) return { action: 'skipped', path: filePath };
    const newContent = existing.slice(0, startIdx) + block + existing.slice(endIdx);
    return writeContent(filePath, newContent, 'updated');
  }

  // No complete sentinel (includes malformed: start present but no end)
  const base       = existing.trim() === '' ? '' : existing;
  const newContent = base === '' ? block : base + '\n\n' + block;
  return writeContent(filePath, newContent, 'created');
}

/**
 * Write MidBrain rules block to both AGENTS.md and CLAUDE.md under projectDir.
 * Returns array of two RulesResult objects.
 */
async function writeProjectRules(projectDir) {
  return Promise.all([
    writeAgentRules(path.join(projectDir, 'AGENTS.md')),
    writeAgentRules(path.join(projectDir, 'CLAUDE.md')),
  ]);
}

export {
  RULES_START,
  RULES_END,
  buildRulesBlock,
  writeAgentRules,
  writeProjectRules,
};
