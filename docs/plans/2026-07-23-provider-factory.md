# Provider Factory & App Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Declarative OAuth2 provider factory, 3-part app slugs (`<provider>/<org>/<clientid>`) with full migration (no legacy routes/keys), app registry with keypair-authed metadata, `/api/apps`, and CLI name resolution.

**Architecture:** New `src/oauth2.ts` (factory), `src/registry.ts` (single source of truth: AppConfigs + providers by slug), `src/appauth.ts` (github-app-jwt metadata fetch). Engine/dashboard consume only the registry. Old per-provider class files are deleted.

**Tech Stack:** Existing only — Worker TS strict, WebCrypto, vitest, zero runtime deps.

## Global Constraints

- Spec `docs/superpowers/specs/2026-07-23-provider-factory-design.md` is binding and detailed — every slug rule, factory field, request shape, metadata mapping, KV key, and route in it is a requirement. Read it fully before each task.
- Full migration: two-segment routes and un-slugged KV keys must be GONE from code. No compatibility branches.
- App slugs (exact): `github/jsmunro/Iv23lifj0i4aV6qYR76i` (displayName "Brokers repo"), `cloudflare/jackm/9f2c965eeb2fcc390fc3843935de35bc` (displayName "central-auth-broker").
- Existing test assertions for provider request/response shapes and engine/dashboard behavior are the byte-compatibility oracle: they may be RELOCATED (files renamed, setup changed to factory construction, callback paths updated to 3-part slugs) but individual assertions must not be weakened or deleted; deletions require an explicit note in the task report.
- Auth-before-routing invariant unchanged. All meta/metadata operations best-effort. `npx tsc --noEmit` clean + `npx vitest run` fully green before every commit. Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Core migration — factory, registry, routing, dashboard

**Files:**
- Create: `src/oauth2.ts`, `src/registry.ts`, `test/contract.ts`, `test/oauth2.test.ts`
- Modify: `src/index.ts` (slug parsing: join path segments after action; registry import), `src/dashboard.ts` (registry import for skeleton + handlers; unlink takes joined slug), `src/types.ts` (AppConfig; keep Env explicit)
- Delete: `src/providers/github.ts`, `src/providers/cloudflare.ts` (their config + describeLink logic move into registry AppConfig entries; describeLink functions may live in `src/registry.ts` or small `src/apps/*.ts` files)
- Test: migrate `test/github.test.ts`, `test/cloudflare.test.ts` (construct via registry/factory; same assertions; callback URLs now 3-part), `test/index.test.ts`, `test/dashboard.test.ts` (3-segment routes; unknown slug 404 includes full slug)

**Interfaces (Produces):** `oauth2Provider(config: OAuth2Config): AuthProvider` per spec; `registry.apps: Record<string, AuthProvider>`; `registry.appConfigs: Record<string, AppConfig>`; `providerContractTests(name, factory, opts)` from `test/contract.ts`.

- [ ] Write contract suite + oauth2 factory unit tests (clientAuth "basic" branch included: Authorization header, no client_id in body) — run, FAIL
- [ ] Implement `src/oauth2.ts` + `src/registry.ts` with the two AppConfigs — factory/oauth2 tests green
- [ ] Migrate engine + dashboard to registry and 3-segment slugs; migrate all existing test files — run FULL suite green; `tsc --noEmit` clean
- [ ] Commit: `feat!: provider factory, app registry, 3-part app slugs (full migration)`

### Task 2: App metadata subsystem

**Files:**
- Create: `src/appauth.ts`, `test/appauth.test.ts`
- Modify: `src/types.ts` (AppAuthConfig, AppMetadata; Env + GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY), `src/registry.ts` (github app gains appAuth), `src/index.ts` (cron metadata refresh w/ 24h staleness; `GET /api/apps` route), `src/dashboard.ts` (`handleApps`; app cards: metadata name preferred, slug subtitle), tests for /api/apps + dashboard cards + cron.

**Interfaces (Consumes):** Task 1 registry. **(Produces):** `fetchAppMetadata(config, env): Promise<AppMetadata | null>`; KV `app:<slug>`; `GET /api/apps` shape per spec.

- [ ] TDD per spec's testing bar: JWT header/claims + signature verified against test-generated RSA keypair; PEM (PKCS#8) parsing; /app request shape; curated mapping; no-appAuth → null; KV cache 24h staleness + stale-on-failure; /api/apps shape; dashboard rendering with metadata and displayName fallback; cron partial-failure isolation
- [ ] Implement; full suite green; commit: `feat: app metadata via app-level keypair auth + /api/apps`

### Task 3: CLI name resolution + docs

**Files:** Modify `scripts/cf-auth.sh`, `README.md`.

- [ ] cf-auth.sh: arg with `/` → slug verbatim; else resolve via `/api/apps` (case-insensitive match on display_name or metadata name; single match → slug; else list candidates to stderr, exit 1). `bash -n` clean.
- [ ] README: slugs, /api/apps, adding-an-app walkthrough (config + secrets + callback URL), name resolution examples. Aliases updated (`cf-auth.sh brokers-repo`).
- [ ] Commit: `feat: cf-auth.sh app-name resolution; docs for app registry`

### Task 4: Deploy, migrate, reconfigure (controller-executed)

- [ ] Secrets: `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` (locate private key + app id in 1Password "Github App - Brokers repo" item; if absent ask user to generate in GitHub App settings and add to the item; convert PEM PKCS#1→PKCS#8 via `openssl pkcs8 -topk8 -nocrypt`).
- [ ] Deploy; migrate KV: copy `refresh:github:*`→`refresh:github/jsmunro/Iv23lifj0i4aV6qYR76i:*`, same for cloudflare + `meta:` keys; delete old keys.
- [ ] Update Cloudflare OAuth client redirect_uris to `/callback/cloudflare/jackm/9f2c...` via API; report GitHub App callback URL for manual update.
- [ ] Verify live: /api/apps (github entry has metadata after forced refresh), get-token with full slug, cf-auth.sh name resolution, dashboard cards.
- [ ] Commit remaining changes; create GitHub repo remote and push branch + main (broker token via cf-auth.sh github/…).
