# Phase 1 — Manifest, Per-App Access Identity & Terraform — Design

2026-07-24 (v2, amended to the manifest-driven form after the end-state architecture was approved; v1's non-manifest details are superseded). Parent: `2026-07-24-endstate-architecture.md`. Branch `feature/per-app-access`.

Delivers: manifest v1 as single source of truth; per-app path-scoped Access apps split into token-app + stricter linking-app; Access Groups (IdP claims + email lists); per-app service tokens; per-slug AUD validation in the worker; Okta IdP Terraform module with placeholder credentials; declared scopes surfaced in `/api/apps` and the dashboard; Terraform with R2 remote state.

## 1. Manifest (`apps/manifest.json`)

Schema exactly as the end-state doc's example, restricted to phase-1 fields:

- Top level: `version: 1`, `defaults`, `groups`, `apps`.
- `defaults`: `{ access: { session_duration, allow_groups }, link_policy: { require_warp: boolean, require_posture: string[] } }` (no `require_mfa` until an AMR-emitting IdP exists — field accepted but compiled only to a Terraform comment/variable placeholder).
- `groups`: map name → `{ emails?: string[], github_team?: string, okta_group?: string }`. Compiled to `cloudflare_zero_trust_access_group` resources: `github_team` → GitHub-org rule with team + IdP id `db8cf4be-fe22-4119-9346-6baf1a6d3f8a`, org `jsmunro`; `okta_group` → okta rule bound to the placeholder Okta IdP (created but unusable until activated — acceptable); `emails` → email includes. A group may combine sources (rules OR-ed inside the group).
- Phase-1 `groups` content: `org-members` = `{ github_team: null, emails: ["jack@jsmunro.me"] }` PLUS a GitHub-org (no team) rule — i.e. org membership OR the explicit email. (Explicit email retained as break-glass so a GitHub IdP outage cannot lock out the operator.)
- `apps[]` entry fields (phase 1): `slug`, `display_name`, `auth` (kind "oauth2": authorize_url, token_url, client_id_var, client_secret_var, client_auth, optional authorize_params_var for the Cloudflare scopes case, optional require_refresh_token), `app_auth?` (github-app-jwt), `scopes` (`{ declared: string | string[], source?: "metadata.permissions" }`), `access` (`{ allow_groups: string[], session_duration?, service_token?: boolean }`), `link_policy?` (overrides defaults), `bookmark?` (`{ app_launcher: boolean }`).
- Two entries: the existing GitHub and Cloudflare registrations (values as currently in `src/registry.ts`; github: `access.service_token: true`, `scopes.source: "metadata.permissions"`; cloudflare: `scopes.declared` = the 107-scope list source note `"var:CLOUDFLARE_OAUTH_SCOPES"`).
- Validation: `scripts/validate-manifest.mjs` (node, no deps) — JSON parse, slug regex `^[a-z0-9-]+/[a-z0-9-]+/[A-Za-z0-9._~-]+$`, group references resolve, env-var names `^[A-Z][A-Z0-9_]*$`, unknown top-level/app fields rejected. Run in `npm test` (vitest shells out or a vitest test imports and asserts) and as a Terraform precondition (`terraform_data` + `jsondecode` naturally fails on bad JSON; reference checks live in TF `validation`/`precondition` blocks where expressible).

## 2. Worker changes

- `src/registry.ts` becomes a thin adapter: `import manifest from "../apps/manifest.json"` (wrangler/esbuild native JSON import); builds `appConfigs`/`apps` from `manifest.apps`, wiring `auth.kind === "oauth2"` entries through `oauth2Provider` (env-var names from the manifest; `authorize_params_var` → authorizeParams reading that env var as the `scope` value — preserves current Cloudflare behavior). `describeLink` implementations remain code (a small map slug-prefix/provider → function in `src/registry.ts`; manifest does not carry code).
- Per-slug AUD: `wrangler.toml` var `ACCESS_APP_AUDS` = JSON `{ "<slug>": { "token": "<aud>", "link": "<aud>" } }` synced from Terraform output by `infra/sync-auds.sh` (jq-based patcher, idempotent). `verifyAccessJwt(jwt, env, expectedAuds: string[])` — accepts a list; verification requires the JWT `aud` to intersect it. Route → expected auds: `/get-token/<slug>` → `[auds[slug].token, env.ACCESS_AUD]`; `/callback/<slug>` → `[auds[slug].link, env.ACCESS_AUD]`; unmapped slug or dashboard/`/api/*` → `[env.ACCESS_AUD]`. (Root aud stays accepted everywhere in phase 1 — single-worker rollout safety; tightening to per-app-only is a follow-up toggle once TF-applied auds are verified live.)
- Service tokens: Access `non_identity` JWTs have `common_name`, no `email`. Identity = `payload.email ?? payload.common_name`; if neither → 403 invalid. All KV paths unchanged. `/api/me` for a service principal returns `{ email: common_name, service: true }` (dashboard is human-oriented; API correctness only).
- `/api/apps` entries gain: `scopes` (declared value; when `source: "metadata.permissions"` and metadata present, the resolved permissions object), `access: { groups: string[], token_aud?: string, link_aud?: string, service_token: boolean }`. Dashboard cards show scopes summary + required groups (escaped).
- `wrangler.toml`: `ACCESS_APP_AUDS = "{}"` placeholder committed; sync script fills it.

## 3. Terraform (`infra/`)

- Provider `cloudflare` ~> 4.x pinned; backend S3-compatible R2: bucket `broker-terraform-state` (bootstrap: `infra/bootstrap.sh` creates bucket via API + prints R2-scoped token instructions; `backend.hcl` gitignored, `backend.hcl.example` committed).
- `locals { manifest = jsondecode(file("${path.module}/../apps/manifest.json")) }` — everything below derives from it.
- Resources:
  - Root Access app (IMPORT `33bb3ebb-7ed0-45e0-9c1f-77acd3e8ad8f`): domain `broker.jsmunro.me`, policy rebuilt as allow `org-members` group. DNS AAAA (IMPORT), KV namespace (IMPORT). Import blocks in config; plan must show NO replace of imported resources (hard stop).
  - Per app: **token app** `self_hosted_domains = ["broker.jsmunro.me/get-token/<slug>", ".../get-token/<slug>/*"]`, policy = allow union of `access.allow_groups` groups (+ `non_identity` service-token policy when `service_token`); **linking app** `self_hosted_domains = [".../callback/<slug>", ".../callback/<slug>/*"]`, policy = same groups PLUS require-rules compiled from `link_policy` (`require_warp` → warp require rule; `require_posture` → device-posture integration id require rules).
  - Access Groups from `manifest.groups`.
  - Service tokens (`cloudflare_zero_trust_access_service_token`) for apps with `access.service_token`, name `broker-<slug>` (slashes → `-`); attached via per-app `non_identity` policy.
  - Bookmark/App Launcher apps for `bookmark.app_launcher: true` entries.
  - **Okta IdP** (`cloudflare_zero_trust_access_identity_provider`, `type = "okta"`): variables `okta_account`, `okta_client_id`, `okta_client_secret`, `okta_authorization_server_id`, all defaulting to `"PLACEHOLDER"`; count-gated by `var.okta_enabled` (default **false**) so placeholders create nothing until real values exist — the module shape is the deliverable. Claims config requests: groups, and `claims = ["amr", "groups", "device_trusted", "risk_level"]` (documented as adjustable to what the Okta authz server actually mints).
- Outputs: `app_auds` (map slug → { token, link } auds), `service_tokens` (map slug → { id, client_id, client_secret }, sensitive), `access_group_ids`.
- `infra/README.md`: bootstrap, import, apply, sync-auds, secret-retrieval runbook.

## 4. CLI (`scripts/cf-auth.sh`)

- Per-app tokens: after slug resolution, `cloudflared access token --app="$BROKER_URL/get-token/$SLUG"` (login fallback against the same URL). `/api/apps` resolution keeps the root-app token.
- Machine path: when `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` are set, skip cloudflared and send `CF-Access-Client-Id`/`CF-Access-Client-Secret` headers; require a slug argument (no name resolution) — document why.
- Non-2xx handling on both curl calls (`-f` + friendly stderr message) — closes the recorded M-A follow-up.

## 5. Testing bar

- Worker: manifest-driven registry produces byte-identical provider behavior (existing suites are the oracle again); `verifyAccessJwt` aud-list intersection incl. per-slug/link/root selection and unmapped fallback; malformed `ACCESS_APP_AUDS` → 500-safe fail-closed (clear error, no token issued); service-token identity resolution (email absent) end-to-end through get-token with KV under common_name; `/api/apps` scopes+access shapes; validate-manifest happy/sad paths. `tsc --noEmit` clean; full vitest green.
- Terraform: `terraform fmt -check`, `validate`; controller reviews `plan` before ANY apply; imported resources must show in-place updates only.
- Live (controller): human flow on both apps end-to-end (dashboard link/unlink + CLI token fetch per-app), service-token fetch for github app, per-app entries visible in Access audit log, App Launcher shows bookmark.

## Out of scope (later phases)

Admin link-on-behalf (2); claims sync/rule-list pump (3); `/ext-eval` + broker JWKS (4); Okta activation + AMR `require_mfa` enforcement (5); OAuth client management in TF; worker script in TF.
