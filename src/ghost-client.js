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
   */
  constructor({ url, adminApiKey, version = "v6.0" }) {
    if (!url) throw new Error("GHOST_API_URL is required.");
    if (!adminApiKey) throw new Error("GHOST_ADMIN_API_KEY is required.");
    this.baseUrl = url.replace(/\/+$/, "");
    this.adminApiKey = adminApiKey;
    this.version = version;
  }

  async #request(method, path, { query, body, formData } = {}) {
    const token = makeAdminToken(this.adminApiKey);
    const qs = query ? "?" + new URLSearchParams(query).toString() : "";
    const endpoint = `${this.baseUrl}${ADMIN_PATH}${path}${qs}`;

    const headers = {
      Authorization: `Ghost ${token}`,
      "Accept-Version": this.version,
    };

    let payload;
    if (formData) {
      // Let fetch set multipart/form-data with the correct boundary; do not set Content-Type.
      payload = formData;
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(endpoint, { method, headers, body: payload });
    } catch (e) {
      // Network-level failure. Do not leak the token; the endpoint contains no secret.
      throw new Error(`Network error calling Ghost (${method} ${path}): ${e.message}`);
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
