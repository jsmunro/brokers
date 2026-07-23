#!/usr/bin/env bash
set -euo pipefail

# Usage: cf-auth.sh <app-name-or-slug>
# Fetches a token for a registered app from the central-auth-broker Cloudflare
# Worker, authenticating via Cloudflare Access.
#
# <app-name-or-slug> is either:
#   - a full 3-part slug (contains a "/"), e.g. github/jsmunro/Iv23lifj0i4aV6qYR76i
#   - a friendly name, matched case-insensitively (with "-"/space treated as
#     equivalent) against each registered app's display_name or
#     metadata.name, e.g. "brokers-repo" matches "Brokers repo". Resolution
#     is done via GET /api/apps; ambiguous or unmatched names print
#     candidates to stderr and exit 1.
#
# Two authentication modes:
#   - Human (default): uses `cloudflared` to authenticate against Cloudflare
#     Access, prompting an interactive login the first time.
#   - Machine/service: set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET
#     (a per-app Access service token) to skip cloudflared entirely and
#     authenticate via the CF-Access-Client-Id/CF-Access-Client-Secret
#     headers instead. In this mode the argument MUST be a full 3-part slug:
#     friendly-name resolution goes through GET /api/apps, which is gated by
#     the ROOT app's Access policy, and per-app service tokens are not
#     members of that policy (only the interactively-linked human identities
#     are) — so a service token cannot resolve names, only fetch tokens for
#     the exact app it was issued for.

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

MACHINE_MODE=0
if [ -n "${CF_ACCESS_CLIENT_ID:-}" ] && [ -n "${CF_ACCESS_CLIENT_SECRET:-}" ]; then
  MACHINE_MODE=1
fi

if [ "$MACHINE_MODE" -eq 1 ]; then
  # Machine/service-token path: no cloudflared, no name resolution.
  if [[ "$ARG" != */* ]]; then
    echo "Error: CF_ACCESS_CLIENT_ID/CF_ACCESS_CLIENT_SECRET are set (service-token mode)," >&2
    echo "which requires a full 3-part slug, e.g. github/jsmunro/Iv23lifj0i4aV6qYR76i." >&2
    echo "Friendly-name resolution (GET /api/apps) is gated by the root app's Access" >&2
    echo "policy, which per-app service tokens are not members of, so it is" >&2
    echo "unavailable in this mode." >&2
    exit 1
  fi
  SLUG="$ARG"

  RESPONSE="$(curl -sSf \
    -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
    -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
    "$BROKER_URL/get-token/$SLUG")" || {
    echo "Error: request to $BROKER_URL/get-token/$SLUG failed." >&2
    echo "Check that the service token is valid and is included in the app's Access policy." >&2
    exit 1
  }
else
  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "Error: cloudflared is required but was not found on PATH." >&2
    exit 1
  fi

  # Name resolution (and the root dashboard/api) is gated by the root app's
  # Access policy, so that call keeps using the root-app token.
  ROOT_JWT="$(cloudflared access token --app="$BROKER_URL" 2>/dev/null || true)"

  if [ -z "$ROOT_JWT" ]; then
    echo "No cached Access token found; launching cloudflared access login..." >&2
    cloudflared access login "$BROKER_URL"
    ROOT_JWT="$(cloudflared access token --app="$BROKER_URL")"
  fi

  if [[ "$ARG" == */* ]]; then
    SLUG="$ARG"
  else
    APPS_JSON="$(curl -sSf -H "cf-access-token: $ROOT_JWT" "$BROKER_URL/api/apps")" || {
      echo "Error: request to $BROKER_URL/api/apps failed." >&2
      echo "Check that you are logged in to Cloudflare Access (cloudflared access login $BROKER_URL)." >&2
      exit 1
    }

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

  # The worker now enforces a per-app Access AUD on /get-token/<slug>, so the
  # token used here must be scoped to that specific app's token-app, not the
  # root app used for resolution above.
  APP_JWT="$(cloudflared access token --app="$BROKER_URL/get-token/$SLUG" 2>/dev/null || true)"

  if [ -z "$APP_JWT" ]; then
    echo "No cached Access token found for $SLUG; launching cloudflared access login..." >&2
    cloudflared access login "$BROKER_URL/get-token/$SLUG"
    APP_JWT="$(cloudflared access token --app="$BROKER_URL/get-token/$SLUG")"
  fi

  # The Access edge authenticates clients via the cf-access-token header and
  # injects Cf-Access-Jwt-Assertion toward the origin itself.
  RESPONSE="$(curl -sSf -H "cf-access-token: $APP_JWT" "$BROKER_URL/get-token/$SLUG")" || {
    echo "Error: request to $BROKER_URL/get-token/$SLUG failed." >&2
    echo "Check that you are logged in to Cloudflare Access for this app (cloudflared access login $BROKER_URL/get-token/$SLUG)." >&2
    exit 1
  }
fi

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
