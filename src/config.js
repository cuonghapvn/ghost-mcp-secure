// config.js — environment parsing and privilege flags.
// ------------------------------------------------------------------
// Secure-by-default: everything is read-only until a flag opts in.
// Each capability domain has its own env flag, plus two cross-cutting
// sub-gates (publish, delete) that further restrict dangerous actions.
// ------------------------------------------------------------------

const bool = (v) => String(v ?? "").toLowerCase() === "true";

// Accept a PUBLIC_URL only if it's a real absolute http(s) origin. This guards
// against footguns like an unresolved Railway reference (`https://${{...}}` ->
// "https://" -> "https:") which would otherwise become an invalid base URL and
// make every request throw. Returns a normalized "scheme://host[:port]" or null
// so the server falls back to deriving the origin from request headers.
export function sanitizePublicUrl(raw) {
  const v = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!v) return null;
  try {
    const u = new URL(v);
    // Reject anything that isn't a real http(s) origin: bad scheme, missing
    // host, or a host that still contains template junk (e.g. an unresolved
    // "${{RAILWAY_PUBLIC_DOMAIN}}") rather than a plain domain / IP.
    const validHost = /^[a-z0-9.-]+$/i.test(u.hostname) || /^\[[0-9a-f:]+\]$/i.test(u.hostname);
    if ((u.protocol === "http:" || u.protocol === "https:") && validHost) {
      return `${u.protocol}//${u.host}`;
    }
  } catch {
    /* not a valid absolute URL */
  }
  return null;
}

export function loadConfig(env = process.env) {
  const {
    GHOST_API_URL,
    GHOST_ADMIN_API_KEY,
    GHOST_API_VERSION = "v6.0",
  } = env;

  const flags = {
    write: bool(env.GHOST_WRITE_ENABLED), // create/update content + upload images
    publish: bool(env.GHOST_ALLOW_PUBLISH), // allow status -> published/scheduled
    allowDelete: bool(env.GHOST_ALLOW_DELETE), // any delete tool
    members: bool(env.GHOST_ALLOW_MEMBERS), // member tools (PII)
    monetization: bool(env.GHOST_ALLOW_MONETIZATION), // tiers/offers/newsletters
    system: bool(env.GHOST_ALLOW_SYSTEM), // settings/webhooks/users/themes
  };

  return { GHOST_API_URL, GHOST_ADMIN_API_KEY, GHOST_API_VERSION, flags };
}

// --------------------------------------------------------------------------
// Remote (HTTP + OAuth) configuration — only used by src/http-server.js.
// The local stdio entrypoint ignores all of this.
// --------------------------------------------------------------------------
//
// Secure-by-default applies here too: the public HTTP endpoint holds your
// Ghost Admin key server-side, so it MUST be gated. We require both
//   * MCP_AUTH_PASSWORD  — the human gate shown on the OAuth login screen, and
//   * MCP_OAUTH_SECRET   — the HMAC key that signs OAuth codes/tokens
// and refuse to start without them.
export function loadRemoteConfig(env = process.env) {
  const remote = {
    // Cloud Run injects PORT (defaults to 8080); fall back to it.
    port: Number(env.PORT || 8080),
    // Stable public origin, e.g. https://ghost-mcp-xxxx.run.app — no trailing slash.
    // If unset (or malformed) we derive it per-request from X-Forwarded-Proto +
    // Host, but a fixed value is strongly recommended so the OAuth issuer never
    // drifts. Invalid values are rejected so they can't break request parsing.
    publicUrl: sanitizePublicUrl(env.PUBLIC_URL),
    // Human gate for the OAuth authorization screen.
    authPassword: env.MCP_AUTH_PASSWORD || "",
    // HMAC secret for signing OAuth authorization codes + access/refresh tokens.
    oauthSecret: env.MCP_OAUTH_SECRET || "",
    // Access-token lifetime (seconds). Default 1h.
    accessTtl: Number(env.MCP_ACCESS_TTL || 3600),
    // Refresh-token lifetime (seconds). Default 30d.
    refreshTtl: Number(env.MCP_REFRESH_TTL || 60 * 60 * 24 * 30),
    // Mount the deprecated SSE transport for older ChatGPT clients (default on).
    enableSse: String(env.MCP_ENABLE_SSE ?? "true").toLowerCase() !== "false",
  };
  return remote;
}

// Validate remote config and return a list of human-readable problems
// (empty array = OK). Kept separate so http-server can print a clear message.
export function validateRemoteConfig(cfg, remote) {
  const problems = [];
  if (!cfg.GHOST_API_URL) problems.push("GHOST_API_URL is required.");
  if (!cfg.GHOST_ADMIN_API_KEY) problems.push("GHOST_ADMIN_API_KEY is required.");
  if (!remote.authPassword) {
    problems.push("MCP_AUTH_PASSWORD is required (the OAuth login gate for the public endpoint).");
  }
  if (!remote.oauthSecret || remote.oauthSecret.length < 16) {
    problems.push("MCP_OAUTH_SECRET is required and must be at least 16 chars (e.g. `openssl rand -hex 32`).");
  }
  return problems;
}

// Human-readable summary of the active privilege tier, for the startup log.
export function describeMode(flags) {
  const on = [];
  if (flags.write) on.push("write");
  if (flags.publish) on.push("publish");
  if (flags.allowDelete) on.push("delete");
  if (flags.members) on.push("members");
  if (flags.monetization) on.push("monetization");
  if (flags.system) on.push("system");
  return on.length ? on.join("+") : "read-only";
}

// Build the MCP server instructions string from the active flags so the
// model is told exactly what it can and cannot do this session.
export function buildInstructions(flags) {
  const lines = [
    "Tools for managing a Ghost CMS blog. Reading posts/pages/tags/site info is always allowed.",
    flags.write
      ? "Content writing is ENABLED: you may create and edit posts, pages, and tags, and upload images."
      : "Content writing is DISABLED: only read tools are available for content.",
    flags.publish
      ? "Publishing is permitted via an explicit status on create/update (draft/published/scheduled)."
      : "Publishing is disabled; new content stays draft and you cannot change a post's status to published.",
    flags.allowDelete
      ? "Deletion is ENABLED for this session. Always confirm with the user before deleting anything; deletes are irreversible."
      : "Deletion is DISABLED; no delete tool exists in this session.",
    flags.members
      ? "Member management is ENABLED. Member data is sensitive PII — never expose it unnecessarily and confirm before edits/deletes."
      : "Member management is DISABLED; member data is not accessible.",
    flags.monetization
      ? "Monetization tools (tiers/offers/newsletters) are ENABLED. These affect billing and bulk email — confirm before changes."
      : "Monetization tools are DISABLED.",
    flags.system
      ? "System tools (settings/webhooks/users/themes) are ENABLED. These are high-privilege admin actions — confirm before any change."
      : "System tools are DISABLED.",
    "Before creating, editing, or deleting, confirm the title/intent with the user if there is any ambiguity.",
  ];
  return lines.join(" ");
}
