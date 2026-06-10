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
  ".svgz": "image/svg+xml",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".heif": "image/heic",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
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
  "image/avif": ".avif",
  "image/heic": ".heic",
  "image/bmp": ".bmp",
  "image/tiff": ".tif",
};

// Largest payload we'll accept for an upload, regardless of source. Guards
// against pulling a multi-hundred-MB remote file into memory and against
// blowing the remote transport's body limit. Ghost itself caps much lower.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

// Sent when downloading a remote image: some CDNs (Wikipedia, etc.) reject
// requests with no User-Agent, which showed up as flaky "download failed".
const URL_FETCH_UA =
  "Mozilla/5.0 (compatible; ghost-mcp-secure/2.0; +https://github.com/cuonghapvn/ghost-mcp-secure)";
const URL_FETCH_TIMEOUT_MS = 30000;

// Detect an image type from its leading bytes ("magic numbers"). This is the
// source of truth for content type: a filename extension or a chat-provided
// data: URI is often wrong/absent, but the bytes never lie. Returns an
// `image/*` mime or null when the bytes aren't a recognized image.
export function sniffImageMime(buf) {
  if (!buf || buf.length < 4) return null;
  const b = buf;
  // PNG: 89 50 4E 47
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  // GIF: "GIF8"
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  // BMP: "BM"
  if (b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  // ICO: 00 00 01 00
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return "image/x-icon";
  // TIFF: "II*\0" (little-endian) or "MM\0*" (big-endian)
  if (
    (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
    (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)
  )
    return "image/tiff";
  // WEBP: "RIFF"...."WEBP"
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  )
    return "image/webp";
  // ISO-BMFF (....ftyp<brand>): AVIF / HEIC share this container.
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = b.toString("ascii", 8, 12);
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) return "image/heic";
  }
  // SVG is text — inspect a short, trimmed prefix.
  const head = b.subarray(0, 256).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return "image/svg+xml";
  }
  return null;
}

// Load raw bytes from exactly one of: a local file path, a remote URL, or a
// base64 string (raw, or a full `data:` URI). Returns { data, filename, contentType }.
// `filename` (with extension) can be supplied to override/aid type detection.
//
// The three sources converge on one reconciliation step that trusts the bytes
// first (magic-byte sniff), then any source-provided type, then the filename —
// so a mislabelled or extension-less image still uploads with the right type.
export async function loadBytes({ path, url, data_base64, filename } = {}) {
  const provided = [path, url, data_base64].filter((v) => v !== undefined && v !== null && v !== "");
  if (provided.length !== 1) {
    throw new Error("Provide exactly one of 'path', 'url', or 'data_base64'.");
  }

  let data;
  let name = filename;
  let hintType; // type asserted by the source (data: URI mime / HTTP header)

  if (path) {
    data = await readFile(path);
    if (!name) name = basename(path);
  } else if (url) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), URL_FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        signal: ac.signal,
        redirect: "follow",
        headers: { "user-agent": URL_FETCH_UA, accept: "image/*,*/*;q=0.8" },
      });
    } catch (e) {
      throw new Error(
        e.name === "AbortError"
          ? `Timed out downloading ${url} (>${URL_FETCH_TIMEOUT_MS}ms).`
          : `Failed to download ${url}: ${e.message}`
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared && declared > MAX_UPLOAD_BYTES) {
      throw new Error(
        `Remote file is too large (${(declared / 1e6).toFixed(1)} MB; limit ${MAX_UPLOAD_BYTES / 1e6} MB).`
      );
    }
    data = Buffer.from(await res.arrayBuffer());
    if (!name) {
      try {
        name = basename(new URL(url).pathname) || "upload";
      } catch {
        name = "upload";
      }
    }
    hintType = res.headers.get("content-type")?.split(";")[0]?.trim() || undefined;
  } else {
    // data_base64: accept a raw base64 string or a full `data:<mime>;base64,<...>` URI.
    let b64 = data_base64;
    if (b64.startsWith("data:")) {
      const comma = b64.indexOf(",");
      if (comma !== -1) {
        hintType = b64.slice(5, comma).split(";")[0] || undefined;
        b64 = b64.slice(comma + 1);
      }
    }
    data = Buffer.from(b64, "base64");
    if (data.length === 0) throw new Error("data_base64 decoded to 0 bytes (invalid base64?).");
  }

  if (data.length > MAX_UPLOAD_BYTES) {
    throw new Error(
      `File is too large (${(data.length / 1e6).toFixed(1)} MB; limit ${MAX_UPLOAD_BYTES / 1e6} MB).`
    );
  }
  if (!name) name = "upload";

  // Reconcile the content type: real bytes win, then the source's claim, then
  // the filename's extension.
  const sniffed = sniffImageMime(data);
  const named = guessMime(name);
  const hinted = hintType && hintType !== "application/octet-stream" ? hintType : null;
  const contentType = sniffed || hinted || named;

  // Keep the filename extension consistent with a recognized type — Ghost
  // validates uploads on both the content type AND the extension.
  const wantExt = EXT_FOR_MIME[contentType];
  if (wantExt && guessMime(name) !== contentType) {
    const dot = name.lastIndexOf(".");
    name = (dot === -1 ? name : name.slice(0, dot)) + wantExt;
  }

  return { data, filename: name, contentType };
}
