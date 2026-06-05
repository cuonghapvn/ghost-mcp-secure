#!/usr/bin/env node
// Ghost MCP (secure-by-default, full Admin API capability behind env flags)
// ------------------------------------------------------------------
// LOCAL entrypoint: stdio transport for Claude Desktop / Claude Code.
// For the remote (claude.ai / ChatGPT) deployment, see src/http-server.js.
//
// Security posture (see config.js for the flag matrix):
//   * READ tools for posts/pages/tags/site are ALWAYS available.
//   * Every mutating capability is OFF until its env flag opts in:
//       GHOST_WRITE_ENABLED       -> create/update content + upload images/themes
//       GHOST_ALLOW_PUBLISH       -> set status to published/scheduled
//       GHOST_ALLOW_DELETE        -> any delete tool
//       GHOST_ALLOW_MEMBERS       -> member tools (PII)
//       GHOST_ALLOW_MONETIZATION  -> tiers/offers/newsletters
//       GHOST_ALLOW_SYSTEM        -> settings/webhooks/users/themes
//   * Delete tools simply DO NOT EXIST when GHOST_ALLOW_DELETE is off — they cannot be invoked.
//   * The admin secret is never logged and never returned to the model.
// ------------------------------------------------------------------

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig, describeMode } from "./config.js";
import { createGhostClient, createMcpServer } from "./core.js";

// stderr only — stdout is the JSON-RPC channel and must not be polluted.
const log = (...a) => console.error("[ghost-mcp]", ...a);

const cfg = loadConfig();

if (!cfg.GHOST_API_URL || !cfg.GHOST_ADMIN_API_KEY) {
  log("FATAL: GHOST_API_URL and GHOST_ADMIN_API_KEY must be set.");
  process.exit(1);
}

const ghost = createGhostClient(cfg);
const server = createMcpServer(cfg, ghost);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`Ready. mode=${describeMode(cfg.flags)} site=${cfg.GHOST_API_URL}`);
}

main().catch((e) => {
  log("FATAL:", e.message);
  process.exit(1);
});
