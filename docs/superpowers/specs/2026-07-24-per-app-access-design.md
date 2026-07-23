# Per-App Access Identity + Terraform — Design

2026-07-24. Approved: one path-scoped Cloudflare Access application per app registration (per-app authz, sessions, audit, service tokens), default policy = members of GitHub org `jsmunro` via the Zero Trust GitHub IdP, Terraform-managed Cloudflare infra with R2 remote state. Branch `feature/per-app-access`.

## Access application topology

- Root app (existing, `33bb3ebb-7ed0-45e0-9c1f-77acd3e8ad8f`, aud `8912bf9e…`) keeps covering `broker.jsmunro.me` — dashboard `/`, `/api/*`. Its allow policy WIDENS to the org default (below). Imported into Terraform, not recreated.
- Per-app Access app per registration slug, self_hosted with `self_hosted_domains = ["broker.jsmunro.me/get-token/<slug>", "broker.jsmunro.me/get-token/<slug>/*", "broker.jsmunro.me/callback/<slug>", "broker.jsmunro.me/callback/<slug>/*"]` (Access most-specific-path precedence puts these ahead of the root app). Name: `broker app — <displayName> (<slug>)`. Session duration default 24h, overridable per app.
- Default allow policy (every app + root): GitHub org rule `{ github_organization: { name: "jsmunro", identity_provider_id: "db8cf4be-fe22-4119-9346-6baf1a6d3f8a" } }`. Per-app extra include rules and a per-app `allowed_emails` override are Terraform variables.
- Per-app service token (opt-in per app, Terraform variable `create_service_token`): a `non_identity` decision policy on that app including the token. Token secrets are Terraform outputs (sensitive) — retrieved via `terraform output`, never committed.

## Terraform (`infra/`)

- Provider `cloudflare` (v4.x pinned). Backend: S3-compatible R2 — bucket `broker-terraform-state` (bootstrap step creates bucket + scoped R2 API token; documented in `infra/README.md`; backend config via `-backend-config` file `infra/backend.hcl`, gitignored, sample committed as `backend.hcl.example`).
- Files: `infra/main.tf` (providers/backend), `infra/access.tf` (root + per-app apps/policies/service tokens), `infra/dns.tf` (broker AAAA record — imported), `infra/kv.tf` (AUTH_TOKENS namespace — imported), `infra/variables.tf`, `infra/outputs.tf` (map slug→aud, slug→access app id, service token id/secret sensitive).
- `apps` variable: map keyed by slug: `{ display_name, session_duration?, extra_allowed_emails?, create_service_token? }` — mirrors `src/registry.ts`; keeping them in sync is documented as part of "adding an app" (registry entry + tfvars entry + apply).
- Existing resources imported (root Access app, DNS record, KV namespace) — `import` blocks in config so `terraform plan` is clean from first apply. The Cloudflare OAuth client and Worker script itself stay OUT of Terraform (wrangler owns the worker; OAuth clients unsupported/managed via API).
- State bucket + `backend.hcl` + `*.tfstate` + `.terraform/` gitignored.

## Worker changes

- `AppConfig` gains `accessAud?: string`. `wrangler.toml` gains var `ACCESS_APP_AUDS` = JSON object mapping slug→aud (non-secret; filled from `terraform output -json app_auds` — a helper script `infra/sync-auds.sh` patches wrangler.toml and is run before deploy; the mapping is ALSO the source for registry `accessAud` at runtime: registry reads env, not code constants — so AppConfig does NOT hardcode auds; drop `accessAud` from AppConfig and resolve from `env.ACCESS_APP_AUDS` instead. Final call: env var only, parsed once per request.)
- JWT verification: `verifyAccessJwt(jwt, env, expectedAud)` — accepts an explicit expected aud. Routing computes it: for `/get-token/<slug>`, `/callback/<slug>` → per-slug aud from `ACCESS_APP_AUDS[slug]`, falling back to `env.ACCESS_AUD` when absent (migration path & unknown-slug requests — note: for unknown slugs verification uses the root aud and then 404s). Dashboard/`/api/*` → root `ACCESS_AUD`. `DELETE /api/links/<slug>` is an `/api` route → root aud (the dashboard session performs unlink).
- Service tokens: Access `non_identity` JWTs carry `common_name` (token client id) and no `email`. `verifyAccessJwt` returns the payload; identity resolution becomes `payload.email ?? payload.common_name`; `sub` type unchanged elsewhere. KV keys work unchanged (`refresh:<slug>:<common_name>`). Machine identities calling `get-token` for a never-linked slug receive the standard `setup_required` JSON; interactive linking for machines is OUT OF SCOPE (documented — human links via dashboard remain the only linking path; a future admin link-on-behalf feature may change that).
- `/api/apps` entries gain `access?: { aud: string, app_id?: string }` — aud from env mapping; app_id OMITTED (worker doesn't need it; Terraform output is the operator's source). Dashboard card may show a small "per-app access" badge when aud present (cosmetic, escaped).

## CLI (`scripts/cf-auth.sh`)

- Token acquisition becomes per-app: after slug resolution, `cloudflared access token --app="$BROKER_URL/get-token/$SLUG"` (falling back to `cloudflared access login "$BROKER_URL/get-token/$SLUG"` on empty). The `/api/apps` resolution call keeps using the ROOT app token (current behavior). First use of each app triggers one silent browser hop (same IdP session).
- New optional env vars `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET`: when both set, skip cloudflared entirely and send `CF-Access-Client-Id`/`CF-Access-Client-Secret` headers on the get-token request (service-token/machine path). Name resolution in this mode requires a slug argument (machines pass slugs; resolution via /api/apps root token is human-path only — document).

## Testing bar

- Worker: `verifyAccessJwt` per-aud selection (per-slug aud used for get-token/callback of that slug; root aud for dashboard//api; fallback to root when slug unmapped); malformed `ACCESS_APP_AUDS` JSON → clear startup-style error per request, fail closed; service-token payload (`common_name`, no email) resolves identity and stores KV under common_name; `/api/apps` access field shape incl. omission when unmapped. All existing tests green; `tsc --noEmit` clean.
- Terraform: `terraform validate` + `terraform plan` reviewed by controller before any apply; import blocks resolve cleanly (no destroy/recreate of the root app, DNS, or KV — a plan showing replacement of any imported resource is a STOP).
- cf-auth.sh: `bash -n`; live verification of per-app token flow and service-token header path (controller, deploy task).

## Rollout order (deploy task)

1. Terraform bootstrap (R2 bucket + token, backend init), imports, apply → per-app Access apps + widened root policy + service token (github app: yes, as the first machine-identity example).
2. `sync-auds.sh` → deploy worker with per-slug aud validation (fallback keeps old behavior for anything unmapped — deploy-order safe).
3. Verify: human flow both apps, machine flow via service token, dashboard, audit log entries per app.
4. Commit + push.

## Out of scope

Admin link-on-behalf for machine identities; OAuth client management in Terraform; Terraform-managing the worker script; multi-env (staging) stacks.
