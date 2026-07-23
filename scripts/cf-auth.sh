#!/usr/bin/env bash
set -euo pipefail

# Usage: cf-auth.sh <provider>
# Fetches a token for <provider> from the central-auth-broker Cloudflare Worker,
# authenticating via Cloudflare Access (cloudflared).

BROKER_URL="https://broker.jsmunro.me"

usage() {
  echo "Usage: $0 <provider>" >&2
  exit 1
}

if [ "$#" -ne 1 ]; then
  usage
fi

PROVIDER="$1"

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

# The Access edge authenticates clients via the cf-access-token header and
# injects Cf-Access-Jwt-Assertion toward the origin itself.
RESPONSE="$(curl -sS -H "cf-access-token: $JWT" "$BROKER_URL/get-token/$PROVIDER")"

SETUP_REQUIRED="$(echo "$RESPONSE" | jq -r '.setup_required // false')"

if [ "$SETUP_REQUIRED" = "true" ]; then
  AUTH_URL="$(echo "$RESPONSE" | jq -r '.url')"
  echo "Setup required. Open this URL to link $PROVIDER:" >&2
  echo "$AUTH_URL"

  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$AUTH_URL" >/dev/null 2>&1 || true
  elif command -v open >/dev/null 2>&1; then
    open "$AUTH_URL" >/dev/null 2>&1 || true
  fi

  exit 1
fi

echo "$RESPONSE"
