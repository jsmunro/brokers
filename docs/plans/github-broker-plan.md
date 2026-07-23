# Central Auth Broker — GitHub Integration Plan

Implements design1.md + design2.md: a modular, extensible token broker on Cloudflare Workers,
with GitHub as the first provider. Slack/AWS provider code in the design docs is corrupted
(mangled URLs) and is explicitly OUT OF SCOPE — the extensible registry pattern must make
adding them later a drop-in.

## Global Constraints

- Deployed worker name: `central-auth-broker`, served at `https://broker.jsmunro.me` on zone `jsmunro.me` (zone_name `jsmunro.me`).
- Cloudflare account id: `314e7e015b5f4429c4e2da1e6ec93271`.
- Routing scheme (from design1): `GET/POST /<action>/<provider>` where action is `get-token` or `callback`, provider slug e.g. `github`. Unknown provider → 404 JSON `{"error":"Unsupported provider: <slug>"}`. Unknown action → 404 "Endpoint Not Found".
- Identity: requests must carry `Cf-Access-Jwt-Assertion` header (Cloudflare Access). Missing header → 401 JSON `{"error":"Unauthorized: Cloudflare Access Required"}`. UNLIKE the design snippet (which only base64-decodes), the JWT MUST be cryptographically verified: RS256 signature against the JWKS at `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`, `aud` must contain `ACCESS_AUD`, `iss` must be `https://<ACCESS_TEAM_DOMAIN>`, `exp`/`nbf` checked. Use WebCrypto (`crypto.subtle`) — no npm JWT dependency. Invalid JWT → 403 JSON `{"error":"Invalid Access token"}`. userId = verified payload `email` claim.
- KV binding name: `AUTH_TOKENS`. Storage key format: `refresh:<provider>:<userId>` (verbatim from design).
- Provider plugin interface (design1 Step 1, with the raw Access JWT passed through as design2 requires):
  ```ts
  interface TokenPayload { token: string; expires_in?: number; additional_data?: Record<string, any>; }
  interface AuthProvider {
    slug: string;
    getAuthUrl(env: Env, userId: string): string;
    handleCallback(request: Request, env: Env): Promise<{ refreshToken: string; data: any }>;
    refreshToken(refreshToken: string, env: Env, accessJwt?: string): Promise<TokenPayload & { newRefreshToken?: string }>;
  }
  ```
- Core engine behavior (design1 Step 2 / design2 Step 2):
  - `callback`: provider.handleCallback → KV put refresh token → HTML success page "GITHUB Linked!"-style; failure → 400 text `Callback Failed: <message>`.
  - `get-token`: no stored refresh token → 200 JSON `{"setup_required": true, "url": <getAuthUrl>}`. Otherwise provider.refreshToken; if `newRefreshToken` returned, KV put it; respond 200 JSON `{"token", "expires_in", ...additional_data}`. On refresh error: delete the KV key and return 200 JSON setup_required payload.
  - `scheduled` (cron): list KV keys with prefix `refresh:`, for each parse `refresh:<provider>:<userId>`, call provider.refreshToken, persist `newRefreshToken` if returned; log-and-continue on per-key errors (never delete keys in cron).
- Env interface: `AUTH_TOKENS: KVNamespace`; secrets `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`; vars `BROKER_URL` (= `https://broker.jsmunro.me`), `ACCESS_TEAM_DOMAIN` (= `jsmunro.cloudflareaccess.com`), `ACCESS_AUD` (Access app audience tag, filled at deploy time), `ENVIRONMENT` (= "production"). Do NOT include Slack/AWS env fields yet.
- GitHub provider specifics (the design's GitHub file was never shown — implement from GitHub's documented OAuth endpoints):
  - Credentials are a GitHub App (client_id prefix `Iv23…`) using the web application flow with expiring user tokens.
  - `getAuthUrl`: `https://github.com/login/oauth/authorize?client_id=<id>&redirect_uri=<BROKER_URL>/callback/github&state=<random>` (state generated via `crypto.randomUUID()`; best-effort, not persisted).
  - `handleCallback`: read `code` from query; POST `https://github.com/login/oauth/access_token` with `Accept: application/json`, body `client_id`, `client_secret`, `code`, `redirect_uri`. Response JSON has `access_token`, `refresh_token`, `expires_in`, `refresh_token_expires_in`; an `error` field means failure → throw with GitHub's `error_description` or `error`. Missing `refresh_token` in response → throw (means token expiration is disabled on the GitHub App; the broker requires it).
  - `refreshToken`: POST same endpoint with `grant_type=refresh_token`, `refresh_token`, `client_id`, `client_secret`, `Accept: application/json`. Return `{ token: access_token, expires_in, newRefreshToken: refresh_token }`.
