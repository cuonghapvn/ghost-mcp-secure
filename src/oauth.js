// oauth.js — a small, stateless OAuth 2.1 + PKCE authorization server.
// ------------------------------------------------------------------
// Why this exists: the remote MCP endpoint (src/http-server.js) holds your
// Ghost Admin key server-side, so it must only let *you* drive it. claude.ai
// and ChatGPT speak the MCP authorization flow (RFC 9728 discovery, RFC 7591
// dynamic client registration, OAuth 2.1 authorization_code + PKCE). This
// module implements exactly that subset — no database, no extra dependency:
//
//   * Tokens, authorization codes, and client_ids are all HMAC-signed values
//     (node:crypto, the same primitive that signs the Ghost JWT). Verification
//     is therefore stateless — nothing is stored server-side, so it works
//     across restarts and (if ever needed) multiple instances.
//   * A single human gate (MCP_AUTH_PASSWORD) is shown on the consent screen.
//     Privilege over Ghost itself is still governed entirely by the server-side
//     env flags — OAuth only authenticates *who may connect*, never *what they
//     may do*.
//
// All handlers are pure: they take parsed input and return a plain
// { status, headers?, body?, json? } result. src/http-server.js does the I/O.
// ------------------------------------------------------------------

import crypto from "node:crypto";

const CALLBACK_CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const CLIENT_PREFIX = "ghmcp_";
const SCOPES = ["ghost"]; // single coarse scope; real authz is the env flags

// ---- low-level signing (compact HMAC-signed JSON: <payload>.<sig>) ----

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const b64urlJson = (obj) => b64url(JSON.stringify(obj));

function hmac(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest("base64url");
}

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function sign(payload, secret) {
  const body = b64urlJson(payload);
  return `${body}.${hmac(secret, body)}`;
}

function verify(token, secret) {
  if (typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, hmac(secret, body))) return null;
  let obj;
  try {
    obj = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (obj.exp && Math.floor(Date.now() / 1000) > obj.exp) return null;
  return obj;
}

const now = () => Math.floor(Date.now() / 1000);

// ---- helpers ----

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// A redirect_uri is acceptable if it is https, or a loopback http URL (for
// local testing with the MCP Inspector). javascript:/data: etc. are rejected.
function redirectUriAllowed(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.host.split(":")[0])) {
    return true;
  }
  return false;
}

function pkceS256(verifier) {
  return b64url(crypto.createHash("sha256").update(verifier).digest());
}

// Build a redirect Location with query params merged onto the redirect_uri.
function redirectTo(redirectUri, params) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, v);
  }
  return u.toString();
}

/**
 * @param {object} opts
 * @param {string} opts.secret        HMAC secret (MCP_OAUTH_SECRET)
 * @param {string} opts.password      human gate (MCP_AUTH_PASSWORD)
 * @param {number} opts.accessTtl     access-token lifetime (seconds)
 * @param {number} opts.refreshTtl    refresh-token lifetime (seconds)
 * @param {string} [opts.resourceName]
 */
