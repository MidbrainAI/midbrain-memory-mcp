---
description: Manage MidBrain memory agents and API keys
---
Use the memory_manage_agents MCP tool to manage MidBrain memory agents.

Arguments provided: $ARGUMENTS

Routing rules (apply the first match):
- No arguments → action: "list" (show all agents with IDs and descriptions)
- Starts with "create" → action: "create", agent_name: everything after "create "
- Starts with "select" → action: "select", agent_name: everything after "select "
- Starts with "keys"   → action: "list_keys"
- Starts with "list"   → action: "list"
- Starts with "setup"  → Run full setup flow: if a name follows "setup ", use action: "create" with that name, then memory_setup_project. If no name, first action: "list" to show agents, then ask user to create or select, then memory_setup_project.

After any action that creates or selects an agent, remind the user to restart
their coding client for the new project config to take effect.

If memory_manage_agents is not available, tell the user to install the MidBrain
MCP server: npx midbrain-memory-mcp
