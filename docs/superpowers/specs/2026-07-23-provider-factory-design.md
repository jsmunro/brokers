# Declarative Provider Factory + Multi-Registration — Design

2026-07-23. Approved: Option A (internal declarative factory, no published SDK), named-alias instance addressing. Branch: `feature/provider-factory`.

## Goals

1. A new standard-OAuth2 provider registration becomes a ~25-line declarative config + one registry line — no new request/error/rotation logic.
2. A provider may have multiple app registrations (instances), addressed as `<provider>/<alias>`.
3. Zero behavior change for existing links, CLI usage, and dashboard (bare `github`/`cloudflare` remain valid slugs).

## Instance model

- An instance slug is either `provider` (default instance) or `provider/alias`; `provider` and `alias` each match `[a-z0-9-]+`. The slug is the key everywhere: routes, KV keys, dashboard, cf-auth.sh argument.
- Routes: `/get-token/<provider>[/<alias>]` and `/callback/<provider>[/<alias>]` — i.e. 2 or 3 path segments; the engine joins segments after the action with `/` to form the slug and looks it up in the registry. Unknown slug → existing 404 shape (message contains the full slug). Likewise `DELETE /api/links/<provider>[/<alias>]` — the dashboard unlink handler receives the joined slug; add a router test for the 3-segment form.
- KV keys unchanged in format: `refresh:<slug>:<userId>` and `meta:<slug>:<userId>`. Slugs contain no `:`, so existing `key.split(":")` parsing (cron) still works; existing keys ARE the default-instance keys — no migration.
- `redirect_uri` for OAuth configs is `${BROKER_URL}/callback/<slug>` — each instance's app registration must list its own callback URL.

## New module: `src/registry.ts`

- Exports `providers: Record<string, AuthProvider>` (moved from `index.ts`), keyed by slug (e.g. `"github"`, `"cloudflare"`, later `"github/work"`).
- `index.ts` and `dashboard.ts` both import it. This removes the dashboard's duplicated skeleton slug list (existing follow-up M-B) — `renderDashboardPage()` derives slugs from the registry via a parameter or direct import (implementer's choice, but ONE source of truth).

## New module: `src/oauth2.ts` — the factory

```ts
export interface OAuth2Config {
  slug: string;                       // full instance slug, e.g. "github" or "github/work"
  authorizeUrl: string;
  tokenUrl: string;
  clientIdVar: string;                // Env var NAME holding client id, e.g. "GITHUB_CLIENT_ID"
  clientSecretVar: string;            // Env var NAME holding client secret
  clientAuth: "body" | "basic";      // secret in form body vs Authorization: Basic
  authorizeParams?: (env: Env) => Record<string, string>; // extra authorize params (e.g. scope)
  tokenParams?: Record<string, string>;                    // extra static token-request params
  extractTokens?: (json: any) => { accessToken: string; refreshToken?: string; expiresIn?: number };
                                      // default: json.access_token / refresh_token / expires_in
  requireRefreshToken?: boolean;      // default true: callback throws if no refresh token extracted
  describeLink?: (token: string, env: Env) => Promise<Record<string, string>>;
}
export function oauth2Provider(config: OAuth2Config): AuthProvider;
```

Factory behavior (all identical to today's hand-written providers):
- `getAuthUrl`: authorizeUrl + `client_id` (from env via clientIdVar), `redirect_uri` = `${env.BROKER_URL}/callback/<slug>`, `response_type=code`, `state=crypto.randomUUID()`, plus `authorizeParams(env)` entries.
- `handleCallback`: require `code` query param; POST tokenUrl, `Content-Type: application/x-www-form-urlencoded`, `Accept: application/json`; body: `grant_type=authorization_code`, `code`, `redirect_uri`, plus `tokenParams`; credentials per `clientAuth` (`body`: client_id+client_secret in form; `basic`: `Authorization: Basic base64(id:secret)` and client_id NOT in body). Non-2xx or `error` field → throw `error_description || error || "…(status)"`. Apply `extractTokens`; missing refresh token with `requireRefreshToken` → throw. Return `{ refreshToken, data: json }` where `data.access_token` remains reachable for the engine's describeLink hook (if `extractTokens` renames, the factory re-attaches `access_token` onto the returned data).
- `refreshToken`: same POST with `grant_type=refresh_token`, `refresh_token`; same auth/error rules; returns `{ token, expires_in, newRefreshToken }` with `newRefreshToken` only when the response contains one.
- `describeLink` passed through when configured.

## Migration of existing providers

- `src/providers/github.ts` and `src/providers/cloudflare.ts` become config files calling `oauth2Provider(...)` (github: clientAuth "body", no scope param, requireRefreshToken true, existing describeLink; cloudflare: clientAuth "body", authorizeParams adds `scope: env.CLOUDFLARE_OAUTH_SCOPES`, existing describeLink). Their env var names, request shapes, and error messages must remain byte-compatible with today (existing tests are the oracle and must pass unmodified EXCEPT for imports/construction — assertions unchanged).
- `Env` gains an index signature `[key: string]: unknown;`? NO — keep Env explicit; the factory resolves vars via `(env as Record<string, unknown>)[config.clientIdVar]` with a runtime check that throws a clear error if missing/not a string. New instances add their named fields to `Env` as before.

## Contract test helper

- `test/contract.ts` exports `providerContractTests(name: string, factory: () => AuthProvider, opts: { env: Env; authorizeHost: string; tokenUrl: string; })` — a `describe` block asserting the invariants for any provider: authorize URL host + `client_id`/`redirect_uri`/`response_type`/`state` present; callback happy path returns refreshToken; callback error response throws; refresh happy path returns token; refresh error throws; rotation passthrough. GitHub and Cloudflare test files invoke it and keep only their provider-specific assertions (header quirks, scope param, nesting).

## Out of scope (explicitly)

- No published npm package. No OIDC-exchange factory (AWS/STS) yet — the `AuthProvider` interface already accommodates it later. No new real provider instances in this change (the factory refactor is validated by byte-compatibility of the existing two). No cf-auth.sh changes beyond usage text mentioning `provider[/alias]` (slug passes through the URL path already). Dashboard changes limited to registry import (skeleton list de-duplication) — instance cards render automatically since they're registry entries.

## Testing bar

`npx tsc --noEmit` clean; full vitest suite green with existing provider/engine/dashboard assertions unmodified; contract suite runs for both providers; new router tests for 3-segment slugs: `/get-token/github/work` with a stub registry entry resolves; unknown alias → 404 with full slug in message; `/callback/github/work` routes to the instance.
