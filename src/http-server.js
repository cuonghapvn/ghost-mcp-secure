#!/usr/bin/env node
// http-server.js — REMOTE entrypoint: Streamable HTTP + OAuth 2.1.
// ------------------------------------------------------------------
// For hosted use with claude.ai custom connectors and ChatGPT Developer Mode.
// (The local stdio entrypoint is src/index.js.)
//
//   * Transport: MCP Streamable HTTP at POST/GET/DELETE /mcp (stateful sessions,
//     in-memory), plus a deprecated SSE bridge at GET /sse + POST /messages for
//     older ChatGPT clients. Run a single instance (or use sticky sessions) —
//     session state lives in memory.
//   * Auth: every /mcp and /sse request requires an OAuth 2.1 Bearer token.
//     Discovery, dynamic client registration, the PKCE authorization flow, and
//     token issuance are all served from this process (see src/oauth.js).
//   * The Ghost privilege flags still govern what the model can DO; OAuth only
//     governs WHO may connect.
// ------------------------------------------------------------------

import http from "node:http";
import { randomUUID } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

import { loadConfig, loadRemoteConfig, validateRemoteConfig, describeMode } from "./config.js";
import { createGhostClient, createMcpServer, SERVER_NAME, SERVER_VERSION } from "./core.js";
import { createOAuth, CALLBACK_CLAUDE } from "./oauth.js";

const log = (...a) => console.error("[ghost-mcp:http]", ...a);

const MAX_OAUTH_BODY = 64 * 1024; // 64 KB for OAuth form/JSON bodies
const MAX_MCP_BODY = 30 * 1024 * 1024; // 30 MB to allow base64 image uploads

// ---- bootstrap -----------------------------------------------------------

const cfg = loadConfig();
const remote = loadRemoteConfig();

const problems = validateRemoteConfig(cfg, remote);
if (problems.length) {
  log("FATAL: remote server misconfigured:");
  for (const p of problems) log("  - " + p);
  log("See README (Remote deployment) and .env.example for the required variables.");
  process.exit(1);
}

const ghost = createGhostClient(cfg);
const oauth = createOAuth({
  secret: remote.oauthSecret,
  password: remote.authPassword,
  accessTtl: remote.accessTtl,
  refreshTtl: remote.refreshTtl,
  resourceName: SERVER_NAME,
});

// Session stores (in-memory — single instance / sticky sessions).
const mcpSessions = new Map(); // Mcp-Session-Id -> { transport, server }
const sseSessions = new Map(); // sse sessionId   -> { transport, server }

// ---- helpers -------------------------------------------------------------

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, mcp-protocol-version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
  "Access-Control-Max-Age": "86400",
};

function setCors(res) {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
}

function baseUrl(req) {
  if (remote.publicUrl) return remote.publicUrl;
  const proto = (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim()
    || (req.socket.encrypted ? "https" : "http");
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "localhost").toString().split(",")[0].trim();
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJson(buf) {
  if (!buf || buf.length === 0) return undefined;
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return undefined;
  }
}

function parseForm(buf) {
  return Object.fromEntries(new URLSearchParams(buf.toString("utf8")));
}

function sendJson(res, status, obj, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(obj));
}

function sendText(res, status, text, headers = {}) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(text);
}

// Render a { status, headers?, body?, json? } result from the OAuth module.
function sendResult(res, result) {
  const headers = result.headers || {};
  if (result.json !== undefined) return sendJson(res, result.status, result.json, headers);
  res.writeHead(result.status, headers);
  res.end(result.body || "");
}

const isInitialize = (body) =>
  Array.isArray(body) ? body.some((m) => m && m.method === "initialize") : body?.method === "initialize";

// Verify the Bearer token; on failure write a 401 with WWW-Authenticate and
// return null. On success return the token payload.
function requireAuth(req, res, base) {
  const header = (req.headers.authorization || "").toString();
  const m = /^Bearer\s+(.+)$/i.exec(header);
  const token = m && m[1];
  const payload = token ? oauth.verifyAccessToken(token, base) : null;
  if (payload) return payload;

  const prUrl = `${base}/.well-known/oauth-protected-resource`;
  const wwwAuth = token
    ? `Bearer error="invalid_token", error_description="The access token is invalid or expired", resource_metadata="${prUrl}"`
    : `Bearer resource_metadata="${prUrl}"`;
  sendJson(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": wwwAuth });
  return null;
}

// ---- MCP transport handling ---------------------------------------------

async function handleMcp(req, res) {
  const sid = req.headers["mcp-session-id"];

  // Existing session: route straight to its transport.
  if (sid && mcpSessions.has(sid)) {
    const { transport } = mcpSessions.get(sid);
    const body = req.method === "POST" ? parseJson(await readBody(req, MAX_MCP_BODY)) : undefined;
    return transport.handleRequest(req, res, body);
  }

  // No session yet — only an initialize POST may open one.
  if (req.method !== "POST") {
    return sendJson(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "No valid session; send an initialize request first." },
      id: null,
    });
  }
  const body = parseJson(await readBody(req, MAX_MCP_BODY));
  if (!isInitialize(body)) {
    return sendJson(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: no session id and not an initialize request." },
      id: null,
    });
  }

  let entry;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      mcpSessions.set(id, entry);
      log("session open", id);
    },
  });
  transport.onclose = () => {
    const id = transport.sessionId;
    if (id && mcpSessions.delete(id)) log("session close", id);
  };
  const server = createMcpServer(cfg, ghost);
  entry = { transport, server };
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

