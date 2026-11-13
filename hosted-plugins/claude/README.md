# MidBrain Memory for Claude

MidBrain is a long-term memory shared across your AI apps. This plugin lets
Claude recall what you told it before and save the facts that matter, in Chat
(web, desktop and mobile), Cowork and Claude Code.

## What it contains

- A remote MCP connector, `midbrain`, at `https://memory.midbrain.ai/api/mcp`.
- The `memory-first` skill, which tells Claude when to search and when to save.

The plugin runs nothing on your computer.

## What it sends and where

Claude connects to `https://memory.midbrain.ai/api/mcp` after you sign in to
MidBrain and approve the connection. It sends:

- search queries, when Claude looks something up in your memory;
- one short sentence per fact, when Claude saves a fact you shared.

Saved facts are stored in your MidBrain account. Claude never sends secrets on
purpose: the skill and the tools tell it not to save passwords, keys, or card
or ID numbers.

## Set up

1. Install the plugin.
2. On the plugin's Connectors tab, connect `midbrain`, sign in to MidBrain and
   approve.

To stop using it, disconnect the connector or uninstall the plugin. You can see
and revoke the connection in your MidBrain account.

## Links

- Documentation and support: https://memory.midbrain.ai/app/docs/
- Privacy: https://www.midbrain.ai/privacy
- Terms: https://www.midbrain.ai/terms
- License: MIT
