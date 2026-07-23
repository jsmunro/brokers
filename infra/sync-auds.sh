#!/usr/bin/env bash
# infra/sync-auds.sh — patch wrangler.toml's ACCESS_APP_AUDS var from the
# `app_auds` Terraform output. Idempotent: safe to re-run.
#
# Mandatory rollout order (see spec §2): terraform apply -> sync-auds.sh ->
# worker deploy.
#
# Requires: terraform (or tofu), jq.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WRANGLER_TOML="${REPO_ROOT}/wrangler.toml"

command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }

TF_BIN="terraform"
if ! command -v terraform >/dev/null 2>&1; then
  if command -v tofu >/dev/null 2>&1; then
    TF_BIN="tofu"
  else
    echo "terraform (or tofu) is required" >&2
    exit 1
  fi
fi

if [ ! -f "$WRANGLER_TOML" ]; then
  echo "wrangler.toml not found at ${WRANGLER_TOML}" >&2
  exit 1
fi

auds_json="$("$TF_BIN" -chdir="${SCRIPT_DIR}" output -json app_auds | jq -c '.')"

if [ -z "$auds_json" ] || [ "$auds_json" = "null" ]; then
  echo "app_auds output was empty/null — refusing to write an empty ACCESS_APP_AUDS" >&2
  exit 1
fi

# wrangler.toml embeds the JSON as a TOML literal string (single quotes),
# which takes its contents verbatim — no escaping needed for the double
# quotes JSON produces. A literal single quote in the JSON would terminate
# the TOML string early and corrupt the file, so guard against it (no valid
# manifest slug/group name can contain one, per scripts/validate-manifest.mjs).
case "$auds_json" in
  *\'*)
    echo "app_auds JSON contains a single-quote character, which cannot be safely embedded in a TOML literal string. Refusing to write. Offending value:" >&2
    echo "$auds_json" >&2
    exit 1
    ;;
esac

new_line="ACCESS_APP_AUDS = '${auds_json}'"

tmp_file="$(mktemp "${WRANGLER_TOML}.XXXXXX")"
trap 'rm -f "$tmp_file"' EXIT

awk -v newline="$new_line" '
  BEGIN { replaced = 0 }
  /^ACCESS_APP_AUDS[[:space:]]*=/ {
    print newline
    replaced = 1
    next
  }
  { print }
  END {
    if (!replaced) {
      print "ACCESS_APP_AUDS line not found in wrangler.toml" > "/dev/stderr"
      exit 1
    }
  }
' "$WRANGLER_TOML" > "$tmp_file"

mv "$tmp_file" "$WRANGLER_TOML"
trap - EXIT

echo "Synced ACCESS_APP_AUDS into ${WRANGLER_TOML}:"
echo "  ${new_line}"
