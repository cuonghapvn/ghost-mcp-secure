# ghost-mcp-secure

A **secure-by-default, full-capability** Model Context Protocol (MCP) server for Ghost CMS.

It can drive almost the entire Ghost Admin API — posts, pages, tags, images, members,
tiers, offers, newsletters, settings, webhooks, users, and themes — but **every mutating
capability is off until you explicitly opt in via an environment flag.** Out of the box it
is strictly read-only. You decide, per session, exactly how much power the assistant gets.

## Why this design

Community Ghost MCP servers usually expose the full Admin API unconditionally. That is a
large attack surface: a prompt-injected model could delete content or leak member data.
This server keeps the full feature set but puts each dangerous domain behind its own
switch, so a typical session grants only what's needed and nothing more.

## Security model

| Concern | How this server handles it |
| --- | --- |
| Read-only by default | Nothing mutates unless a flag is set. Fresh install = read-only. |
| Accidental / injected deletion | Delete tools **do not exist** unless `GHOST_ALLOW_DELETE=true`. They cannot be invoked otherwise. |
| Accidental publishing | New content is always created as a draft. Publishing needs `GHOST_ALLOW_PUBLISH=true`. |
| Member (PII) data | Member tools don't exist unless `GHOST_ALLOW_MEMBERS=true`. |
| High-privilege admin | Settings/webhooks/users/themes are off unless `GHOST_ALLOW_SYSTEM=true`. |
| Supply chain | Pinned versions, only 2 runtime deps (`@modelcontextprotocol/sdk`, `zod`). No `npx -y` latest-pulling. |
| Secret leakage | Admin secret is never logged and never returned to the model. JWTs are short-lived (5 min) and generated locally with `node:crypto`. |
| Context bloat | Tool results are slimmed and capped at 25k chars. |

### Privilege flags (via env)

All default to `false`. Reads of posts/pages/tags/site are always available.

| Flag | Unlocks |
| --- | --- |
| `GHOST_WRITE_ENABLED` | Create/update posts, pages, tags; upload images & themes |
| `GHOST_ALLOW_PUBLISH` | Set content status to `published` / `scheduled` |
| `GHOST_ALLOW_DELETE` | All delete tools (posts, pages, tags, members, webhooks, users) |
| `GHOST_ALLOW_MEMBERS` | Member tools (read + write of PII) |
| `GHOST_ALLOW_MONETIZATION` | Tiers, offers, newsletters |
| `GHOST_ALLOW_SYSTEM` | Settings, webhooks, users, theme upload/activate |

> Treat deletion and publishing as deliberate actions: enable those flags only for the
> session where you actually intend to use them. A delete tool that doesn't exist can't be
> triggered by a stray prompt.

## Setup

```bash
npm install            # installs the 2 pinned deps
cp .env.example .env   # then fill in your URL + Admin API key + the flags you want
```

> **How env vars are loaded:** the server reads variables straight from its environment —
> it does not auto-load `.env`. With Claude Desktop/Code, set them in the MCP client
> config's `env` block (see below). The `.env` file only takes effect if you launch the
> server yourself with `node --env-file=.env src/index.js` (Node ≥ 20.6).

### Getting an Admin API key

Ghost Admin → **Settings → Integrations → Add custom integration**. Copy the **Admin API
Key** (format `id:secret`). Keep it private — it grants admin access to the Ghost API, so
treat it like a password. Create the integration specifically for this tool so you can
revoke just this key later without affecting anything else.

### Connect to Claude Desktop / Claude Code

Add to `claude_desktop_config.json` (or your MCP client config). Use an **absolute path**:

```json
{
  "mcpServers": {
    "ghost": {
      "command": "node",
      "args": ["/absolute/path/to/ghost-mcp-secure/src/index.js"],
      "env": {
        "GHOST_API_URL": "https://cuongn.com",
        "GHOST_ADMIN_API_KEY": "id:secret",
        "GHOST_WRITE_ENABLED": "true",
        "GHOST_ALLOW_PUBLISH": "false",
        "GHOST_ALLOW_DELETE": "false",
        "GHOST_ALLOW_MEMBERS": "false",
        "GHOST_ALLOW_MONETIZATION": "false",
        "GHOST_ALLOW_SYSTEM": "false"
      }
    }
  }
}
```

Set only the flags you need. Omit one and it defaults to `false`.

## Tools

**Read — always available**
- `ghost_site_info` — title, description, version, url.
- `ghost_list_posts` / `ghost_get_post` — list (filter by status/tag, paginate) / fetch one with full HTML.
- `ghost_list_pages` / `ghost_get_page` — same, for pages.
- `ghost_list_tags` / `ghost_get_tag` — tags with post counts.

**Content write — `GHOST_WRITE_ENABLED`**
- `ghost_create_post` / `ghost_update_post` — defaults to draft; `status` honored only with `GHOST_ALLOW_PUBLISH`.
- `ghost_create_page` / `ghost_update_page` — same, for pages.
- `ghost_create_tag` / `ghost_update_tag`.
- `ghost_upload_image` — upload from a local path, a remote URL, or base64 bytes / data URI (`data_base64`, for images pasted in chat); returns the hosted URL. Use `url`/`data_base64` when the server is remote (no local disk access).

**Delete — `GHOST_ALLOW_DELETE`** (irreversible)
- `ghost_delete_post`, `ghost_delete_page`, `ghost_delete_tag` (+ member/webhook/user delete when those domains are on).

**Members — `GHOST_ALLOW_MEMBERS`**
- `ghost_list_members`, `ghost_get_member`, `ghost_create_member`, `ghost_update_member`, `ghost_delete_member`.

**Monetization — `GHOST_ALLOW_MONETIZATION`**
- Tiers: `ghost_list_tiers`, `ghost_create_tier`, `ghost_update_tier` (archive via `active=false`).
- Offers: `ghost_list_offers`, `ghost_create_offer`, `ghost_update_offer` (archive via `status`).
- Newsletters: `ghost_list_newsletters`, `ghost_create_newsletter`, `ghost_update_newsletter`.

**System — `GHOST_ALLOW_SYSTEM`**
- Settings: `ghost_get_settings`, `ghost_update_settings`.
- Webhooks: `ghost_create_webhook`, `ghost_update_webhook`, `ghost_delete_webhook`.
- Users: `ghost_list_users`, `ghost_get_user`, `ghost_update_user`, `ghost_delete_user`.
- Themes: `ghost_upload_theme`, `ghost_activate_theme`.

> With every flag enabled the server exposes 42 tools; with none it exposes 7 (reads only).

## Project structure

No build step — what you read is what runs.

```
src/
  index.js            bootstrap: load config, build server, register tool modules
  config.js           env parsing, privilege flags, instructions builder
  helpers.js          result builders, object slimmers, upload utilities
  ghost-client.js     dependency-free Ghost Admin API client (generic CRUD + uploads)
  tools/
    site.js           ghost_site_info
    content.js        posts, pages, tags
    images.js         image upload
    members.js        members
    monetization.js   tiers, offers, newsletters
    system.js         settings, webhooks, users, themes
```

## Verifying it yourself

```bash
npm run check      # syntax check (node --check)
npm run audit      # vulnerability scan of runtime deps
```

To smoke-test the live API locally (Node ≥ 20.6), pipe an MCP handshake into the server:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ghost_site_info","arguments":{}}}' \
  | node --env-file=.env src/index.js
```

## License

MIT — see [LICENSE](LICENSE).
