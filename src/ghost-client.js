// ghost-client.js
// Minimal, dependency-free Ghost Admin API client.
// - Generates short-lived (5 min) HS256 JWTs locally using node:crypto (no jsonwebtoken dependency).
// - Uses the native global fetch / FormData / Blob (Node 18+). No axios, no @tryghost/admin-api.
// - The admin secret is NEVER written to stdout/stderr or to the JSON-RPC channel.
//
// Generic CRUD helpers (list/getById/getBySlug/create/update/remove) cover every
// resource that follows Ghost's standard envelope ({ "<resource>": [ ... ] }).
// Special cases (settings, uploads, theme activation) get dedicated methods.

import crypto from "node:crypto";

const ADMIN_PATH = "/ghost/api/admin";

// Transient HTTP statuses worth retrying with a fresh token/connection.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Exponential backoff with jitter: ~500ms, ~1s, ~2s, ...
const backoffMs = (attempt) => 500 * 2 ** attempt + Math.floor(Math.random() * 250);

/**
 * Build a short-lived JWT for the Ghost Admin API from an `id:secret` key.
 * Reference: Ghost docs — sign empty body, kid=id, HS256, exp = iat+5min, aud="/admin/".
 */
function makeAdminToken(adminApiKey) {
  const idx = adminApiKey.indexOf(":");
  if (idx === -1) {
    throw new Error("GHOST_ADMIN_API_KEY must be in the format 'id:secret'.");
  }
  const id = adminApiKey.slice(0, idx);
  const secretHex = adminApiKey.slice(idx + 1);

  const header = { alg: "HS256", typ: "JWT", kid: id };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now, exp: now + 5 * 60, aud: "/admin/" };

  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const signingInput = `${enc(header)}.${enc(payload)}`;

  let secretBuf;
  try {
    secretBuf = Buffer.from(secretHex, "hex");
    if (secretBuf.length === 0) throw new Error("empty");
  } catch {
    throw new Error("GHOST_ADMIN_API_KEY secret part is not valid hex.");
  }

  const sig = crypto
    .createHmac("sha256", secretBuf)
    .update(signingInput)
    .digest("base64url");

  return `${signingInput}.${sig}`;
}

export class GhostClient {
  /**
   * @param {object} opts
   * @param {string} opts.url          Base site URL, e.g. https://cuongn.com
   * @param {string} opts.adminApiKey  Admin API key "id:secret"
   * @param {string} [opts.version]    Accept-Version header value, e.g. "v6.0"
   * @param {number} [opts.timeoutMs]  Per-attempt request timeout (default 60s).
   * @param {number} [opts.maxRetries] Retries for transient failures (default 2).
   */
  constructor({ url, adminApiKey, version = "v6.0", timeoutMs = 60000, maxRetries = 2 }) {
    if (!url) throw new Error("GHOST_API_URL is required.");
    if (!adminApiKey) throw new Error("GHOST_ADMIN_API_KEY is required.");
    this.baseUrl = url.replace(/\/+$/, "");
    this.adminApiKey = adminApiKey;
    this.version = version;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
  }

  async #request(method, path, { query, body, formData } = {}) {
    const qs = query ? "?" + new URLSearchParams(query).toString() : "";
    const endpoint = `${this.baseUrl}${ADMIN_PATH}${path}${qs}`;

    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Mint a fresh short-lived JWT for every attempt so a retry never reuses a
      // token that may have expired while we were backing off.
      const headers = {
        Authorization: `Ghost ${makeAdminToken(this.adminApiKey)}`,
        "Accept-Version": this.version,
      };

      let payload;
      if (formData) {
        // Reused as-is across attempts: it is backed by an in-memory Blob, so
        // fetch can re-serialize the body each time. Do not set Content-Type —
        // fetch adds the multipart boundary.
        payload = formData;
      } else if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        payload = JSON.stringify(body);
      }

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);
      let res;
      try {
        res = await fetch(endpoint, { method, headers, body: payload, signal: ac.signal });
      } catch (e) {
        // Network-level failure or timeout. Do not leak the token; the endpoint
        // contains no secret.
        lastError =
          e.name === "AbortError"
            ? new Error(`Ghost request timed out after ${this.timeoutMs}ms (${method} ${path}).`)
            : new Error(`Network error calling Ghost (${method} ${path}): ${e.message}`);
        if (attempt < this.maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timer);
      }

      // Retry transient server-side failures with a fresh token/connection.
      if (RETRYABLE_STATUS.has(res.status) && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await res.text().catch(() => {}); // drain so the socket can be reused
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt));
        continue;
      }

      const text = await res.text();
      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text };
        }
      }

      if (!res.ok) {
        const detail =
          parsed?.errors?.map((e) => e.message || e.type).join("; ") ||
          parsed?.raw ||
          `HTTP ${res.status}`;
        throw new Error(`Ghost API error (${res.status}) on ${method} ${path}: ${detail}`);
      }
      return parsed;
    }

    // Only reached if every attempt hit a transient condition and kept looping.
    throw lastError || new Error(`Ghost request failed after ${this.maxRetries + 1} attempts (${method} ${path}).`);
  }

  // ---- Generic CRUD (standard `{ "<resource>": [ ... ] }` envelope) ----
  list(resource, query) {
    return this.#request("GET", `/${resource}/`, { query });
  }
  getById(resource, id, query) {
    return this.#request("GET", `/${resource}/${encodeURIComponent(id)}/`, { query });
  }
  getBySlug(resource, slug, query) {
    return this.#request("GET", `/${resource}/slug/${encodeURIComponent(slug)}/`, { query });
  }
  create(resource, obj, { query } = {}) {
    return this.#request("POST", `/${resource}/`, { query, body: { [resource]: [obj] } });
  }
  update(resource, id, obj, { query } = {}) {
    return this.#request("PUT", `/${resource}/${encodeURIComponent(id)}/`, {
      query,
      body: { [resource]: [obj] },
    });
  }
  remove(resource, id) {
    return this.#request("DELETE", `/${resource}/${encodeURIComponent(id)}/`);
  }

  // ---- Settings (non-standard envelope: { settings: [{ key, value }] }) ----
  getSettings() {
    return this.#request("GET", "/settings/");
  }
  updateSettings(settings) {
    return this.#request("PUT", "/settings/", { body: { settings } });
  }

  // ---- Uploads (multipart/form-data) ----
  uploadImage({ data, filename, contentType, purpose, ref }) {
    const form = new FormData();
    form.append("file", new Blob([data], { type: contentType }), filename);
    if (purpose) form.append("purpose", purpose);
    if (ref) form.append("ref", ref);
    return this.#request("POST", "/images/upload/", { formData: form });
  }
  uploadTheme({ data, filename }) {
    const form = new FormData();
    form.append("file", new Blob([data], { type: "application/zip" }), filename);
    return this.#request("POST", "/themes/upload/", { formData: form });
  }
  activateTheme(name) {
    return this.#request("PUT", `/themes/${encodeURIComponent(name)}/activate/`);
  }
}

export { makeAdminToken };
