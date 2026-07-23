# central-auth-broker

A modular, extensible SaaS-token broker that runs as a single Cloudflare Worker
behind Cloudflare Access. It centralizes OAuth token acquisition and refresh
for third-party providers (GitHub, Cloudflare) so that terminal tools and scripts
can fetch a short-lived, always-fresh access token with one authenticated
HTTP call instead of each holding their own OAuth client secrets.

## Phase-1 access model

`apps/manifest.json` is the single source of truth for app registration,
Access groups, and access policy — both the Worker (`src/registry.ts`) and
Terraform (`infra/`) build off it, so they can never drift out of sync.

- **Manifest-driven registry**: each entry in `manifest.apps[]` carries its
  OAuth config, declared `scopes`, and `access` (allowed groups, whether it
  gets a service token, optional per-app `session_duration`). Adding an app
  is a manifest edit plus a `describeLink` wiring in `src/registry.ts` (see
  "Adding a new app registration" below), not a code-and-Terraform rewrite.
- **Per-app Access apps, not one shared app**: Terraform creates, per slug, a
  **token app** scoped to `broker.jsmunro.me/get-token/<slug>(/*)` and a
  separate, stricter **linking app** scoped to `.../callback/<slug>(/*)`
  (the linking app additionally enforces `link_policy`, e.g. `require_warp`).
  The root app (`broker.jsmunro.me`) still gates the dashboard and `/api/*`
  routes only.
- **Groups from the manifest**: `manifest.groups` compiles to Cloudflare
  Access Groups (email lists, GitHub-team/org rules, or — once activated —
  Okta group rules); each app's `access.allow_groups` references group names,
  never raw rules.
- **Strict per-app AUD enforcement**: the Worker validates the Access JWT's
  `aud` against `ACCESS_APP_AUDS[<slug>].token` for `/get-token/<slug>` and
  `.link` for `/callback/<slug>` — no fallback to the root AUD for a
  registered slug. A slug present in the manifest but missing from
  `ACCESS_APP_AUDS` fails closed (`403`) rather than silently accepting the
  root app's token. `ACCESS_APP_AUDS` is populated from Terraform's
  `app_auds` output by `infra/sync-auds.sh` — see `infra/README.md` for the
  full apply/sync runbook; **apply order is mandatory: `terraform apply` →
  `sync-auds.sh` → `wrangler deploy`**, since a deploy with a stale
  `ACCESS_APP_AUDS` will fail-closed every per-app route.