export function createOAuth({ secret, password, accessTtl, refreshTtl, resourceName = "ghost-mcp-secure" }) {
  const codeTtl = 600; // authorization codes live 10 minutes

  // ---- discovery metadata ----------------------------------------------

  // RFC 8414 — authorization server metadata.
  function asMetadata(base) {
    return {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: SCOPES,
    };
  }

  // RFC 9728 — protected resource metadata (points at this AS).
  function prMetadata(base) {
    return {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: SCOPES,
      bearer_methods_supported: ["header"],
      resource_name: resourceName,
    };
  }

  // ---- dynamic client registration (RFC 7591) --------------------------

  function handleRegister(body) {
    const meta = body && typeof body === "object" ? body : {};
    const redirectUris = Array.isArray(meta.redirect_uris) ? meta.redirect_uris : [];
    if (redirectUris.length === 0) {
      return err(400, "invalid_client_metadata", "redirect_uris is required");
    }
    for (const uri of redirectUris) {
      if (!redirectUriAllowed(uri)) {
        return err(400, "invalid_redirect_uri", `redirect_uri not allowed: ${uri}`);
      }
    }
    // Encode the registration into the client_id itself → stateless.
    const clientId =
      CLIENT_PREFIX +
      sign({ typ: "client", ruris: redirectUris, name: meta.client_name || null, iat: now() }, secret);

    return {
      status: 201,
      json: {
        client_id: clientId,
        client_id_issued_at: now(),
        // public client (PKCE), no secret issued
        token_endpoint_auth_method: "none",
        grant_types: meta.grant_types || ["authorization_code", "refresh_token"],
        response_types: meta.response_types || ["code"],
        redirect_uris: redirectUris,
        client_name: meta.client_name || resourceName,
        scope: (meta.scope || SCOPES.join(" ")),
      },
    };
  }

  function parseClient(clientId) {
    if (typeof clientId !== "string" || !clientId.startsWith(CLIENT_PREFIX)) return null;
    const payload = verify(clientId.slice(CLIENT_PREFIX.length), secret);
    if (!payload || payload.typ !== "client") return null;
    return payload;
  }

  // ---- authorization endpoint ------------------------------------------

  // Validate the parts that must be trusted before we can safely redirect.
  // Returns { client, redirectUri } or an error result to send as-is.
  function preauth(q) {
    const client = parseClient(q.client_id);
    if (!client) return { error: htmlError(400, "Invalid or unknown client_id.") };
    const redirectUri = q.redirect_uri;
    if (!redirectUri || !client.ruris.includes(redirectUri)) {
      return { error: htmlError(400, "Invalid redirect_uri (not registered for this client).") };
    }
    return { client, redirectUri };
  }

  function renderAuthorize(q, errorMsg) {
    const pre = preauth(q);
    if (pre.error) return pre.error;
    const { redirectUri } = pre;
    const state = q.state;

    // Past this point redirect_uri is trusted → OAuth errors go back via redirect.
    if (q.response_type !== "code") {
      return { status: 302, headers: { Location: redirectTo(redirectUri, { error: "unsupported_response_type", state }) } };
    }
    if (!q.code_challenge || q.code_challenge_method !== "S256") {
      return { status: 302, headers: { Location: redirectTo(redirectUri, { error: "invalid_request", error_description: "PKCE S256 required", state }) } };
    }

    // Carry every parameter we need through the password form as hidden fields.
    const hidden = {
      client_id: q.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: q.code_challenge,
      code_challenge_method: "S256",
      state: state || "",
      scope: q.scope || "",
      resource: q.resource || "",
    };
    return { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: loginPage(hidden, errorMsg) };
  }

  function handleAuthorizeSubmit(form) {
    const pre = preauth(form);
    if (pre.error) return pre.error;
    const { redirectUri } = pre;
    const state = form.state;

    if (!form.password || !safeEqual(form.password, password)) {
      // Wrong password → re-show the form (do NOT redirect with a code).
      return renderAuthorize(form, "Incorrect password. Please try again.");
    }
    if (!form.code_challenge || form.code_challenge_method !== "S256") {
      return { status: 302, headers: { Location: redirectTo(redirectUri, { error: "invalid_request", state }) } };
    }

    const code = sign(
      {
        typ: "code",
        cid: form.client_id,
        ruri: redirectUri,
        cc: form.code_challenge,
        scope: form.scope || SCOPES.join(" "),
        resource: form.resource || "",
        iat: now(),
        exp: now() + codeTtl,
      },
      secret
    );
    return { status: 302, headers: { Location: redirectTo(redirectUri, { code, state }) } };
  }

  // ---- token endpoint --------------------------------------------------

  function issueTokens({ sub, scope, resource, base }) {
    const aud = resource || `${base}/mcp`;
    const access = sign({ typ: "access", sub, scope, aud, iat: now(), exp: now() + accessTtl }, secret);
    const refresh = sign({ typ: "refresh", sub, scope, aud, iat: now(), exp: now() + refreshTtl }, secret);
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: accessTtl,
      refresh_token: refresh,
      scope,
    };
  }

  function handleToken(form, base) {
    const grant = form.grant_type;

    if (grant === "authorization_code") {
      const payload = verify(form.code, secret);
      if (!payload || payload.typ !== "code") {
        return err(400, "invalid_grant", "Authorization code is invalid or expired.");
      }
      if (payload.cid !== form.client_id) {
        return err(400, "invalid_grant", "client_id does not match the authorization code.");
      }
      if (payload.ruri !== form.redirect_uri) {
        return err(400, "invalid_grant", "redirect_uri does not match the authorization code.");
      }
      if (!form.code_verifier || pkceS256(form.code_verifier) !== payload.cc) {
        return err(400, "invalid_grant", "PKCE verification failed.");
      }
      return {
        status: 200,
        json: issueTokens({ sub: crypto.randomUUID(), scope: payload.scope, resource: payload.resource, base }),
      };
    }

    if (grant === "refresh_token") {
      const payload = verify(form.refresh_token, secret);
      if (!payload || payload.typ !== "refresh") {
        return err(400, "invalid_grant", "Refresh token is invalid or expired.");
      }
      return {
        status: 200,
        json: issueTokens({ sub: payload.sub || crypto.randomUUID(), scope: payload.scope, resource: payload.aud, base }),
      };
    }

    return err(400, "unsupported_grant_type", `Unsupported grant_type: ${grant}`);
  }

  // ---- resource-server bearer verification -----------------------------

  // Returns the token payload if valid, else null. Audience is checked
  // leniently (same origin as this server) to tolerate proxy/host quirks.
  function verifyAccessToken(token, base) {
    const payload = verify(token, secret);
    if (!payload || payload.typ !== "access") return null;
    if (base && payload.aud) {
      try {
        if (new URL(payload.aud).origin !== new URL(base).origin) return null;
      } catch {
        return null;
      }
    }
    return payload;
  }

  return {
    SCOPES,
    asMetadata,
    prMetadata,
    handleRegister,
    renderAuthorize,
    handleAuthorizeSubmit,
    handleToken,
    verifyAccessToken,
  };
}

