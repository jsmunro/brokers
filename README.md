# central-auth-broker

A modular, extensible SaaS-token broker that runs as a single Cloudflare Worker
behind Cloudflare Access. It centralizes OAuth token acquisition and refresh
for third-party providers (GitHub, Cloudflare) so that terminal tools and scripts
can fetch a short-lived, always-fresh access token with one authenticated
HTTP call instead of each holding their own OAuth client secrets.

## Architecture

The worker is split into a small **core engine** and a registry of
**provider plugins**:

- `src/index.ts` — the core engine: request routing, Cloudflare Access JWT
  enforcement, KV-backed refresh-token storage, and the `scheduled` (cron)
  handler that proactively refreshes tokens in the background.
- `src/access.ts` — verifies the `Cf-Access-Jwt-Assertion` header
  cryptographically (RS256 against the Access team's JWKS), checking `aud`,
  `iss`, `exp`, and `nbf`. No request is ever trusted purely on the presence
  of the header.
- `src/types.ts` — shared `Env` and `AuthProvider` interfaces that every
  provider plugin implements.
- `src/providers/github.ts` — the GitHub provider plugin (GitHub App, web
  application flow, expiring user tokens).
- `src/providers/cloudflare.ts` — the Cloudflare provider plugin (confidential
  OAuth client, `client_secret_post`, brokered tokens are Cloudflare API
  bearer tokens usable against `api.cloudflare.com`).

Each provider is a self-contained module implementing:

```ts
interface AuthProvider {
  slug: string;
  getAuthUrl(env: Env, userId: string): string;
  handleCallback(request: Request, env: Env): Promise<{ refreshToken: string; data: any }>;
  refreshToken(refreshToken: string, env: Env, accessJwt?: string): Promise<TokenPayload & { newRefreshToken?: string }>;
}
```

The core engine never contains provider-specific logic — it only calls
through this interface and persists whatever refresh token the provider
hands back, keyed as `refresh:<provider>:<userId>` in the `AUTH_TOKENS` KV
namespace (`userId` is the verified Access JWT `email` claim).

## Endpoints

Deployed at `https://broker.jsmunro.me` (Worker name `central-auth-broker`,
zone `jsmunro.me`). Every request must pass Cloudflare Access: non-browser
clients authenticate to the Access edge with a `cf-access-token: <jwt>` header
(the JWT from `cloudflared access token`); Access then injects the
`Cf-Access-Jwt-Assertion` header that the worker verifies. Requests reaching
the worker without a valid assertion get `401`/`403` JSON errors.

- `GET /get-token/<provider>` — returns `{"token": ..., "expires_in": ...}`
  for the caller's stored token, refreshing it first if necessary. If no
  token has ever been linked for this user/provider, returns
  `{"setup_required": true, "url": "<oauth authorize url>"}` instead.
- `GET /callback/<provider>` — the OAuth redirect target used during the
  one-time linking flow. Exchanges the `code` for tokens and stores the
  refresh token in KV. Returns an HTML success page on success, or
  `400 Callback Failed: <message>` on failure.

Unknown provider slugs return `404 {"error": "Unsupported provider: <slug>"}`;
unknown actions return `404 Endpoint Not Found`.

A cron trigger (`*/30 * * * *`) runs the `scheduled` handler, which walks
every `refresh:*` key in KV and proactively refreshes tokens in the
background so they stay valid between calls (failures are logged and
skipped, never deleted, so a link is never silently lost).

## Adding a new provider

1. Create `src/providers/<provider>.ts` implementing the `AuthProvider`
   interface from `src/types.ts` (`slug`, `getAuthUrl`, `handleCallback`,
   `refreshToken`).
2. Register it in the `providers` map in `src/index.ts` (e.g.
   `<provider>: new <Provider>Provider()`), and add its slug-specific
   secrets (client id/secret) to `Env` in `src/types.ts`.
3. Add the provider's OAuth `client_id`/`client_secret` via
   `wrangler secret put`, and write vitest unit tests under `test/`
   mirroring `test/github.test.ts` (auth URL shape, callback exchange,
   refresh exchange, error paths).

## Deployment

```bash
npm install
npx tsc --noEmit          # typecheck
npm test                  # vitest unit tests

# one-time secrets (GitHub App credentials)
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET

# one-time secrets (Cloudflare OAuth client credentials)
npx wrangler secret put CLOUDFLARE_OAUTH_CLIENT_ID
npx wrangler secret put CLOUDFLARE_OAUTH_CLIENT_SECRET

# confirm what's configured
npx wrangler secret list

npm run deploy             # wrangler deploy
```

`wrangler.toml` configures the route (`broker.jsmunro.me/*` on zone
`jsmunro.me`), the `AUTH_TOKENS` KV binding, the `*/30 * * * *` cron trigger,
and the non-secret vars `BROKER_URL`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and
`ENVIRONMENT`. The KV namespace id and `ACCESS_AUD` (the Access application's
audience tag) are environment-specific and must be filled in at
infrastructure setup time (see the `REPLACE_WITH_*` placeholders in
`wrangler.toml`).

## Terminal usage

`scripts/cf-auth.sh` is a small helper for fetching a token from your shell.
It authenticates via `cloudflared` (Cloudflare Access), calls
`GET /get-token/<provider>`, and prints the resulting JSON — or, if the
provider hasn't been linked yet, prints/opens the linking URL and exits
non-zero.

```bash
./scripts/cf-auth.sh github
```

Add it to your `PATH` and set up a convenience alias to pull just the token
straight into an environment variable, e.g. for use with the `gh` CLI or
other tools that read `GH_TOKEN`:

```bash
alias auth-github='export GH_TOKEN=$(cf-auth.sh github | jq -r .token)'
```

For Cloudflare, the brokered token is a Bearer token usable directly against
`api.cloudflare.com`:

```bash
export CLOUDFLARE_API_TOKEN=$(scripts/cf-auth.sh cloudflare | jq -r .token)
```

The Cloudflare provider uses a confidential OAuth client
(`client_secret_post`, no PKCE), configured via the `CLOUDFLARE_OAUTH_CLIENT_ID`
and `CLOUDFLARE_OAUTH_CLIENT_SECRET` secrets. Scopes are not requested per
authorize-request — they're fixed at the OAuth client's registration (107
scopes, including `offline_access`, which is required for refresh tokens).

Requires `jq` and `cloudflared` on `PATH`; the script fails fast with a
clear message if either is missing.
