# MidBrain Memory for Claude

MidBrain is a long-term memory shared across your AI apps. This plugin lets
Claude recall what you told it before and save the facts that matter, in Chat
(web, desktop and mobile), Cowork and Claude Code.

## What it contains

- A remote MCP connector, `midbrain`, at `https://memory.midbrain.ai/api/mcp`.
- The `memory-first` skill, which tells Claude when to search and when to save.
- Hooks that save every turn through the connector in Claude Code on your
  computer (terminal, IDE or the desktop app's Code tab). Chat ignores them,
  and Cowork and Claude Code on the web do not run them; there, Claude saves
  the facts you share.

## What it sends and where

Claude connects to `https://memory.midbrain.ai/api/mcp` after you sign in to
MidBrain and approve the connection. It sends:

- search queries, when Claude looks something up in your memory;
- one short sentence per fact, when Claude saves a fact you shared in Chat;
- in Claude Code on your computer, each prompt you send and each final reply, with
  the session ID, so the whole conversation is kept.

Everything is stored in your MidBrain account. In Chat, the skill and the
tools tell Claude not to save passwords, keys, or card or ID numbers. In Claude
Code, prompts and replies are saved as written: a key you paste into
a prompt is saved with it.

Claude Code also sends some messages you did not type through the same hook:
a `/loop` or scheduled task firing, a background subagent reporting back, and a
message from another session. They are saved as your prompts, because the hook
is not told where a message came from.

## Set up

1. Install the plugin.
2. On the plugin's Connectors tab, connect `midbrain`, sign in to MidBrain and
   approve.
3. In Claude Code on your computer, sign in once more: Claude Code uses its
   own connection, shared by the terminal and the desktop app.
   Restart Claude Code (it loads a new or updated plugin only at start), run
   `/mcp`, choose `plugin:midbrain-memory:midbrain` and authenticate. Until
   then, Claude Code saves nothing and shows "Unauthorized" after each prompt.

If you also installed MidBrain's npm package for Claude Code, keep only one of
the two, or each turn is saved twice.

To stop using it, disconnect the connector or uninstall the plugin. You can see
and revoke the connection in your MidBrain account.

## Links

- Documentation and support: https://memory.midbrain.ai/app/docs/
- Privacy: https://www.midbrain.ai/privacy
- Terms: https://www.midbrain.ai/terms
- License: MIT
