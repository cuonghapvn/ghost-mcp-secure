// helpers.js — shared tool-result builders, slimmers, and upload utilities.

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export const CHARACTER_LIMIT = 25000; // cap any single tool result to keep context lean

export function ok(data) {
  let text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  if (text.length > CHARACTER_LIMIT) {
    text = text.slice(0, CHARACTER_LIMIT) + `\n…[truncated at ${CHARACTER_LIMIT} chars]`;
  }
  return { content: [{ type: "text", text }] };
}

export function fail(message) {
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

// ---- Slimmers: trim Ghost objects to the fields that matter, to save context ----

export function slimPost(p) {
  if (!p) return p;
  return {
    id: p.id,
    title: p.title,
    slug: p.slug,
    status: p.status,
    visibility: p.visibility,
    featured: p.featured,
    url: p.url,
    excerpt: p.excerpt || p.custom_excerpt,
    tags: (p.tags || []).map((t) => t.name),
    authors: (p.authors || []).map((a) => a.name),
    published_at: p.published_at,
    updated_at: p.updated_at,
    reading_time: p.reading_time,
  };
}

// Pages share the same shape as posts.
export const slimPage = slimPost;

export function slimTag(t) {
  if (!t) return t;
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    description: t.description,
    visibility: t.visibility,
    count: t.count?.posts,
    url: t.url,
  };
}

export function slimMember(m) {
  if (!m) return m;
  return {
    id: m.id,
    email: m.email,
    name: m.name,
    status: m.status,
    subscribed: m.subscribed,
    labels: (m.labels || []).map((l) => l.name),
    tiers: (m.tiers || []).map((t) => t.name),
    note: m.note,
    created_at: m.created_at,
  };
}

export function slimTier(t) {
  if (!t) return t;
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    active: t.active,
    type: t.type,
    visibility: t.visibility,
    monthly_price: t.monthly_price,
    yearly_price: t.yearly_price,
    currency: t.currency,
    trial_days: t.trial_days,
  };
}

export function slimOffer(o) {
  if (!o) return o;
  return {
    id: o.id,
    name: o.name,
    code: o.code,
    status: o.status,
    type: o.type,
    cadence: o.cadence,
    amount: o.amount,
    duration: o.duration,
    currency: o.currency,
    tier: o.tier?.name,
  };
}

export function slimNewsletter(n) {
  if (!n) return n;
  return {
    id: n.id,
    name: n.name,
    slug: n.slug,
    status: n.status,
    description: n.description,
    subscribe_on_signup: n.subscribe_on_signup,
    sender_email: n.sender_email,
    sender_name: n.sender_name,
  };
}

export function slimUser(u) {
  if (!u) return u;
  return {
    id: u.id,
    name: u.name,
    slug: u.slug,
    email: u.email,
    status: u.status,
    roles: (u.roles || []).map((r) => r.name),
    url: u.url,
  };
}

export function slimWebhook(w) {
  if (!w) return w;
  return {
    id: w.id,
    event: w.event,
    target_url: w.target_url,
    name: w.name,
    status: w.status,
    last_triggered_at: w.last_triggered_at,
  };
}

// ---- Upload utilities ----

const MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".zip": "application/zip",
};

export function guessMime(filename) {
  const dot = filename.lastIndexOf(".");
  const ext = dot === -1 ? "" : filename.slice(dot).toLowerCase();
  return MIME[ext] || "application/octet-stream";
}

const EXT_FOR_MIME = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/x-icon": ".ico",
};

// Load raw bytes from exactly one of: a local file path, a remote URL, or a
// base64 string (raw, or a full `data:` URI). Returns { data, filename, contentType }.
// `filename` (with extension) can be supplied to override/aid type detection.
export async function loadBytes({ path, url, data_base64, filename } = {}) {
  const provided = [path, url, data_base64].filter((v) => v !== undefined && v !== null && v !== "");
  if (provided.length !== 1) {
    throw new Error("Provide exactly one of 'path', 'url', or 'data_base64'.");
  }

  if (path) {
    const data = await readFile(path);
    const name = filename || basename(path);
    return { data, filename: name, contentType: guessMime(name) };
  }

  if (url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    let name = filename;
    if (!name) {
      try {
        name = basename(new URL(url).pathname) || "upload";
      } catch {
        name = "upload";
      }
    }
    const guessed = guessMime(name);
    const headerType = res.headers.get("content-type")?.split(";")[0]?.trim();
    const contentType = guessed !== "application/octet-stream" ? guessed : headerType || guessed;
    return { data, filename: name, contentType };
  }

  // data_base64: accept a raw base64 string or a full `data:<mime>;base64,<...>` URI.
  let b64 = data_base64;
  let uriMime;
  if (b64.startsWith("data:")) {
    const comma = b64.indexOf(",");
    if (comma !== -1) {
      uriMime = b64.slice(5, comma).split(";")[0] || undefined;
      b64 = b64.slice(comma + 1);
    }
  }
  const data = Buffer.from(b64, "base64");
  if (data.length === 0) throw new Error("data_base64 decoded to 0 bytes (invalid base64?).");
  const name = filename || "image" + (EXT_FOR_MIME[uriMime] || ".png");
  const contentType = uriMime || guessMime(name);
  return { data, filename: name, contentType };
}
