#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# deploy/setup-gcp-wif.sh — one-time setup so GitHub Actions can deploy to
# Cloud Run WITHOUT a long-lived key, via Workload Identity Federation.
#
# It creates (idempotently):
#   * a deployer service account with the roles `gcloud run deploy --source`
#     needs (run, cloudbuild, artifact registry, storage staging, act-as),
#   * a Workload Identity pool + GitHub OIDC provider, locked to your repo,
#   * the binding that lets that repo impersonate the service account.
#
# Then it prints the GitHub repository Variables to set. No secret is produced
# — that's the whole point of WIF.
#
# Usage:
#   PROJECT=my-gcp-project GITHUB_REPO=cuonghapvn/ghost-mcp-secure \
#   ./deploy/setup-gcp-wif.sh
# ---------------------------------------------------------------------------
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
GITHUB_REPO="${GITHUB_REPO:-cuonghapvn/ghost-mcp-secure}"   # owner/repo
POOL="${POOL:-github-pool}"
PROVIDER="${PROVIDER:-github-provider}"
SA_NAME="${SA_NAME:-gh-deployer}"

command -v gcloud >/dev/null 2>&1 || { echo "ERROR: gcloud CLI not found." >&2; exit 1; }
[ -n "$PROJECT" ] || { echo "ERROR: no GCP project. Set PROJECT= or run 'gcloud config set project <id>'." >&2; exit 1; }
case "$GITHUB_REPO" in */*) ;; *) echo "ERROR: GITHUB_REPO must be 'owner/repo'." >&2; exit 1;; esac

SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
gcloud config set project "$PROJECT" >/dev/null

echo "• Enabling required APIs…"
gcloud services enable \
  iamcredentials.googleapis.com sts.googleapis.com \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com >/dev/null

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"

# 1) Deployer service account ------------------------------------------------
if ! gcloud iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" \
    --display-name="GitHub Actions deployer (Cloud Run)" >/dev/null
  echo "• Created service account $SA_EMAIL."
else
  echo "• Service account $SA_EMAIL already exists."
fi

echo "• Granting deploy roles…"
for role in \
  roles/run.admin \
  roles/iam.serviceAccountUser \
  roles/cloudbuild.builds.editor \
  roles/artifactregistry.admin \
  roles/storage.admin; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${SA_EMAIL}" --role="$role" \
    --condition=None >/dev/null
done

# 2) Workload Identity pool + GitHub OIDC provider ---------------------------
if ! gcloud iam workload-identity-pools describe "$POOL" --location=global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$POOL" --location=global \
    --display-name="GitHub Actions" >/dev/null
  echo "• Created workload identity pool '$POOL'."
fi

if ! gcloud iam workload-identity-pools providers describe "$PROVIDER" \
      --location=global --workload-identity-pool="$POOL" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
    --location=global --workload-identity-pool="$POOL" \
    --display-name="GitHub OIDC" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
    --attribute-condition="assertion.repository=='${GITHUB_REPO}'" >/dev/null
  echo "• Created OIDC provider '$PROVIDER' (locked to ${GITHUB_REPO})."
fi

# 3) Let the repo impersonate the service account ----------------------------
echo "• Binding ${GITHUB_REPO} -> ${SA_EMAIL}…"
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${GITHUB_REPO}" >/dev/null

PROVIDER_RESOURCE="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"

cat <<EOF

✅ Workload Identity Federation is ready.

Add these as GitHub repository **Variables**
(Settings → Secrets and variables → Actions → Variables):

  DEPLOY_CLOUD_RUN    = true
  GCP_PROJECT         = ${PROJECT}
  GCP_WIF_PROVIDER    = ${PROVIDER_RESOURCE}
  GCP_SERVICE_ACCOUNT = ${SA_EMAIL}
  CLOUD_RUN_SERVICE   = ghost-mcp-secure   (optional; this is the default)
  CLOUD_RUN_REGION    = asia-northeast1    (optional; this is the default)

No GitHub secret is needed — that's the point of WIF.
Make sure the Cloud Run service already exists (run deploy/cloud-run.sh once),
so CI's source deploy just ships a new revision with the existing config.
EOF