- wrangler config (design2 Step 1, corrected): `wrangler.toml` with name/main/compatibility_date `2026-07-23`, route pattern `broker.jsmunro.me/*` zone_name `jsmunro.me`, kv_namespaces binding `AUTH_TOKENS` (id filled at infra time — leave a clearly marked placeholder `REPLACE_WITH_KV_ID`), `[triggers] crons = ["*/30 * * * *"]`, `[vars]` as above. `workers_dev = false`.
- TypeScript strict; devDependencies only (`wrangler`, `typescript`, `@cloudflare/workers-types`, `vitest`); zero runtime npm dependencies. `npx tsc --noEmit` must pass.
- Tests: vitest unit tests with mocked `fetch` and an in-memory KV stub covering: 401 when header missing, 404 unknown provider, get-token setup_required path, callback happy path stores refresh token, get-token refresh happy path + rotated-refresh-token persistence, refresh failure clears KV and returns setup_required, GitHub provider request/response shape (assert URL, body params, Accept header), cron rotation. JWT verification may be stubbed/injected for router tests but must have its own unit test for claim validation logic (aud/iss/exp) with signature verification mocked or tested via a locally generated RS256 key using WebCrypto.
- Helper script `cf-auth.sh` (design1 Step 4, corrected): bash, `set -euo pipefail`; usage `cf-auth.sh <provider>`; BROKER_URL `https://broker.jsmunro.me`; obtain JWT via `cloudflared access token --app=$BROKER_URL` with `cloudflared access login` fallback; curl `$BROKER_URL/get-token/$PROVIDER` with `Cf-Access-Jwt-Assertion` header; parse with `jq` (require it, fail with message if absent — do NOT use the design's fragile grep parsing); if `.setup_required == true` print the URL and try `xdg-open`/`open`, exit 1; else print raw JSON to stdout. Executable bit set.

## Task 1: Worker implementation (scaffold, core engine, GitHub provider, tests)

Create the complete Cloudflare Worker project in the repo root:

- `package.json` (private, scripts: `deploy`, `dev`, `test` = vitest run, `typecheck` = tsc --noEmit), `tsconfig.json` (strict, types: @cloudflare/workers-types), `wrangler.toml` per Global Constraints, `.gitignore` additions (node_modules, .wrangler, .dev.vars).
- `src/types.ts` — Env, TokenPayload, AuthProvider interfaces per Global Constraints.
- `src/access.ts` — Cloudflare Access JWT verification per Global Constraints (fetch JWKS from `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`, cache keys in a module-level variable with a ~5 min TTL, verify RS256 via crypto.subtle, validate aud/iss/exp/nbf, return the payload). Export a function like `verifyAccessJwt(jwt: string, env: Env): Promise<{ email: string; [k: string]: any }>`.
- `src/providers/github.ts` — GitHubProvider class per Global Constraints.
- `src/index.ts` — core router engine with `fetch` and `scheduled` handlers per Global Constraints. Provider registry: `const providers: Record<string, AuthProvider> = { github: new GitHubProvider() }`. Adding a future provider must require only a new file in `src/providers/` plus one registry line and any Env fields.
- `test/` — vitest tests per Global Constraints. No miniflare/workers-pool needed: unit-test the exported handlers with stub Env (in-memory KV object implementing get/put/delete/list) and globally stubbed fetch via `vi.stubGlobal`.
- Run `npm install`, `npm run typecheck`, `npm test` — all must pass. Commit.

## Task 2: Developer helper script

Create `scripts/cf-auth.sh` per the Global Constraints spec (design1 Step 4, corrected), plus a short `README.md` at repo root documenting: what the broker is, architecture (core engine + provider plugins), endpoints, how to add a new provider (3 bullet steps), deployment (wrangler deploy, secret list), and terminal usage examples including the `auth-github` alias:
`alias auth-github='export GH_TOKEN=$(cf-auth.sh github | jq -r .token)'`.
`bash -n scripts/cf-auth.sh` must pass and the file must be executable. Commit.

## Task 3: Provision infrastructure and deploy (controller-executed)

Executed by the controller directly (needs 1Password access), not a code subagent:

1. Create KV namespace `central-auth-broker-AUTH_TOKENS`; patch its id into wrangler.toml.
2. Create DNS AAAA record `broker.jsmunro.me` → `100::`, proxied.
3. Create Access self-hosted app "broker.jsmunro.me" for domain `broker.jsmunro.me` with allow policy for `jack@jsmunro.me` (mirror the dashboard.jsmunro.me app config); capture its `aud` tag; set `ACCESS_AUD` var in wrangler.toml.
4. `CLOUDFLARE_API_TOKEN=$(op read …) npx wrangler deploy`.
5. Pipe secrets from op item `github sso org app cred/id broker` (vault Services) into `wrangler secret put GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.
6. Verify: unauthenticated curl to `https://broker.jsmunro.me/get-token/github` should hit the Access wall (302 to login), confirming Access is in front. Commit wrangler.toml changes.
7. Report the GitHub App callback URL that must be configured: `https://broker.jsmunro.me/callback/github`.
