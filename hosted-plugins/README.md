# Hosted assistant plugins

Plugin bundles that add MidBrain to hosted assistants (Claude on web, desktop
and mobile; ChatGPT). They are not part of the npm package.

Each bundle connects the assistant to MidBrain's hosted MCP endpoint,
`https://memory.midbrain.ai/api/mcp`, and ships the `memory-first` skill.
The endpoint and its sign-in live in the MidBrain API: the assistant identifies
itself with its published client metadata document, so users only sign in to
MidBrain and choose a space. No client ID, secret, or API key is involved.

| Folder | Assistant | Distributed through |
|---|---|---|
| `claude/` | Claude | Anthropic's plugin directory, from this public repository |
| `chatgpt/` | ChatGPT | OpenAI's plugin directory, as an uploaded archive |

`claude/skills/memory-first/SKILL.md` and `chatgpt/skills/memory-first/SKILL.md`
must stay identical; `tests/hosted-plugins.test.mjs` enforces it.

## ChatGPT app ID

`chatgpt/.app.json` links the plugin to the MidBrain app registered with
OpenAI. Replace `asdk_app_REPLACE_AFTER_REGISTRATION` with that app's ID once
it exists.

## Test a bundle before publishing

- Claude: zip the contents of `claude/`, then Customize > Plugins > Add > Upload plugin.
- ChatGPT: add the MCP server URL as a custom MCP server first, put its app ID in
  `.app.json`, zip the contents of `chatgpt/`, then Plugins > Add > upload.
