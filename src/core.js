// core.js — transport-agnostic assembly of the Ghost MCP server.
// ------------------------------------------------------------------
// Both entrypoints share this code:
//   * src/index.js        — local stdio transport (Claude Desktop / Code)
//   * src/http-server.js  — remote Streamable HTTP + OAuth (claude.ai / ChatGPT)
// Tool registration is completely independent of the transport, so the only
// thing that differs between local and remote is how bytes get on the wire.
// ------------------------------------------------------------------

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { GhostClient } from "./ghost-client.js";
import { buildInstructions } from "./config.js";
import { registerSiteTools } from "./tools/site.js";
import { registerContentTools } from "./tools/content.js";
import { registerImageTools } from "./tools/images.js";
import { registerMemberTools } from "./tools/members.js";
import { registerMonetizationTools } from "./tools/monetization.js";
import { registerSystemTools } from "./tools/system.js";

export const SERVER_NAME = "ghost-mcp-secure";
export const SERVER_VERSION = "2.0.0";

/** Build the shared, stateless Ghost Admin API client from config. */
export function createGhostClient(cfg) {
  return new GhostClient({
    url: cfg.GHOST_API_URL,
    adminApiKey: cfg.GHOST_ADMIN_API_KEY,
    version: cfg.GHOST_API_VERSION,
  });
}

/**
 * Build a fresh McpServer with every tool group registered according to the
 * privilege flags. The `ghost` client is safe to share across servers: it
 * holds no per-request state and mints a fresh short-lived JWT on each call.
 *
 * A new McpServer is created per transport/session (stdio uses one; the remote
 * Streamable HTTP transport uses one per session) so request IDs never collide.
 */
export function createMcpServer(cfg, ghost = createGhostClient(cfg)) {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: buildInstructions(cfg.flags) }
  );

  registerSiteTools(server, ghost);
  registerContentTools(server, ghost, cfg.flags);
  registerImageTools(server, ghost, cfg.flags);
  registerMemberTools(server, ghost, cfg.flags);
  registerMonetizationTools(server, ghost, cfg.flags);
  registerSystemTools(server, ghost, cfg.flags);

  return server;
}
