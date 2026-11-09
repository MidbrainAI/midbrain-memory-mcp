// Each outage is consumed exactly once by the local fixture, then the same
// tool and arguments must succeed on the existing MCP connection.
export const READ_RECOVERY_CASES = [
  { name: 'grep', args: { pattern: 'fixture.*' }, path: '/memories/search/lexical', contains: /fixture lexical match/ },
  { name: 'get_episodic_memories_by_date', args: { date: '2026-01-01' }, path: '/memories/episodic', contains: /No episodic memories/ },
  { name: 'list_files', args: {}, path: '/memories/semantic/files', contains: /guide.md/ },
  { name: 'read_file', args: { file_path: 'guide.md' }, path: '/memories/semantic/files/guide.md', contains: /fixture file content/ },
  { name: 'check_session_status', args: {}, path: '/memories/episodic', contains: /No episodic memories/ },
  { name: 'list_agents', args: {}, path: '/account/agents', contains: /dry-agent/ },
];
