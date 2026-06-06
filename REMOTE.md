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

## One-click deploy

[![Run on Google Cloud](https://deploy.cloud.run/button.svg)](https://deploy.cloud.run/?git_repo=https://github.com/cuonghapvn/ghost-mcp-secure)
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https%3A%2F%2Fgithub.com%2Fcuonghapvn%2Fghost-mcp-secure&envs=GHOST_API_URL,GHOST_ADMIN_API_KEY,MCP_AUTH_PASSWORD,MCP_OAUTH_SECRET)

- **Run on Google Cloud** opens Cloud Shell, builds the `Dockerfile`, and deploys to Cloud Run. The prompts come from [`app.json`](app.json): it asks for `GHOST_ADMIN_API_KEY` and `MCP_AUTH_PASSWORD`, auto-generates `MCP_OAUTH_SECRET`, and applies the safe-default flags. `PUBLIC_URL` is left unset and derived from the request headers (fine on Cloud Run). For Secret Manager–backed secrets and a pinned `PUBLIC_URL`, prefer [`deploy/cloud-run.sh`](deploy/cloud-run.sh) below.
- **Deploy on Railway** creates a service from this repo (one replica, `Dockerfile`) and prompts for the same env vars. `PUBLIC_URL` resolves from Railway's domain automatically.

The scripted deploys below give you more control (Secret Manager, region, flags).

## Required configuration

In addition to `GHOST_API_URL` and `GHOST_ADMIN_API_KEY`, the remote server **requires**:

| Var | Purpose |
| --- | --- |
| `MCP_AUTH_PASSWORD` | The password shown on the OAuth login screen (the human gate). |
| `MCP_OAUTH_SECRET` | HMAC key that signs OAuth codes/tokens. `openssl rand -hex 32`. |
| `PUBLIC_URL` | Stable public origin, e.g. `https://ghost-mcp-xxxx.run.app`. Used as the OAuth issuer. Recommended. |

The server refuses to start without `MCP_AUTH_PASSWORD` and a `MCP_OAUTH_SECRET` of at least 16 chars (secure-by-default). Optional: `MCP_ACCESS_TTL` (default 3600s), `MCP_REFRESH_TTL` (default 30d), `MCP_ENABLE_SSE` (default true).

## Deploy to Google Cloud Run

### One command (recommended)

[`deploy/cloud-run.sh`](deploy/cloud-run.sh) does the whole dance for you:
stores the three secrets in Secret Manager, grants the runtime service account
read access, deploys from the `Dockerfile` via Cloud Build, and pins
`PUBLIC_URL`. Re-running it is safe (secrets get a new version, the service is
updated in place).

```bash
GHOST_ADMIN_API_KEY='id:secret' \
MCP_AUTH_PASSWORD='a-strong-password' \
npm run deploy:cloud-run
```

It auto-generates `MCP_OAUTH_SECRET` if you don't pass one. Override any default
via env, e.g. `SERVICE=`, `REGION=`, `GHOST_API_URL=`, or any privilege flag:

```bash
REGION=asia-southeast1 GHOST_ALLOW_MEMBERS=true \
GHOST_ADMIN_API_KEY='id:secret' MCP_AUTH_PASSWORD='…' \
npm run deploy:cloud-run
```

### Manual steps

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
#    Use --update-env-vars (merge), NOT --set-env-vars (which replaces them all).
URL=$(gcloud run services describe ghost-mcp-secure --region asia-northeast1 --format='value(status.url)')
gcloud run services update ghost-mcp-secure --region asia-northeast1 --update-env-vars "PUBLIC_URL=$URL"
echo "MCP endpoint: $URL/mcp"
```

> The runtime service account needs `roles/secretmanager.secretAccessor` on each
> secret for `--set-secrets` to work (`deploy/cloud-run.sh` grants this for you).

Notes:
- **`--allow-unauthenticated`** disables Google IAM auth only; the app's own OAuth still gates every `/mcp` call. Without it, claude.ai/ChatGPT couldn't reach the endpoint.
- **`--max-instances 1`** keeps MCP/SSE session state on a single instance. `--min-instances 0` lets it scale to zero (cheap; ~1–2s cold start). If you need to scale out, enable session affinity, or rely on Streamable HTTP only.
- Cloud Run terminates TLS and forwards `X-Forwarded-Proto: https`, so HTTPS is automatic.

## Deploy to Railway

Railway builds straight from the `Dockerfile` ([`railway.json`](railway.json)
pins one replica — important, because sessions are in-memory — and the
`/healthz` health check). It injects `PORT` and gives the service a public
HTTPS domain automatically.

One-time setup, then deploy with [`deploy/railway.sh`](deploy/railway.sh):

```bash
npm i -g @railway/cli      # or: brew install railway
railway login
railway init               # new project  (or: railway link  for an existing one)

GHOST_ADMIN_API_KEY='id:secret' \
MCP_AUTH_PASSWORD='a-strong-password' \
npm run deploy:railway
```

The script sets every variable, ensures a public domain exists, and runs
`railway up`. It auto-generates `MCP_OAUTH_SECRET` if you don't pass one, and
sets `PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}` — a Railway reference
variable, so the OAuth issuer always tracks the live domain. Your MCP endpoint
is then `https://<your-domain>.up.railway.app/mcp`.

> Keep the service at **one replica**. The remote server holds MCP/SSE session
> state in memory; scaling out would break sessions unless you add sticky
> routing. (Cloud Run's `--max-instances 1` is the equivalent.)

## Continuous deployment (GitHub Actions)

Two workflows in [`.github/workflows/`](.github/workflows) redeploy on every push
to `main`. **Both are inert until you opt in** — each job is gated on a repository
*Variable*, so merging them changes nothing until you flip the switch.

### Cloud Run — keyless via Workload Identity Federation

No long-lived key is ever stored. Run the one-time setup, which creates a
deployer service account + a GitHub-OIDC provider locked to this repo and prints
the values to paste in:

```bash
PROJECT=my-gcp-project GITHUB_REPO=cuonghapvn/ghost-mcp-secure \
  ./deploy/setup-gcp-wif.sh
```

Then add these under **Settings → Secrets and variables → Actions → Variables**:

| Variable | Value |
| --- | --- |
| `DEPLOY_CLOUD_RUN` | `true` |
| `GCP_PROJECT` | your project id |
| `GCP_WIF_PROVIDER` | `projects/NNN/locations/global/workloadIdentityPools/POOL/providers/PROVIDER` |
| `GCP_SERVICE_ACCOUNT` | `gh-deployer@PROJECT.iam.gserviceaccount.com` |
| `CLOUD_RUN_SERVICE` / `CLOUD_RUN_REGION` | optional (default `ghost-mcp-secure` / `asia-northeast1`) |

The workflow runs `gcloud run deploy --source`, which keeps the service's existing
env vars and Secret Manager bindings — so **no Ghost credentials live in CI**.
Deploy `deploy/cloud-run.sh` once first so the service (and its secrets) exist.

### Railway — project token

Create a **project token** (Railway → project → Settings → Tokens) and add it as a
repository *Secret* `RAILWAY_TOKEN`, then set Variables:

| Name | Kind | Value |
| --- | --- | --- |
| `RAILWAY_TOKEN` | Secret | the project token |
| `DEPLOY_RAILWAY` | Variable | `true` |
| `RAILWAY_SERVICE` | Variable | optional (default `ghost-mcp-secure`) |

Both workflows skip doc-only commits and can also be triggered manually from the
**Actions** tab (`workflow_dispatch`).

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
