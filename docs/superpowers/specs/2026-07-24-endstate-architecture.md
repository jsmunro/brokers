# Broker Platform — End-State Architecture & Roadmap

2026-07-24. North-star design. The GitHub App integration becomes an *instance* of this design, not the product. Supersedes nothing — earlier specs remain the record of shipped phases; this document defines the target and the remaining phases.

## The idea in one paragraph

A single Cloudflare Worker ("the broker") is the **token plane** for every SaaS/app integration: humans and machines authenticate once through Cloudflare Zero Trust, are authorized per-app by group/role claims, federate (link) their per-app accounts via OAuth, and fetch short-lived tokens from one API. Every app integration is declared in **one manifest**, which drives — with no duplication — the worker's registry, the Terraform-managed Cloudflare infrastructure (Access apps, policies, groups, service tokens, bookmarks, IdPs), the dashboard, and the CLI. The broker is also the **claims pump**: authenticating *as* each app (keypair/service auth) it pulls app-side groups and metadata into Cloudflare, and answers live authorization questions via Access External Evaluation.

## Planes

| Plane | Mechanism | Source of truth |
|---|---|---|
| Authentication (humans) | Zero Trust IdPs: GitHub org (today) + Okta (rich claims: groups, AMR, device) | Terraform |
| Authentication (machines) | Per-app Access service tokens | Terraform (opt-in per manifest entry) |
| Authorization | Per-app path-scoped Access apps; policies reference Access Groups fed by (a) IdP claims, (b) broker-synced app-side groups, (c) External Evaluation for live decisions | Manifest → Terraform |
| Federation (account linking) | Broker OAuth flows per app registration; strong-auth policy on callback paths; admin link-on-behalf for machines | Manifest → worker |
| Tokens | `/get-token/<slug>` with per-slug AUD validation; KV-stored rotating refresh tokens; cron refresh | Worker |
| App identity & metadata | Broker authenticates AS the app (github-app-jwt, okta-private-key-jwt, …) to fetch/refresh metadata, scopes, groups | Manifest (`appAuth`) → worker |
| Presentation | Dashboard (identity, device, apps, links), `/api/apps`, Access App Launcher bookmarks, CLI self-configuration | Manifest via `/api/apps` |

## The manifest (single source of truth)

`apps/manifest.json` (JSON: parseable by Terraform `jsondecode`, importable by the worker at build time, consumable by any CLI). One entry per app registration:

```jsonc
{
  "version": 1,
  "defaults": {
    "access": { "session_duration": "24h", "allow_groups": ["org-members"] },
    "link_policy": { "require_warp": true, "require_posture": [], "require_mfa": false }
  },
  "groups": {                       // Access Groups, manifest-defined
    "org-members":   { "github_team": null, "emails": [], "idp_groups": [] },
    "github-write":  { "github_team": "broker-github-write" },
    "cf-admin":      { "okta_group": "cf-admins" }
  },
  "apps": [
    {
      "slug": "github/jsmunro/Iv23lifj0i4aV6qYR76i",
      "display_name": "Brokers repo",
      "auth": {                     // consumed by worker oauth2Provider factory
        "kind": "oauth2",
        "authorize_url": "https://github.com/login/oauth/authorize",
        "token_url": "https://github.com/login/oauth/access_token",
        "client_id_var": "GITHUB_CLIENT_ID",
        "client_secret_var": "GITHUB_CLIENT_SECRET",
        "client_auth": "body"
      },
      "app_auth": { "kind": "github-app-jwt", "app_id_var": "GITHUB_APP_ID", "private_key_var": "GITHUB_APP_PRIVATE_KEY" },
      "scopes": { "declared": "installation-defined", "source": "metadata.permissions" },
      "access": { "allow_groups": ["github-write"], "service_token": true },
      "link_policy": { "require_mfa": true },        // overrides defaults; enforced where IdP supports AMR
      "claims_sync": { "kind": "github-teams", "interval": "24h" },   // phase: group sync
      "bookmark": { "app_launcher": true, "url": "https://broker.jsmunro.me/" }
    }
  ]
}
```