// ---- small result builders / views --------------------------------------

function err(status, error, error_description) {
  return { status, json: { error, error_description } };
}

function htmlError(status, message) {
  return {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: `<!doctype html><meta charset="utf-8"><title>Authorization error</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h1 style="font-size:1.25rem">Authorization error</h1>
<p>${escapeHtml(message)}</p></body>`,
  };
}

function loginPage(hidden, errorMsg) {
  const fields = Object.entries(hidden)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("\n      ");
  const error = errorMsg
    ? `<p style="color:#b00020;margin:0 0 1rem">${escapeHtml(errorMsg)}</p>`
    : "";
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect ghost-mcp-secure</title>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh;margin:0;display:flex;align-items:center;justify-content:center">
  <form method="POST" action="/authorize" style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:2rem;width:min(92vw,24rem);box-shadow:0 8px 30px rgba(0,0,0,.4)">
    <h1 style="font-size:1.15rem;margin:0 0 .25rem">Connect to ghost-mcp-secure</h1>
    <p style="color:#8b949e;font-size:.9rem;margin:0 0 1.25rem">Enter the access password to authorize this MCP connection.</p>
    ${error}
    <label style="display:block;font-size:.85rem;margin:0 0 .35rem">Access password</label>
    <input type="password" name="password" autofocus required autocomplete="current-password"
      style="width:100%;box-sizing:border-box;padding:.6rem .7rem;border-radius:8px;border:1px solid #30363d;background:#0d1117;color:#e6edf3;font-size:1rem">
    <button type="submit"
      style="margin-top:1.25rem;width:100%;padding:.65rem;border:0;border-radius:8px;background:#238636;color:#fff;font-size:1rem;font-weight:600;cursor:pointer">Authorize</button>
    ${fields}
  </form>
</body></html>`;
}

export { CALLBACK_CLAUDE };
