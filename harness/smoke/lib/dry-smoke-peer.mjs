// A harmless second MCP server: proves installation does not discard siblings.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
const server = new McpServer({ name: 'dry-smoke-peer', version: '1.0.0' });
server.tool('dry_smoke_peer', 'Harmless coexistence fixture', {}, async () => ({ content: [{ type: 'text', text: 'peer ready' }] }));
await server.connect(new StdioServerTransport());
