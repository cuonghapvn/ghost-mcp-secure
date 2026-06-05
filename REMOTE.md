# Remote deployment (claude.ai & ChatGPT)

`ghost-mcp-secure` ships two entrypoints from the same code:

| Entrypoint | Transport | For |
| --- | --- | --- |
| `src/index.js` | stdio | local Claude Desktop / Claude Code |
| `src/http-server.js` | Streamable HTTP + OAuth 2.1 | hosted **claude.ai** connectors & **ChatGPT** Developer Mode |

The remote server exposes:

- **`POST/GET/DELETE /mcp`** — MCP Streamable HTTP (stateful sessions, in-memory).
- **`GET /sse` + `POST /messages`** — deprecated SSE bridge for older ChatGPT clients (toggle with `MCP_ENABLE_SSE=false`).
- **OAuth 2.1 + PKCE** served from the same process: discovery (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`), dynamic client registration (`/register`), authorization (`/authorize`, with a password login screen), and token issuance (`/token`).

> The Ghost **privilege flags still decide what the model can do**. OAuth only decides **who may connect**. Keep `GHOST_ALLOW_DELETE` and `GHOST_ALLOW_SYSTEM` off for an internet-facing endpoint.

## Required configuration

In addition to `GHOST_API_URL` and `GHOST_ADMIN_API_KEY`, the remote server **requires**:

| Var | Purpose |
| --- | --- |
| `MCP_AUTH_PASSWORD` | The password shown on the OAuth login screen (the human gate). |
| `MCP_OAUTH_SECRET` | HMAC key that signs OAuth codes/tokens. `openssl rand -hex 32`. |
| `PUBLIC_URL` | Stable public origin, e.g. `https://ghost-mcp-xxxx.run.app`. Used as the OAuth issuer. Recommended. |

The server refuses to start without `MCP_AUTH_PASSWORD` and a `MCP_OAUTH_SECRET` of at least 16 chars (secure-by-default). Optional: `MCP_ACCESS_TTL` (default 3600s), `MCP_REFRESH_TTL` (default 30d), `MCP_ENABLE_SSE` (default true).

## Deploy to Google Cloud Run

A `Dockerfile` is included (Node 22 Alpine, no build step). From the repo root:

```bash
# 1) Build & deploy from source (uses the Dockerfile via Cloud Build).
gcloud run deploy ghost-mcp-secure \
  --source . \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --max-instances 1 \
  --min-instances 0 \
  --memory 256Mi \
  --set-env-vars "GHOST_API_URL=https://cuongn.com,GHOST_API_VERSION=v6.0,GHOST_WRITE_ENABLED=true,GHOST_ALLOW_PUBLISH=false,GHOST_ALLOW_DELETE=false,GHOST_ALLOW_MEMBERS=false,GHOST_ALLOW_MONETIZATION=false,GHOST_ALLOW_SYSTEM=false"

# 2) Put secrets in Secret Manager (don't bake them into env-vars history).
printf '%s' 'id:secret'        | gcloud secrets create ghost-admin-key  --data-file=-
printf '%s' "$(openssl rand -hex 32)" | gcloud secrets create mcp-oauth-secret --data-file=-
printf '%s' 'a-strong-password' | gcloud secrets create mcp-auth-password --data-file=-

gcloud run services update ghost-mcp-secure --region asia-northeast1 \
  --set-secrets "GHOST_ADMIN_API_KEY=ghost-admin-key:latest,MCP_OAUTH_SECRET=mcp-oauth-secret:latest,MCP_AUTH_PASSWORD=mcp-auth-password:latest"

# 3) Grab the URL, then pin it as PUBLIC_URL so the OAuth issuer is stable.
URL=$(gcloud run services describe ghost-mcp-secure --region asia-northeast1 --format='value(status.url)')
gcloud run services update ghost-mcp-secure --region asia-northeast1 --set-env-vars "PUBLIC_URL=$URL"
echo "MCP endpoint: $URL/mcp"
```

Notes:
- **`--allow-unauthenticated`** disables Google IAM auth only; the app's own OAuth still gates every `/mcp` call. Without it, claude.ai/ChatGPT couldn't reach the endpoint.
- **`--max-instances 1`** keeps MCP/SSE session state on a single instance. `--min-instances 0` lets it scale to zero (cheap; ~1–2s cold start). If you need to scale out, enable session affinity, or rely on Streamable HTTP only.
- Cloud Run terminates TLS and forwards `X-Forwarded-Proto: https`, so HTTPS is automatic.

## Connect from claude.ai

1. Settings → **Connectors** → **Add custom connector**.
2. URL: `https://<your-run-url>/mcp`.
3. Claude discovers the OAuth metadata, registers itself (DCR), and opens the
   **login screen** — enter `MCP_AUTH_PASSWORD`. The callback
   `https://claude.ai/api/mcp/auth_callback` is already allowed.
4. After authorizing, the Ghost tools appear. (claude.ai connectors currently
   support tool calls.)

## Connect from ChatGPT (Developer Mode)

1. Settings → **Apps & Connectors** → **Advanced** → enable **Developer Mode**.
2. Add an app/connector pointing at `https://<your-run-url>/mcp` (Streamable HTTP).
   The legacy SSE URL `https://<your-run-url>/sse` is also available if needed.
3. Choose **OAuth**; complete the same password login.

## Remote caveats

- **Uploads:** the `path` option of `ghost_upload_image` / `ghost_upload_theme` is
  useless remotely (no access to the user's disk). Use `url` or `data_base64`.
- Prefer keeping **delete** and **system** flags off online.
- Use a **dedicated, revocable** Ghost custom integration so the key can be rotated
  independently. **Rotate the key** if it was ever exposed.
- Consider putting Cloud Run behind a rate limit / Cloud Armor if the URL is shared.

## Test locally

```bash
# Full OAuth + MCP smoke test (starts the server itself with throwaway creds):
npm run smoke:remote

# Or run it and point the MCP Inspector / a connector at http://localhost:8080/mcp:
PORT=8080 PUBLIC_URL=http://localhost:8080 \
GHOST_API_URL=https://your-blog.example.com GHOST_ADMIN_API_KEY=id:secret \
MCP_AUTH_PASSWORD=dev MCP_OAUTH_SECRET=$(openssl rand -hex 32) \
node src/http-server.js
```
