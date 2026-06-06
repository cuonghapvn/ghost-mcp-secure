#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# deploy/railway.sh — one-command deploy of the REMOTE server to Railway.
#
# Railway builds the image straight from the Dockerfile (see railway.json),
# injects PORT, and gives the service a public HTTPS domain. This script sets
# the required variables, ensures a public domain exists, and deploys.
#
# Prerequisites (one-time):
#   npm i -g @railway/cli      # or: brew install railway
#   railway login
#   railway init               # create a new project, OR:
#   railway link               # link this folder to an existing project
#
# Usage:
#   GHOST_ADMIN_API_KEY='id:secret' \
#   MCP_AUTH_PASSWORD='a-strong-password' \
#   ./deploy/railway.sh
#
# Override any default via env (GHOST_API_URL, flags, etc.).
# ---------------------------------------------------------------------------
set -euo pipefail

GHOST_API_URL="${GHOST_API_URL:-https://cuongn.com}"
GHOST_API_VERSION="${GHOST_API_VERSION:-v6.0}"

GHOST_WRITE_ENABLED="${GHOST_WRITE_ENABLED:-true}"
GHOST_ALLOW_PUBLISH="${GHOST_ALLOW_PUBLISH:-false}"
GHOST_ALLOW_DELETE="${GHOST_ALLOW_DELETE:-false}"
GHOST_ALLOW_MEMBERS="${GHOST_ALLOW_MEMBERS:-false}"
GHOST_ALLOW_MONETIZATION="${GHOST_ALLOW_MONETIZATION:-false}"
GHOST_ALLOW_SYSTEM="${GHOST_ALLOW_SYSTEM:-false}"

GHOST_ADMIN_API_KEY="${GHOST_ADMIN_API_KEY:-}"
MCP_AUTH_PASSWORD="${MCP_AUTH_PASSWORD:-}"
MCP_OAUTH_SECRET="${MCP_OAUTH_SECRET:-}"

# ---- Preflight ------------------------------------------------------------
command -v railway >/dev/null 2>&1 || { echo "ERROR: railway CLI not found. Install with 'npm i -g @railway/cli'." >&2; exit 1; }
railway whoami >/dev/null 2>&1 || { echo "ERROR: not logged in. Run 'railway login' first." >&2; exit 1; }
railway status >/dev/null 2>&1 || { echo "ERROR: no linked project. Run 'railway init' or 'railway link' in this folder." >&2; exit 1; }
[ -n "$GHOST_ADMIN_API_KEY" ] || { echo "ERROR: GHOST_ADMIN_API_KEY is required (format id:secret)." >&2; exit 1; }
[ -n "$MCP_AUTH_PASSWORD" ] || { echo "ERROR: MCP_AUTH_PASSWORD is required (the OAuth login gate)." >&2; exit 1; }
if [ -z "$MCP_OAUTH_SECRET" ]; then
  MCP_OAUTH_SECRET="$(openssl rand -hex 32)"
  echo "• Generated a fresh MCP_OAUTH_SECRET (32 bytes)."
fi

# ---- Ensure a public domain, then point PUBLIC_URL at it ------------------
# 'railway domain' is idempotent — it prints the existing domain or creates one.
echo "• Ensuring a public domain exists…"
railway domain >/dev/null 2>&1 || true

# ---- Variables ------------------------------------------------------------
# PUBLIC_URL is a Railway reference variable, so it always tracks the live
# domain without us having to scrape it. NODE/PORT are provided by Railway.
echo "• Setting service variables…"
railway variables \
  --set "GHOST_API_URL=${GHOST_API_URL}" \
  --set "GHOST_API_VERSION=${GHOST_API_VERSION}" \
  --set "GHOST_WRITE_ENABLED=${GHOST_WRITE_ENABLED}" \
  --set "GHOST_ALLOW_PUBLISH=${GHOST_ALLOW_PUBLISH}" \
  --set "GHOST_ALLOW_DELETE=${GHOST_ALLOW_DELETE}" \
  --set "GHOST_ALLOW_MEMBERS=${GHOST_ALLOW_MEMBERS}" \
  --set "GHOST_ALLOW_MONETIZATION=${GHOST_ALLOW_MONETIZATION}" \
  --set "GHOST_ALLOW_SYSTEM=${GHOST_ALLOW_SYSTEM}" \
  --set "GHOST_ADMIN_API_KEY=${GHOST_ADMIN_API_KEY}" \
  --set "MCP_AUTH_PASSWORD=${MCP_AUTH_PASSWORD}" \
  --set "MCP_OAUTH_SECRET=${MCP_OAUTH_SECRET}" \
  --set 'PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}' >/dev/null

# ---- Deploy ---------------------------------------------------------------
echo "• Building & deploying from the Dockerfile…"
railway up --detach

echo
echo "✅ Deploy started on Railway."
DOMAIN="$(railway domain 2>/dev/null | tr -d '[:space:]' || true)"
if [ -n "$DOMAIN" ]; then
  echo "   MCP endpoint: https://${DOMAIN#https://}/mcp"
fi
echo "Watch the build with 'railway logs'. Then add the /mcp URL as a custom"
echo "connector in claude.ai or ChatGPT Developer Mode and log in with MCP_AUTH_PASSWORD."
