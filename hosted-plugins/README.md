# Hosted assistant plugins

Plugin bundles that add MidBrain to hosted assistants: Claude (web, desktop,
mobile and Claude Code) and ChatGPT. They are not part of the npm package.

Each bundle points the assistant at MidBrain's hosted MCP endpoint,
`https://memory.midbrain.ai/api/mcp`, and ships the `memory-first` skill. The
endpoint and its sign-in live in the MidBrain API: the assistant identifies
itself with its published client metadata document, so users only sign in to
MidBrain and choose a space. No client ID, secret or API key is involved.

The skill only guides the assistant. The tools, their descriptions and the
memory rules they carry (what to save, when to recall) live in the endpoint, so
the connector alone works without the plugin.

| Folder | Assistant | Published through |
|---|---|---|
| `claude/` | Claude | Anthropic's directory, from this public repository |
| `chatgpt/` | ChatGPT | OpenAI's plugin dashboard, as an uploaded archive of the folder |

`claude/skills/memory-first/SKILL.md` and `chatgpt/skills/memory-first/SKILL.md`
must stay identical; `tests/hosted-plugins.test.mjs` enforces it.

## Install without a listing

- Claude: zip the contents of `claude/`, then Customize > Plugins > Add >
  Upload plugin, and connect `midbrain` on the plugin's Connectors tab. The
  plugin follows the account to web, desktop, mobile and Claude Code. Without
  the plugin, add the URL above under Customize > Connectors > Add custom
  connector.
- ChatGPT: add the URL above under chatgpt.com/plugins > + > Add custom MCP
  server (paid plans). An uploaded archive that declares the server is listed as
  "Desktop only" and does not reach ChatGPT chat.

For reliable saving and recall, users also paste this into ChatGPT's custom
instructions or Claude's profile preferences:

> MidBrain is my memory. At the start of each conversation, and before
> answering anything about me, search MidBrain. Whenever I share a fact about
> myself, save it to MidBrain before replying.

## Publish

- Claude: submit the endpoint as an MCP connector and this folder as a plugin
  bundle at claude.ai/directory/manage, from the same organization, then pair
  the two listings.
- ChatGPT: an organization owner uploads a zip of `chatgpt/` in the plugin
  dashboard and connects the MCP server there (OAuth). The dashboard then shows
  a domain-verification token, served as plain text at
  `/.well-known/openai-apps-challenge` on the MCP host or a parent domain, so
  `https://midbrain.ai/.well-known/openai-apps-challenge` on the website works
  without an API change. Review also needs a demo recording URL
  (`extensions.com.openai.review.demo_recording_url`).
