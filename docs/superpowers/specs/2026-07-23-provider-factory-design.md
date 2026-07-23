# Provider Factory, App Registry & Full Migration — Design

2026-07-23 (v2 — supersedes v1 alias design after review). Branch `feature/provider-factory`.
Approved decisions: full migration with NO legacy routes/keys; addressing is `<provider>/<org>/<clientid>`; app registrations = code config + worker secrets, fetched app metadata cached in KV (Option 1); optional app-level keypair auth for metadata (GitHub App JWT now; Okta API Service Integration later); friendly-name→slug resolution in the CLI/dashboard from broker-served metadata.

## App addressing (breaking change, no compatibility shims)

- Every app registration is addressed by slug `<provider>/<org>/<clientid>`:
  - `provider`: `[a-z0-9-]+` (e.g. `github`, `cloudflare`)
  - `org`: provider-side namespace, `[a-z0-9-]+` (GitHub owner login e.g. `jsmunro`; Cloudflare account name `jackm`)
  - `clientid`: the OAuth client id verbatim (URL-safe in practice; validated `[A-Za-z0-9._~-]+`)
- Routes become exactly: `GET /get-token/<provider>/<org>/<clientid>`, `GET /callback/<provider>/<org>/<clientid>`, `DELETE /api/links/<provider>/<org>/<clientid>`. Two-segment forms (`/get-token/github`) are GONE — they 404 with the standard unsupported-provider shape. Engine joins all segments after the action with `/` and looks up the registry; the registry key IS the slug.
- KV keys: `refresh:<slug>:<userId>`, `meta:<slug>:<userId>` (slug contains `/`, never `:` — cron's split(":") parsing unchanged). Existing 2-segment-era keys are migrated at deploy time (Task: copy values to new keys, delete old) — refresh tokens remain valid.
- `redirect_uri` = `${BROKER_URL}/callback/<slug>`; each app's registration on the provider side must list its own callback URL (deploy task updates the Cloudflare OAuth client via API and reports the GitHub App URL for manual update).

## Registry & factory

- `src/registry.ts`: exports `apps: Record<string, AuthProvider>` keyed by full slug, plus `appConfigs: Record<string, AppConfig>` (below). Engine and dashboard import ONLY from here.
- `src/oauth2.ts`: `oauth2Provider(config: OAuth2Config): AuthProvider` — unchanged from v1 spec except `slug` is the full 3-part slug and `redirect_uri` derives from it:
  - Fields: `slug`, `authorizeUrl`, `tokenUrl`, `clientIdVar`, `clientSecretVar`, `clientAuth: "body"|"basic"`, `authorizeParams?(env)`, `tokenParams?`, `extractTokens?(json)` (default access_token/refresh_token/expires_in; factory re-attaches `access_token` onto returned `data` if renamed), `requireRefreshToken?` (default true), `describeLink?(token, env)`.
  - Behavior identical to current hand-written providers: authorize URL (`client_id`, `redirect_uri`, `response_type=code`, `state=crypto.randomUUID()`, + authorizeParams); callback exchange (form-encoded POST, `Accept: application/json`, grant_type=authorization_code, code, redirect_uri; credentials per clientAuth — `basic` sends `Authorization: Basic base64(id:secret)` and omits client_id/secret from body); non-2xx or `error` field → throw `error_description || error || "…(<status>)"`; refresh via grant_type=refresh_token with `newRefreshToken` only when present. Env vars resolved by NAME with a runtime string check throwing a clear config error.
- `AppConfig` (per registration, in `src/apps/<provider>-<org>.ts` files or one `src/apps.ts` — implementer's structural call, one clear file boundary either way):
  ```ts
  interface AppConfig {
    slug: string;                 // "<provider>/<org>/<clientid>"
    displayName: string;          // human name fallback when metadata unavailable
    provider: AuthProvider;       // built via oauth2Provider(...) (or custom impl)
    appAuth?: AppAuthConfig;      // optional app-level auth for metadata
  }
  ```
- Current registrations migrate to:
  - `github/jsmunro/Iv23lifj0i4aV6qYR76i` — displayName "Brokers repo", existing GITHUB_CLIENT_ID/SECRET vars, describeLink as today.
  - `cloudflare/jackm/9f2c965eeb2fcc390fc3843935de35bc` — displayName "central-auth-broker", CLOUDFLARE_OAUTH_* vars, scope param from CLOUDFLARE_OAUTH_SCOPES, describeLink as today.

## App metadata subsystem

- `AppAuthConfig` (discriminated union, one kind now):
  ```ts
  type AppAuthConfig = { kind: "github-app-jwt"; appIdVar: string; privateKeyVar: string };
  // future: { kind: "okta-private-key-jwt"; ... } — the union is the extension point
  ```
- `src/appauth.ts`: `fetchAppMetadata(config: AppConfig, env: Env): Promise<AppMetadata | null>`:
  - `github-app-jwt`: build RS256 JWT via WebCrypto (`iss`=app id from env var, `iat`=now-60, `exp`=now+540; private key = PKCS#8 PEM in the secret named by `privateKeyVar`); `GET https://api.github.com/app` with `Authorization: Bearer <jwt>`, `Accept: application/vnd.github+json`, `User-Agent`; map to metadata.
  - No `appAuth` → return null (displayName-only app).
  - `AppMetadata`: `{ name?: string, description?: string, owner?: string, permissions?: Record<string,string>, events?: string[], html_url?: string, fetched_at: string }` — curated, never the raw blob.
- KV cache: `app:<slug>` → AppMetadata JSON. Refreshed: (a) by the existing cron (once per run, only when `fetched_at` older than 24h), (b) best-effort — failures logged, stale cache retained.
- `GET /api/apps` (Access-authed like all /api routes): array of `{ slug, provider, org, client_id, display_name, metadata? }` for every registry entry — metadata from KV cache when present. This is the name→slug resolution source for CLI and dashboard.
- Dashboard: link cards are now app cards — title `display_name` (metadata `name` preferred), subtitle full slug, plus existing linked/details/timestamps and Link/Unlink. Data: merge `/api/apps` + `/api/links` client-side (or extend `/api/links` entries with the app fields — implementer's call, ONE call preferred).

## CLI helper

- `cf-auth.sh <name-or-slug>`: if the argument contains `/` treat as slug; otherwise resolve via `GET /api/apps` — match against `display_name` (case-insensitive) or metadata name; exactly one match → use its slug; zero or multiple → list candidates (slug + display_name) to stderr, exit 1. Usage text updated. Requires jq (already).

## GET /app note

The literal metadata endpoint is `https://api.github.com/app` (the "authenticated app" endpoint). Sign-off checklist: JWT clock skew handled by iat-60; PEM parsing must strip header/footer/newlines before base64 decode; key import `RSASSA-PKCS1-v1_5`/`SHA-256`.

## Secrets added (deploy task)

- `GITHUB_APP_ID` (numeric app id), `GITHUB_APP_PRIVATE_KEY` (PKCS#8 PEM; the .pem GitHub generates is PKCS#1 — deploy task converts via `openssl pkcs8 -topk8 -nocrypt` before upload). Cloudflare app has no appAuth (metadata null; displayName used).

## Testing bar

- `npx tsc --noEmit` clean; full vitest green. Existing provider request/response assertions preserved (moved, not weakened) — factory-built GitHub/Cloudflare must satisfy the same request-shape tests as today (URLs now with 3-part callback paths).
- Contract suite (`test/contract.ts`, per v1) runs against both factory-built apps.
- New tests: 3-segment routing (get-token/callback/unlink; unknown slug 404 includes full slug); registry/dashboard single source of truth; github-app-jwt (JWT header/claims shape, PEM import, request to /app — signature verifiable with a test-generated keypair); metadata KV caching incl. 24h staleness and failure-keeps-stale; /api/apps shape; dashboard card rendering with metadata and displayName fallback; cf-auth.sh name resolution paths (bash test optional — at minimum document manual verification in the deploy task).
- Cron: metadata refresh must not break token refresh on partial failure.

## Out of scope

Okta/Slack/AWS real registrations (the union + factory are the extension points); npm package; dynamic runtime app registration; storing private keys anywhere but worker secrets.
