#!/usr/bin/env bash
# infra/bootstrap.sh — one-time setup of the R2 bucket used for Terraform
# remote state. Run once per account, before the first `terraform init`.
#
# Requires: CLOUDFLARE_API_TOKEN (env), curl, jq.
set -euo pipefail

ACCOUNT_ID="314e7e015b5f4429c4e2da1e6ec93271"
BUCKET="broker-terraform-state"

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN must be set to a token with Account > Workers R2 Storage:Edit permission}"

command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }

echo "Creating R2 bucket '${BUCKET}' in account ${ACCOUNT_ID}..."

response=$(curl -sS -X POST \
  "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "{\"name\":\"${BUCKET}\"}")

success=$(printf '%s' "$response" | jq -r '.success // false')

if [ "$success" != "true" ]; then
  # Tolerate "bucket already exists" (idempotent re-runs).
  if printf '%s' "$response" | jq -e '[.errors[]?.code] | index(10004) != null' >/dev/null 2>&1; then
    echo "Bucket '${BUCKET}' already exists — continuing."
  else
    echo "Failed to create R2 bucket:" >&2
    printf '%s\n' "$response" >&2
    exit 1
  fi
else
  echo "Bucket '${BUCKET}' created."
fi

cat <<EOF

Next steps (manual — not automatable via this token):

1. Create a SEPARATE, R2-scoped API token for Terraform state operations
   (Cloudflare dashboard > My Profile > API Tokens > Create Token >
   "S3 compatible R2 access", or a custom token with
   Account > Workers R2 Storage:Edit). Do not reuse an Access-management
   token for this — keep blast radius small.

2. Copy infra/backend.hcl.example to infra/backend.hcl (gitignored) and
   fill in access_key / secret_key from the R2 token created above:

     endpoint = "https://${ACCOUNT_ID}.r2.cloudflarestorage.com"
     region   = "auto"
     (see backend.hcl.example for the full set of required skip_* flags —
     R2 does not support every S3 API the backend probes by default.)

3. Initialize Terraform against the new backend:

     terraform -chdir=infra init -backend-config=backend.hcl

4. Proceed with infra/README.md (import, plan, apply).
EOF
