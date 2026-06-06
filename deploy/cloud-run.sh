#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# deploy/cloud-run.sh — one-command deploy of the REMOTE server to Cloud Run.
#
# It builds the image from the Dockerfile (via Cloud Build), stores the three
# secrets in Secret Manager, grants the runtime service account read access,
# deploys the service, and pins PUBLIC_URL so the OAuth issuer is stable.
#
# Re-running is safe: secrets get a new version, the service is updated in
# place. Nothing here is destructive to your Ghost site.
#
# Usage:
#   GHOST_ADMIN_API_KEY='id:secret' \
#   MCP_AUTH_PASSWORD='a-strong-password' \
#   ./deploy/cloud-run.sh
#
# Everything else has a sensible default and can be overridden via env, e.g.
#   SERVICE=ghost-mcp REGION=asia-southeast1 GHOST_API_URL=https://blog.example.com \
#   ./deploy/cloud-run.sh
# ---------------------------------------------------------------------------
set -euo pipefail

# ---- Configuration (override via environment) -----------------------------
SERVICE="${SERVICE:-ghost-mcp-secure}"
REGION="${REGION:-asia-northeast1}"
PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
MEMORY="${MEMORY:-256Mi}"
MAX_INSTANCES="${MAX_INSTANCES:-1}"   # sessions are in-memory — keep at 1
MIN_INSTANCES="${MIN_INSTANCES:-0}"   # scale to zero when idle

GHOST_API_URL="${GHOST_API_URL:-https://cuongn.com}"
GHOST_API_VERSION="${GHOST_API_VERSION:-v6.0}"

# Privilege flags — default to the secure read/write-without-delete posture.
GHOST_WRITE_ENABLED="${GHOST_WRITE_ENABLED:-true}"
GHOST_ALLOW_PUBLISH="${GHOST_ALLOW_PUBLISH:-false}"
GHOST_ALLOW_DELETE="${GHOST_ALLOW_DELETE:-false}"
GHOST_ALLOW_MEMBERS="${GHOST_ALLOW_MEMBERS:-false}"
GHOST_ALLOW_MONETIZATION="${GHOST_ALLOW_MONETIZATION:-false}"
GHOST_ALLOW_SYSTEM="${GHOST_ALLOW_SYSTEM:-false}"

# Secrets (required). MCP_OAUTH_SECRET is auto-generated if not supplied.
GHOST_ADMIN_API_KEY="${GHOST_ADMIN_API_KEY:-}"
MCP_AUTH_PASSWORD="${MCP_AUTH_PASSWORD:-}"
MCP_OAUTH_SECRET="${MCP_OAUTH_SECRET:-}"

# Secret Manager resource names.
SEC_ADMIN="${SEC_ADMIN:-ghost-admin-key}"
SEC_OAUTH="${SEC_OAUTH:-mcp-oauth-secret}"
SEC_PASS="${SEC_PASS:-mcp-auth-password}"

# ---- Preflight ------------------------------------------------------------
command -v gcloud >/dev/null 2>&1 || { echo "ERROR: gcloud CLI not found. Install the Google Cloud SDK." >&2; exit 1; }
[ -n "$PROJECT" ] || { echo "ERROR: no GCP project set. Run 'gcloud config set project <id>' or pass PROJECT=." >&2; exit 1; }
[ -n "$GHOST_ADMIN_API_KEY" ] || { echo "ERROR: GHOST_ADMIN_API_KEY is required (format id:secret)." >&2; exit 1; }
[ -n "$MCP_AUTH_PASSWORD" ] || { echo "ERROR: MCP_AUTH_PASSWORD is required (the OAuth login gate)." >&2; exit 1; }
if [ -z "$MCP_OAUTH_SECRET" ]; then
  MCP_OAUTH_SECRET="$(openssl rand -hex 32)"
  echo "• Generated a fresh MCP_OAUTH_SECRET (32 bytes)."
fi

echo "Deploying '$SERVICE' to project '$PROJECT' ($REGION)…"
gcloud config set project "$PROJECT" >/dev/null

# Make sure the APIs we need are on (no-op if already enabled).
echo "• Enabling required APIs (run, cloudbuild, secretmanager)…"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com >/dev/null

# ---- Secrets --------------------------------------------------------------
upsert_secret() {
  local name="$1" value="$2"
  if gcloud secrets describe "$name" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- >/dev/null
    echo "• Updated secret '$name' (new version)."
  else
    printf '%s' "$value" | gcloud secrets create "$name" --replication-policy=automatic --data-file=- >/dev/null
    echo "• Created secret '$name'."
  fi
}
upsert_secret "$SEC_ADMIN" "$GHOST_ADMIN_API_KEY"
upsert_secret "$SEC_OAUTH" "$MCP_OAUTH_SECRET"
upsert_secret "$SEC_PASS"  "$MCP_AUTH_PASSWORD"

# Grant the Cloud Run runtime service account read access to the secrets.
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
RUNTIME_SA="${RUNTIME_SA:-${PROJECT_NUMBER}-compute@developer.gserviceaccount.com}"
echo "• Granting secretAccessor to $RUNTIME_SA…"
for s in "$SEC_ADMIN" "$SEC_OAUTH" "$SEC_PASS"; do
  gcloud secrets add-iam-policy-binding "$s" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="roles/secretmanager.secretAccessor" >/dev/null
done

# ---- Deploy ---------------------------------------------------------------
ENV_VARS="GHOST_API_URL=${GHOST_API_URL}"
ENV_VARS="${ENV_VARS},GHOST_API_VERSION=${GHOST_API_VERSION}"
ENV_VARS="${ENV_VARS},GHOST_WRITE_ENABLED=${GHOST_WRITE_ENABLED}"
ENV_VARS="${ENV_VARS},GHOST_ALLOW_PUBLISH=${GHOST_ALLOW_PUBLISH}"
ENV_VARS="${ENV_VARS},GHOST_ALLOW_DELETE=${GHOST_ALLOW_DELETE}"
ENV_VARS="${ENV_VARS},GHOST_ALLOW_MEMBERS=${GHOST_ALLOW_MEMBERS}"
ENV_VARS="${ENV_VARS},GHOST_ALLOW_MONETIZATION=${GHOST_ALLOW_MONETIZATION}"
ENV_VARS="${ENV_VARS},GHOST_ALLOW_SYSTEM=${GHOST_ALLOW_SYSTEM}"

echo "• Building & deploying from source…"
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --max-instances "$MAX_INSTANCES" \
  --min-instances "$MIN_INSTANCES" \
  --memory "$MEMORY" \
  --set-env-vars "$ENV_VARS" \
  --set-secrets "GHOST_ADMIN_API_KEY=${SEC_ADMIN}:latest,MCP_OAUTH_SECRET=${SEC_OAUTH}:latest,MCP_AUTH_PASSWORD=${SEC_PASS}:latest"

# ---- Pin PUBLIC_URL so the OAuth issuer never drifts ----------------------
URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo "• Pinning PUBLIC_URL=$URL…"
# --update-env-vars MERGES (does not replace) — keeps the flags above intact.
gcloud run services update "$SERVICE" --region "$REGION" \
  --update-env-vars "PUBLIC_URL=${URL}" >/dev/null

echo
echo "✅ Deployed."
echo "   Service URL : $URL"
echo "   MCP endpoint: $URL/mcp"
echo "   SSE (legacy): $URL/sse"
echo
echo "Add $URL/mcp as a custom connector in claude.ai or ChatGPT Developer Mode,"
echo "then log in with your MCP_AUTH_PASSWORD."