- **Per-app service tokens**: apps with `access.service_token: true` (e.g.
  the GitHub app) get a Cloudflare Access service token via Terraform,
  usable by non-interactive/machine callers (see "Machine / service-token
  usage" below).

## Architecture

The worker is split into a small **core engine** and a registry of
**app registrations**, each built from a **provider factory**:

- `src/index.ts` — the core engine: request routing (joining all path
  segments after the action into the slug), Cloudflare Access JWT
  enforcement, KV-backed refresh-token storage, and the `scheduled` (cron)
  handler that proactively refreshes tokens and stale metadata in the
  background.
- `src/access.ts` — verifies the `Cf-Access-Jwt-Assertion` header
  cryptographically (RS256 against the Access team's JWKS), checking `aud`,
  `iss`, `exp`, and `nbf`. No request is ever trusted purely on the presence
  of the header.
- `src/types.ts` — shared `Env`, `AuthProvider`, `AppConfig`, `AppAuthConfig`,
  and `AppMetadata` interfaces.
- `src/oauth2.ts` — `oauth2Provider(config)`, a factory that builds an
  `AuthProvider` for a standard OAuth2 authorization-code flow (used by both
  current registrations); `src/appauth.ts` — app-level metadata fetching
  (`fetchAppMetadata` / `getCachedAppMetadata`), currently supporting the
  `github-app-jwt` kind.
- `src/registry.ts` — **the single source of truth**: `appConfigs` (every
  `AppConfig`, keyed by slug) and `apps` (the `AuthProvider`s derived from
  it, keyed by slug). The engine and dashboard import only from here — there
  is no separate per-provider module list to keep in sync.
- `src/dashboard.ts` — the dashboard page and `/api/me`, `/api/links`,
  `/api/apps` JSON endpoints.

Every `AuthProvider` implements:

```ts
interface AuthProvider {
  slug: string;
  getAuthUrl(env: Env, userId: string): string;
  handleCallback(request: Request, env: Env): Promise<{ refreshToken: string; data: any }>;
  refreshToken(refreshToken: string, env: Env, accessJwt?: string): Promise<TokenPayload & { newRefreshToken?: string }>;
  describeLink?(token: string, env: Env): Promise<Record<string, string>>;
}
```

The core engine never contains provider-specific logic — it only calls
through this interface and persists whatever refresh token the provider
hands back, keyed as `refresh:<slug>:<userId>` in the `AUTH_TOKENS` KV
namespace (`slug` is the full 3-part app slug below; `userId` is the
verified Access JWT `email` claim).

## App addressing

Every registered app — a specific OAuth client for a specific provider,
scoped to a specific org/account — is addressed by a 3-part slug:

```
<provider>/<org>/<clientid>
```

- `provider`: the plugin, e.g. `github`, `cloudflare`.
- `org`: the provider-side namespace the OAuth client lives under (a GitHub
  owner login, e.g. `jsmunro`; a Cloudflare account name, e.g. `jackm`).
- `clientid`: the OAuth client id verbatim.

The two currently-registered apps:

| Slug | Display name |
| --- | --- |
| `github/jsmunro/Iv23lifj0i4aV6qYR76i` | Brokers repo |
| `cloudflare/jackm/9f2c965eeb2fcc390fc3843935de35bc` | central-auth-broker |

The slug is the routing key, the KV key component, and the identifier
returned by `/api/apps` — there is no shorter "provider-only" form; all
three segments are always required.

## Endpoints

Deployed at `https://broker.jsmunro.me` (Worker name `central-auth-broker`,
zone `jsmunro.me`). Every request must pass Cloudflare Access: non-browser
clients authenticate to the Access edge with a `cf-access-token: <jwt>` header
(the JWT from `cloudflared access token`) or a
`CF-Access-Client-Id`/`CF-Access-Client-Secret` service-token pair; Access
then injects the `Cf-Access-Jwt-Assertion` header that the worker verifies.
Requests reaching the worker without a valid assertion get `401`/`403` JSON
errors. Per the phase-1 access model above, the JWT presented to
`/get-token/<slug>` and `/callback/<slug>` must carry that specific slug's
token/link AUD (see `ACCESS_APP_AUDS`) — a JWT scoped only to the root app is
rejected on these routes even though it is accepted on `/api/*` and the
dashboard.

- `GET /get-token/<slug>` — returns `{"token": ..., "expires_in": ...}`
  for the caller's stored token, refreshing it first if necessary. If no
  token has ever been linked for this user/app, returns
  `{"setup_required": true, "url": "<oauth authorize url>"}` instead.
  `<slug>` is the full 3-part `<provider>/<org>/<clientid>`, e.g.
  `/get-token/github/jsmunro/Iv23lifj0i4aV6qYR76i`.
- `GET /callback/<slug>` — the OAuth redirect target used during the
  one-time linking flow. Exchanges the `code` for tokens and stores the
  refresh token in KV. Returns an HTML success page on success, or
  `400 Callback Failed: <message>` on failure.
- `GET /api/apps` — (Access-authed like all `/api` routes) returns an array
  of every registered app: `{ slug, provider, org, client_id, display_name,
  metadata? }`. `display_name` is the code-configured fallback name;
  `metadata` (when present) is the curated app metadata fetched from the
  provider via `appAuth` and cached in KV (see "App metadata" below) —
  `metadata.name`, if set, is the preferred display name. This is the
  source of truth for name→slug resolution used by `cf-auth.sh` and the
  dashboard.

Unknown slugs return `404 {"error": "Unsupported provider: <slug>"}`
(two-segment or partial slugs are not recognized — the full 3-part slug is
required); unknown actions return `404 Endpoint Not Found`.

A cron trigger (`*/30 * * * *`) runs the `scheduled` handler, which walks
every `refresh:*` key in KV and proactively refreshes tokens in the
background so they stay valid between calls (failures are logged and
skipped, never deleted, so a link is never silently lost). The same run
also refreshes any stale (>24h) cached app metadata, best-effort.

## App metadata

An app registration can optionally declare `appAuth` — app-level
credentials (separate from the per-user OAuth2 flow) used to fetch curated
metadata about the app itself from the provider (name, description, owner,
permissions, etc.). Today there is one kind, `github-app-jwt`: it builds an
RS256 JWT (via WebCrypto, from the GitHub App id and a PKCS#8 PEM private
key) and calls `GET https://api.github.com/app`. Metadata is cached in KV
under `app:<slug>` and refreshed by the cron trigger when older than 24h;
failures are logged and the stale cache is kept. Apps without `appAuth`
(e.g. the Cloudflare app) simply have no `metadata` field and fall back to
`display_name` everywhere.

## Adding a new app registration

1. Register the OAuth client (or GitHub App) on the provider side, and set
   its callback/redirect URL to `https://broker.jsmunro.me/callback/<slug>`
   using the slug you're about to assign it, e.g.
   `https://broker.jsmunro.me/callback/github/jsmunro/some-client-id`.
2. For a standard OAuth2 authorization-code flow, build the `AuthProvider`
   with the `oauth2Provider(...)` factory in `src/oauth2.ts` (see the
   example below). Only for a genuinely non-standard flow, hand-write a
   module implementing the `AuthProvider` interface from `src/types.ts`
   directly (`slug`, `getAuthUrl`, `handleCallback`, `refreshToken`,
   optional `describeLink`).
3. Add an `AppConfig` entry to `appConfigs` in `src/registry.ts`:
   ```ts
   const MY_APP_SLUG = "myprovider/myorg/myclientid";

   [MY_APP_SLUG]: {
     slug: MY_APP_SLUG,
     displayName: "My App",
     provider: oauth2Provider({
       slug: MY_APP_SLUG,
       authorizeUrl: "...",
       tokenUrl: "...",
       clientIdVar: "MYPROVIDER_CLIENT_ID",
       clientSecretVar: "MYPROVIDER_CLIENT_SECRET",
       clientAuth: "body", // or "basic"
     }),
     // Optional — only if the provider supports app-level metadata auth:
     // appAuth: { kind: "github-app-jwt", appIdVar: "MY_APP_ID", privateKeyVar: "MY_APP_PRIVATE_KEY" },
   },
   ```
   `apps` (the routing/`AuthProvider` map keyed by slug, used by the engine)
   is derived automatically from `appConfigs` — there's nothing else to
   register.
4. Add the new env vars referenced above (client id/secret, and app-auth
   vars if used) to the `Env` interface in `src/types.ts`, then push their
   values via `wrangler secret put`:
   ```bash
   npx wrangler secret put MYPROVIDER_CLIENT_ID
   npx wrangler secret put MYPROVIDER_CLIENT_SECRET
   ```
5. Write vitest unit tests under `test/` mirroring the existing provider
   tests (auth URL shape, callback exchange, refresh exchange, error paths).

## Deployment

```bash
npm install
npx tsc --noEmit          # typecheck
npm test                  # vitest unit tests

# one-time secrets (GitHub App credentials)
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET

# one-time secrets (GitHub App-level auth, for /api/apps metadata)
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY   # PKCS#8 PEM

# one-time secrets (Cloudflare OAuth client credentials)
npx wrangler secret put CLOUDFLARE_OAUTH_CLIENT_ID
npx wrangler secret put CLOUDFLARE_OAUTH_CLIENT_SECRET

# confirm what's configured
npx wrangler secret list

npm run deploy             # wrangler deploy
```

`wrangler.toml` configures the route (`broker.jsmunro.me/*` on zone
`jsmunro.me`), the `AUTH_TOKENS` KV binding, the `*/30 * * * *` cron trigger,
and the non-secret vars `BROKER_URL`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`,
`ACCESS_APP_AUDS`, and `ENVIRONMENT`. The KV namespace id and `ACCESS_AUD`
(the root Access application's audience tag) are environment-specific and
must be filled in at infrastructure setup time (see the `REPLACE_WITH_*`
placeholders in `wrangler.toml`). `ACCESS_APP_AUDS` (the per-slug token/link
audience map — see "Phase-1 access model" above) is committed as the
placeholder `"{}"` and is **not** hand-edited: it's generated from
Terraform's `app_auds` output by `infra/sync-auds.sh`, run after every
`terraform apply` and before the next `wrangler deploy`.

### Infrastructure (Terraform)

`infra/` holds the Terraform that provisions the per-app Access
applications, groups, service tokens, and DNS/KV resources described above,
all compiled from `apps/manifest.json`. See **`infra/README.md`** for the
full bootstrap → import → `plan`/`apply` → `sync-auds.sh` runbook — the
apply/sync/deploy ordering there is mandatory, not just recommended, because
a Worker deploy with a stale `ACCESS_APP_AUDS` fails closed on every per-app
route.

## Terminal usage

`scripts/cf-auth.sh` is a small helper for fetching a token from your shell.
It authenticates via Cloudflare Access, calls `GET /get-token/<slug>`, and
prints the resulting JSON — or, if the app hasn't been linked yet,
prints/opens the linking URL and exits non-zero. Non-2xx responses from
either broker call print a friendly message to stderr (which URL failed,
and to check your Access login) and exit non-zero; stdout is always either
clean token JSON or nothing.

```bash
./scripts/cf-auth.sh <app-name-or-slug>
```

The argument can be:

- a full 3-part slug, used verbatim (recognized because it contains `/`):
  ```bash
  ./scripts/cf-auth.sh github/jsmunro/Iv23lifj0i4aV6qYR76i
  ```
- a friendly name, resolved via `GET /api/apps` against each registered
  app's `display_name` or `metadata.name`, case-insensitively, with `-` and
  space treated as equivalent (so `brokers-repo` matches "Brokers repo"):
  ```bash
  ./scripts/cf-auth.sh brokers-repo
  ./scripts/cf-auth.sh central-auth-broker
  ```
  If the name matches zero or more than one registered app, the script
  prints the candidate slugs and display names to stderr and exits 1 —
  stdout is always either clean token JSON or nothing.

Under the hood, since each app now has its own Access AUD (see "Phase-1
access model" above), the script uses two different `cloudflared` tokens: it
authenticates against the *root* app (`$BROKER_URL`) only to resolve a
friendly name via `GET /api/apps`, then authenticates separately against
that specific app's *token app* (`$BROKER_URL/get-token/<slug>`) for the
actual `GET /get-token/<slug>` call — `cloudflared access login` runs again,
scoped to the per-app URL, the first time you use a given app if there's no
cached token for it yet.

Add it to your `PATH` and set up convenience aliases to pull just the token
straight into an environment variable, e.g. for use with the `gh` CLI or
other tools that read `GH_TOKEN`:

```bash
alias auth-github='export GH_TOKEN=$(cf-auth.sh brokers-repo | jq -r .token)'
```

For Cloudflare, the brokered token is a Bearer token usable directly against
`api.cloudflare.com`:

```bash
export CLOUDFLARE_API_TOKEN=$(scripts/cf-auth.sh central-auth-broker | jq -r .token)
```

### Machine / service-token usage

For non-interactive callers (CI, servers) that can't run `cloudflared
access login`, set both `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`
to a per-app Access **service token** (Terraform-provisioned for any
manifest app with `access.service_token: true`, e.g. the GitHub app — see
`infra/README.md` for retrieving the value from Terraform output). When both
are set, `cf-auth.sh` skips `cloudflared` entirely and authenticates with the
`CF-Access-Client-Id`/`CF-Access-Client-Secret` headers instead:

```bash
export CF_ACCESS_CLIENT_ID=...
export CF_ACCESS_CLIENT_SECRET=...
export GH_TOKEN=$(./scripts/cf-auth.sh github/jsmunro/Iv23lifj0i4aV6qYR76i | jq -r .token)
```

In this mode the argument **must** be a full 3-part slug — friendly-name
resolution is unavailable, because it goes through `GET /api/apps`, which is
gated by the *root* app's Access policy, and a per-app service token is only
a member of that specific app's policy, not the root's.

The Cloudflare provider uses a confidential OAuth client
(`client_secret_post`, no PKCE), configured via the `CLOUDFLARE_OAUTH_CLIENT_ID`
and `CLOUDFLARE_OAUTH_CLIENT_SECRET` secrets. Cloudflare does not default to
the OAuth client's registered scopes — scopes must be requested explicitly on
every authorize request via the `scope` parameter, populated from the
`CLOUDFLARE_OAUTH_SCOPES` var in `wrangler.toml` (a space-separated list,
including `offline_access`, which is required for refresh tokens). This list
must be a subset of the scopes granted to the OAuth client at registration.

Requires `jq` on `PATH` always, and `cloudflared` on `PATH` in the default
(human) mode — not needed in service-token mode; the script fails fast with
a clear message if a required tool is missing.
