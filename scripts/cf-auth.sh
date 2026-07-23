#!/usr/bin/env bash
set -euo pipefail

# Usage: cf-auth.sh <app-name-or-slug>
# Fetches a token for a registered app from the central-auth-broker Cloudflare
# Worker, authenticating via Cloudflare Access (cloudflared).
#
# <app-name-or-slug> is either:
#   - a full 3-part slug (contains a "/"), e.g. github/jsmunro/Iv23lifj0i4aV6qYR76i
#   - a friendly name, matched case-insensitively (with "-"/space treated as
#     equivalent) against each registered app's display_name or
#     metadata.name, e.g. "brokers-repo" matches "Brokers repo". Resolution
#     is done via GET /api/apps; ambiguous or unmatched names print
#     candidates to stderr and exit 1.

BROKER_URL="https://broker.jsmunro.me"

usage() {
  echo "Usage: $0 <app-name-or-slug>" >&2
  exit 1
}

if [ "$#" -ne 1 ]; then
  usage
fi

ARG="$1"

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required but was not found on PATH. Install jq and try again." >&2
  exit 1
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "Error: cloudflared is required but was not found on PATH." >&2
  exit 1
fi

JWT="$(cloudflared access token --app="$BROKER_URL" 2>/dev/null || true)"

if [ -z "$JWT" ]; then
  echo "No cached Access token found; launching cloudflared access login..." >&2
  cloudflared access login "$BROKER_URL"
  JWT="$(cloudflared access token --app="$BROKER_URL")"
fi

if [[ "$ARG" == */* ]]; then
  SLUG="$ARG"
else
  APPS_JSON="$(curl -sS -H "cf-access-token: $JWT" "$BROKER_URL/api/apps")"

  # Normalizes for comparison: lowercase, and treat "-" and space as
  # equivalent (both collapse to a single space), so "brokers-repo" matches
  # "Brokers repo". Matches against display_name OR metadata.name.
  MATCHES="$(
    echo "$APPS_JSON" | jq -r --arg needle "$ARG" '
      ($needle | ascii_downcase | gsub("[- ]"; " ")) as $n
      | def norm: ascii_downcase | gsub("[- ]"; " ");
      [.[] | select((.display_name | norm) == $n or ((.metadata.name // "") | norm) == $n)]
      | .[] | [.slug, .display_name] | @tsv
    '
  )"

  MATCH_COUNT=0
  if [ -n "$MATCHES" ]; then
    MATCH_COUNT="$(printf '%s\n' "$MATCHES" | wc -l)"
  fi

  if [ "$MATCH_COUNT" -eq 1 ]; then
    SLUG="$(printf '%s' "$MATCHES" | cut -f1)"
  else
    if [ "$MATCH_COUNT" -eq 0 ]; then
      echo "No registered app matches \"$ARG\". Candidates:" >&2
    else
      echo "Ambiguous name \"$ARG\"; matches multiple registered apps:" >&2
    fi
    echo "$APPS_JSON" | jq -r '.[] | "  \(.slug)\t\(.display_name)"' >&2
    exit 1
  fi
fi

# The Access edge authenticates clients via the cf-access-token header and
# injects Cf-Access-Jwt-Assertion toward the origin itself.
RESPONSE="$(curl -sS -H "cf-access-token: $JWT" "$BROKER_URL/get-token/$SLUG")"

SETUP_REQUIRED="$(echo "$RESPONSE" | jq -r '.setup_required // false')"

if [ "$SETUP_REQUIRED" = "true" ]; then
  AUTH_URL="$(echo "$RESPONSE" | jq -r '.url')"
  # Everything in this branch goes to stderr: stdout is reserved for the
  # token JSON so $(cf-auth.sh ... | jq) never sees the setup URL.
  echo "Setup required. Open this URL to link $SLUG:" >&2
  echo "$AUTH_URL" >&2

  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$AUTH_URL" >/dev/null 2>&1 || true
  elif command -v open >/dev/null 2>&1; then
    open "$AUTH_URL" >/dev/null 2>&1 || true
  fi

  exit 1
fi

echo "$RESPONSE"