Consumers:
- **Worker**: `src/registry.ts` is generated from / imports the manifest (build-time); env-var names resolve at runtime as today. Zero drift between infra and code by construction.
- **Terraform**: `jsondecode(file("../apps/manifest.json"))` drives per-app Access apps (token app + stricter linking app), policies, Access Groups, service tokens, App Launcher bookmark apps.
- **CLI**: `cf-auth.sh` (and future richer CLIs) self-configure from `GET /api/apps`, which serves the manifest-derived registry + live metadata + access info (auds, group requirements) — a client needs only the broker URL.
- **Dashboard**: cards, scopes display, role/group requirements per app, link state.

## Identity providers

- GitHub org IdP (exists): login + `github_organization`/team claims.
- **Okta IdP (placeholder credentials until an Okta org exists)**: Terraform `cloudflare_zero_trust_access_identity_provider`, `type = "okta"`, variables for `okta_account`, `client_id`, `client_secret`, `authorization_server_id`; configured to request groups and custom session claims (AMR, device context) — Okta's authorization server can mint custom claims (device.trusted, amr, risk) which Access exposes to policies (incl. `auth_method` rules once AMR flows). Placeholders make the TF module shape real now; activating = filling four variables.
- Policy language: manifest `groups` entries compile to Access Groups with the right rule type per IdP (github team / okta group / email list). Linking policies (`link_policy`) compile to the callback-app policies: WARP, device posture, `auth_method` (AMR) where the login IdP supplies it.

## External Evaluation (live authorization)

- Access `external_evaluation` rule → broker endpoint `POST /ext-eval` (public path, NOT behind Access — Access itself is the caller): verifies Access's signed request JWT against the team JWKS, evaluates a manifest-declared live check (e.g. "user currently in app-side group X" using the broker's app credentials), responds with a JWT signed by the broker's own keypair, served at `GET /ext-eval/keys` (JWKS). Keypair = worker secret; same WebCrypto discipline as github-app-jwt.
- Used sparingly: manifest `access.external_eval: { check: "..." }` per app opts in; group-sync remains the default claims path.

## Machine identity

- Per-app service tokens (Terraform, manifest opt-in), `non_identity` policies; worker identity = `common_name`.
- **Admin link-on-behalf**: dashboard flow where a member of an admin group links an app *for* a machine identity — OAuth state is a signed envelope `{target_identity, initiated_by, exp}` (HMAC with worker secret) so the callback stores the refresh token under the machine's KV identity and the audit trail names the admin. Admin group defined in manifest.

## Delivery phases

1. **Per-app Access + Terraform foundation** (spec: 2026-07-24-per-app-access-design.md, amended): manifest v1 (registry + TF read it), per-app token/linking Access apps, Access Groups from manifest, service tokens, per-slug AUD validation, Okta IdP module with placeholders, scopes surfaced in /api/apps + dashboard, R2 state.
2. **Admin link-on-behalf** (signed-state envelope, dashboard admin UI, audit line in meta).
3. **Claims pump**: `claims_sync` — broker pulls app-side teams/groups (github-teams first) and pushes Access rule lists via CF API on cron.
4. **External Evaluation**: `/ext-eval` + JWKS + manifest opt-in per app.
5. **Second real IdP**: fill Okta placeholders, enable AMR-based `link_policy.require_mfa` enforcement (passkey), demonstrate an Okta-claims-gated app (e.g. okta/… registration as the second full instance of the design).

Each phase lands via the standard spec→plan→subagent loop with its own review gate; the manifest schema is versioned (`version` field) and additive across phases.

## Invariants (carry through every phase)

Auth-before-routing; per-slug AUD verification; curated metadata only; best-effort side-channels never break token flows; zero runtime npm deps; secrets only in worker secrets; state/keys never in git; all Cloudflare-side resources in Terraform except the worker script (wrangler) and OAuth client registrations (provider APIs).