// ---- legacy SSE bridge ---------------------------------------------------

async function handleSseConnect(res) {
  const transport = new SSEServerTransport("/messages", res);
  const server = createMcpServer(cfg, ghost);
  const cleanup = () => {
    if (sseSessions.delete(transport.sessionId)) log("sse close", transport.sessionId);
    server.close().catch(() => {});
  };
  sseSessions.set(transport.sessionId, { transport, server });
  res.on("close", cleanup);
  transport.onclose = cleanup;
  await server.connect(transport); // emits the 'endpoint' event (/messages?sessionId=…)
  log("sse open", transport.sessionId);
}

async function handleSseMessage(req, res, query) {
  const entry = query.sessionId && sseSessions.get(query.sessionId);
  if (!entry) return sendJson(res, 404, { error: "unknown_session" });
  const body = parseJson(await readBody(req, MAX_MCP_BODY));
  return entry.transport.handlePostMessage(req, res, body);
}

// ---- landing page --------------------------------------------------------

function landingPage(base) {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${SERVER_NAME}</title>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#e6edf3;max-width:42rem;margin:0 auto;padding:3rem 1.25rem;line-height:1.55">
  <h1 style="font-size:1.4rem">${SERVER_NAME} <span style="color:#8b949e;font-weight:400">v${SERVER_VERSION}</span></h1>
  <p style="color:#8b949e">Secure-by-default MCP server for Ghost CMS. Mode: <code>${describeMode(cfg.flags)}</code>.</p>
  <p>MCP endpoint (add this URL as a connector):</p>
  <pre style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:.8rem 1rem;overflow:auto">${base}/mcp</pre>
  <p style="color:#8b949e;font-size:.9rem">OAuth 2.1 + PKCE is required. Discovery:
  <a style="color:#58a6ff" href="${base}/.well-known/oauth-protected-resource">protected-resource</a> ·
  <a style="color:#58a6ff" href="${base}/.well-known/oauth-authorization-server">authorization-server</a></p>
</body></html>`;
}

// ---- router --------------------------------------------------------------

const httpServer = http.createServer(async (req, res) => {
  try {
    setCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    const base = baseUrl(req);
    const url = new URL(req.url, base);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const query = Object.fromEntries(url.searchParams);

    // Health + landing
    if (req.method === "GET" && path === "/healthz") return sendText(res, 200, "ok");
    if (req.method === "GET" && path === "/") return sendResult(res, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: landingPage(base) });

    // OAuth discovery (tolerate optional path suffixes, e.g. .../mcp)
    if (req.method === "GET" && path.startsWith("/.well-known/oauth-protected-resource"))
      return sendJson(res, 200, oauth.prMetadata(base));
    if (
      req.method === "GET" &&
      (path.startsWith("/.well-known/oauth-authorization-server") ||
        path.startsWith("/.well-known/openid-configuration"))
    )
      return sendJson(res, 200, oauth.asMetadata(base));

    // Dynamic client registration
    if (req.method === "POST" && path === "/register") {
      const body = parseJson(await readBody(req, MAX_OAUTH_BODY));
      return sendResult(res, oauth.handleRegister(body));
    }

    // Authorization endpoint (login screen + consent)
    if (path === "/authorize") {
      if (req.method === "GET") return sendResult(res, oauth.renderAuthorize(query));
      if (req.method === "POST") {
        const form = parseForm(await readBody(req, MAX_OAUTH_BODY));
        return sendResult(res, oauth.handleAuthorizeSubmit(form));
      }
    }

    // Token endpoint
    if (req.method === "POST" && path === "/token") {
      const form = parseForm(await readBody(req, MAX_OAUTH_BODY));
      return sendResult(res, oauth.handleToken(form, base));
    }

    // MCP — Streamable HTTP (requires auth)
    if (path === "/mcp") {
      if (!requireAuth(req, res, base)) return;
      return handleMcp(req, res);
    }

    // MCP — legacy SSE bridge (requires auth)
    if (remote.enableSse && path === "/sse" && req.method === "GET") {
      if (!requireAuth(req, res, base)) return;
      return handleSseConnect(res);
    }
    if (remote.enableSse && path === "/messages" && req.method === "POST") {
      if (!requireAuth(req, res, base)) return;
      return handleSseMessage(req, res, query);
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (e) {
    log("request error:", e?.message);
    if (!res.headersSent) sendJson(res, 500, { error: "server_error" });
    else
      try {
        res.end();
      } catch {
        /* ignore */
      }
  }
});

httpServer.listen(remote.port, () => {
  log(`Ready. mode=${describeMode(cfg.flags)} site=${cfg.GHOST_API_URL}`);
  log(`Listening on :${remote.port}`);
  log(remote.publicUrl ? `Public URL: ${remote.publicUrl}` : "PUBLIC_URL not set — deriving origin from request headers (set it for stable OAuth metadata).");
  log(`claude.ai callback expected: ${CALLBACK_CLAUDE}`);
});

// Cloud Run sends SIGTERM on shutdown.
process.on("SIGTERM", () => httpServer.close(() => process.exit(0)));
process.on("SIGINT", () => httpServer.close(() => process.exit(0)));
