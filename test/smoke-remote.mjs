// Local end-to-end smoke test for the remote (HTTP + OAuth) server.
// Drives the full OAuth 2.1 + PKCE dance with fetch, then connects an MCP
// client (bearer token) and lists tools. Not shipped; run manually:
//
//   node test/smoke-remote.mjs
//
// It starts src/http-server.js itself with throwaway credentials.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "test-password-123";
const REDIRECT = "http://localhost/callback";

const b64url = (b) => Buffer.from(b).toString("base64url");
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
};

const child = spawn(process.execPath, ["src/http-server.js"], {
  env: {
    ...process.env,
    PORT: String(PORT),
    PUBLIC_URL: BASE,
    GHOST_API_URL: "https://example.com",
    GHOST_ADMIN_API_KEY: "deadbeef:0011223344556677",
    MCP_AUTH_PASSWORD: PASSWORD,
    MCP_OAUTH_SECRET: "0123456789abcdef0123456789abcdef",
  },
  stdio: ["ignore", "inherit", "inherit"],
});

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error("server did not start");
}

try {
  await waitForServer();

  // 1) discovery
  const pr = await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json();
  check("protected-resource resource", pr.resource === `${BASE}/mcp`, pr.resource);
  check("protected-resource auth_servers", Array.isArray(pr.authorization_servers) && pr.authorization_servers[0] === BASE);

  const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  check("AS authorization_endpoint", as.authorization_endpoint === `${BASE}/authorize`);
  check("AS token_endpoint", as.token_endpoint === `${BASE}/token`);
  check("AS registration_endpoint", as.registration_endpoint === `${BASE}/register`);
  check("AS PKCE S256", JSON.stringify(as.code_challenge_methods_supported) === JSON.stringify(["S256"]));

  // 2) dynamic client registration
  const reg = await (
    await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "smoke" }),
    })
  ).json();
  check("DCR client_id issued", typeof reg.client_id === "string" && reg.client_id.startsWith("ghmcp_"), reg.client_id?.slice(0, 16) + "…");
  const clientId = reg.client_id;

  // 3) PKCE
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());

  // 4) authorize GET → login page
  const authUrl = `${BASE}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(
    REDIRECT
  )}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz&resource=${encodeURIComponent(BASE + "/mcp")}`;
  const authGet = await fetch(authUrl);
  const authHtml = await authGet.text();
  check("authorize GET shows login", authGet.status === 200 && authHtml.includes("Access password"));

  // 5) authorize POST (correct password) → 302 with code
  const form = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    resource: `${BASE}/mcp`,
    password: PASSWORD,
  });
  const authPost = await fetch(`${BASE}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "manual",
  });
  const loc = authPost.headers.get("location") || "";
  const code = new URL(loc).searchParams.get("code");
  check("authorize POST redirects with code", authPost.status === 302 && !!code && new URL(loc).searchParams.get("state") === "xyz");

  // 5b) wrong password → no code, login re-shown
  const badPost = await fetch(`${BASE}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...Object.fromEntries(form), password: "wrong" }).toString(),
    redirect: "manual",
  });
  check("wrong password rejected", badPost.status === 200 && (await badPost.text()).includes("Incorrect password"));

  // 6) token exchange (authorization_code) with PKCE verifier
  const tok = await (
    await fetch(`${BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    })
  ).json();
  check("token: access_token", typeof tok.access_token === "string");
  check("token: refresh_token", typeof tok.refresh_token === "string");
  check("token: Bearer/expiry", tok.token_type === "Bearer" && tok.expires_in === 3600);
  const accessToken = tok.access_token;

  // 6b) bad PKCE verifier rejected
  const badPkce = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: "wrong-verifier",
    }).toString(),
  });
  check("bad PKCE rejected", badPkce.status === 400);

  // 6c) refresh_token grant
  const refreshed = await (
    await fetch(`${BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token }).toString(),
    })
  ).json();
  check("refresh grant returns new access", typeof refreshed.access_token === "string");

  // 7) /mcp without token → 401 + WWW-Authenticate
  const noAuth = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  check("unauthenticated /mcp → 401", noAuth.status === 401 && /resource_metadata=/.test(noAuth.headers.get("www-authenticate") || ""));

  // 8) MCP client with bearer token: initialize + tools/list
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "smoke", version: "1.0.0" });
  await client.connect(transport); // performs initialize handshake
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  check("MCP initialize + tools/list works", names.length > 0, `${names.length} tools`);
  check("read-only set == 7 tools", names.length === 7, names.join(", "));
  check("has ghost_site_info", names.includes("ghost_site_info"));
  check("no write tool in read-only mode", !names.includes("ghost_create_post"));
  await client.close();
} catch (e) {
  console.log("FAIL  exception:", e?.stack || e?.message || e);
  failures++;
} finally {
  child.kill("SIGTERM");
}

await sleep(150);
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
