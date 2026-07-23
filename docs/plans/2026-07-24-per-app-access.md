# Phase 1 — Manifest, Per-App Access & Terraform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Manifest-driven registry, strict per-slug AUD validation, service-token identity, Terraform-managed per-app Access apps/groups/tokens/bookmarks + gated Okta IdP, updated CLI.

**Architecture:** `apps/manifest.json` consumed by worker (build-time import) and Terraform (`jsondecode`). Worker: registry adapter, aud-list JWT verification, machine identity. Infra: `infra/` TF with R2 backend, imports of existing resources.

**Tech Stack:** Existing worker stack; Terraform cloudflare provider ~>4.x; bash/jq/node (no new runtime deps anywhere).

## Global Constraints

- Spec `docs/superpowers/specs/2026-07-24-per-app-access-design.md` (v2, STRICT auds) is binding in full detail; parent context `2026-07-24-endstate-architecture.md`. Read the spec before each task.
- STRICT aud rule (spec §2 verbatim): `/get-token/<slug>` verifies against `[auds[slug].token]` only; `/callback/<slug>` against `[auds[slug].link]` only; manifest-registered slug missing from `ACCESS_APP_AUDS` → 403 fail-closed with logged slug; unregistered slugs and dashboard/`/api/*` → root `ACCESS_AUD`.
- Existing behavior oracle: current test assertions for provider request shapes, engine flows, dashboard, metadata remain green (relocation fine, weakening not).
- Auth-before-routing; best-effort side channels; zero runtime npm deps; secrets only via env/worker secrets; nothing sensitive committed (backend.hcl, tfstate, tfvars with real Okta values are gitignored).
- `npx tsc --noEmit` + `npx vitest run` green before every commit; TF tasks additionally `terraform fmt -check` + `terraform validate` (init with `-backend=false` for CI-less validation). Commits end `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- IdP id for github-org rules: `db8cf4be-fe22-4119-9346-6baf1a6d3f8a`, org `jsmunro`. Root Access app id `33bb3ebb-7ed0-45e0-9c1f-77acd3e8ad8f`; account `314e7e015b5f4429c4e2da1e6ec93271`; zone id `0317fdb8f32686c5173f4bcd7c5d1690`; KV namespace `ef17d3c055e34a8699a596d47878e44c`; DNS record id `634124b825375f4f95964d6826b4c220` (AAAA broker.jsmunro.me).

---

### Task 1: Manifest + validator + worker registry adapter + scopes surfacing

**Files:** Create `apps/manifest.json`, `scripts/validate-manifest.mjs`, `test/manifest.test.ts`. Modify `src/registry.ts` (adapter importing manifest), `src/types.ts` (manifest types), `src/dashboard.ts` (`/api/apps` gains `scopes` + `access.groups`/`service_token` fields from manifest; card scopes summary + groups, escaped), tests.

- [ ] Manifest v1 per spec §1 (two apps, groups incl. break-glass org-members). Validator per spec §1 rules; vitest wraps it (happy + each sad path).
- [ ] Registry adapter: manifest → `appConfigs`/`apps` via `oauth2Provider` (env-var names, `authorize_params_var` for cloudflare scopes); `describeLink`/`appAuth` wiring stays code-side keyed by slug. Existing suites = oracle.
- [ ] `/api/apps` + dashboard scopes/groups display (access.token_aud/link_aud fields appear in Task 2). Full suite green; commit.

### Task 2: Strict per-slug AUDs + service-token identity

**Files:** Modify `src/access.ts` (`verifyAccessJwt(jwt, env, expectedAuds: string[])`), `src/index.ts` (route→aud selection per spec §2 STRICT; identity `email ?? common_name`, neither → 403; `/api/me` service shape), `src/dashboard.ts` (`access.token_aud`/`link_aud` in /api/apps), `wrangler.toml` (`ACCESS_APP_AUDS = "{}"`), tests.

- [ ] TDD per spec §5: aud intersection; strict selection per route; registered-but-unmapped slug → 403 fail-closed logged; unregistered slug → root aud then 404; malformed ACCESS_APP_AUDS JSON → fail closed, clear error; service-token JWT (common_name, no email) through get-token stores KV under common_name; `/api/me` returns `{email: common_name, service: true}`. Full suite green; commit.

### Task 3: Terraform

**Files:** Create `infra/{main.tf,variables.tf,access.tf,groups.tf,idp.tf,dns.tf,kv.tf,outputs.tf,bootstrap.sh,sync-auds.sh,backend.hcl.example,README.md}`; `.gitignore` additions (backend.hcl, *.tfstate*, .terraform/, *.auto.tfvars).

- [ ] Implement per spec §3: manifest-driven per-app token+linking apps (self_hosted_domains path pairs), group compilation (github_team/okta_group/emails; org-rule for org-members), link_policy require-rules (warp/posture), service tokens + non_identity policies, bookmarks, gated Okta IdP (okta_enabled=false default, PLACEHOLDER vars, claims per spec), import blocks (root app/DNS/KV with ids from Global Constraints), outputs (app_auds map {token,link}, service_tokens sensitive, group ids).
- [ ] `sync-auds.sh`: reads `terraform output -json app_auds`, patches wrangler.toml ACCESS_APP_AUDS via jq/sed idempotently; `bash -n` clean. `bootstrap.sh` per spec.
- [ ] `terraform init -backend=false && terraform fmt -check && terraform validate` clean. Commit. (NO apply — controller does that.)

### Task 4: CLI per-app tokens + machine path

**Files:** Modify `scripts/cf-auth.sh`, `README.md`.

- [ ] Per-app `cloudflared access token --app="$BROKER_URL/get-token/$SLUG"` (+login fallback same URL); CF_ACCESS_CLIENT_ID/SECRET header path requiring slug arg; `-f` + friendly non-2xx handling on both curls (closes M-A). README: phase-1 model, terraform runbook pointer, machine usage. `bash -n`; commit.

### Task 5: Provision & deploy (controller-executed, ORDER MANDATORY)

- [ ] `infra/bootstrap.sh` (R2 bucket + backend token); `terraform init` with backend; `terraform plan` — REVIEW: imports in-place only, no replaces; then `apply`.
- [ ] `sync-auds.sh` → verify wrangler.toml; `npx wrangler deploy`.
- [ ] Live verify: per-app human flow (CLI token fetch per app — expect one-time browser hop), dashboard link state intact, service-token fetch (github app) via headers, Access audit shows per-app entries, root routes still work, old cloudflared root-app tokens REJECTED on app routes (strictness proof).
- [ ] Store service-token credentials in 1Password (Services vault, item `broker service token - github`); commit; push branch; merge to main after final whole-branch review; push main.
