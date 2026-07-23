# Broker Web Dashboard — Design

2026-07-23. Approved approach: UI inside the existing `central-auth-broker` worker (Approach A).

## Goal

An Access-authenticated web page at `https://broker.jsmunro.me/` where a user can see their Cloudflare Access identity, see which providers they have linked (with per-link details such as the GitHub login), link new providers via the browser OAuth flow, and unlink existing ones. The CLI (`cf-auth.sh`) is unchanged and benefits automatically: once linked via the web, `get-token` just works.

## Routes (all served by the existing worker, behind the existing Access app)

Auth for every new route uses the existing `verifyAccessJwt` path — the browser's Access cookie causes Access to inject `Cf-Access-Jwt-Assertion` exactly as for the CLI. Missing header → 401 JSON, invalid → 403 JSON (same shapes as today).

- `GET /` — server-rendered HTML dashboard (Content-Type text/html). Replaces the previous 404 for the root path.
- `GET /api/me` — `{ email, name?, idp?, exp }` from the verified JWT claims (include `name`/custom claims only when present; `exp` is the JWT expiry unix timestamp).
- `GET /api/links` — array over the provider registry, one entry per provider:
  `{ slug, linked: boolean, linked_at?: string, last_refreshed?: string, details?: Record<string,string>, auth_url?: string }`
  `auth_url` present only when `linked` is false. Timestamps ISO-8601.
- `DELETE /api/links/<provider>` — deletes `refresh:<provider>:<userId>` and `meta:<provider>:<userId>`; returns `{ ok: true }`. Unknown provider slug → existing 404 shape.
- Existing routes (`get-token`, `callback`) unchanged in behavior, except `callback` additionally writes link metadata (below) and its success HTML links back to `/`.

## Link metadata

- `AuthProvider` gains an OPTIONAL method: `describeLink?(token: string, env: Env): Promise<Record<string, string>>`. Existing providers compile unchanged if they omit it; both current providers implement it:
  - GitHub: `GET https://api.github.com/user` with `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, and a `User-Agent` header (GitHub requires one) → `{ login, name, id }` (stringified, omit null fields).
  - Cloudflare: `GET https://dash.cloudflare.com/oauth2/userinfo` with `Authorization: Bearer <token>` → flatten string/number claims (e.g. `{ email, sub }`).
- New KV key: `meta:<provider>:<userId>` → JSON `{ linked_at: string, last_refreshed?: string, details?: Record<string,string> }`.
- Engine behavior:
  - `callback` success: after storing the refresh token, call `describeLink` with the access token already present in the callback exchange response (`data.access_token`; both providers return one — skip describeLink if absent), best-effort — any failure is logged and never fails the link; write the meta key with `linked_at` = now and whatever details were obtained.
  - `get-token` and cron refresh success: update `last_refreshed` in the meta key (create it if absent, preserving existing fields). Meta write failures never fail the token response.
  - Unlink and the existing refresh-failure cleanup in `get-token` delete BOTH keys.
- Backward compatibility: links created before this feature have no meta key — they render as linked with no details until the next refresh creates one.

## Page

Single HTML template rendered server-side with a small inline `<script>` and inline CSS. No framework, no build step, zero runtime npm deps preserved.

- Identity card: email, Access session expiry (from `/api/me`).
- One card per provider (from `/api/links`): linked state badge, details rows (e.g. GitHub `login`/`name`), `linked_at` / `last_refreshed`, and either a **Link** button (navigates to `auth_url`) or an **Unlink** button (JS `confirm()`, then `DELETE`, then re-fetch and re-render).
- The page fetches `/api/me` and `/api/links` on load via `fetch` (same-origin, cookie auth).
- Styling: minimal-clean, dark-mode friendly (`prefers-color-scheme`), no external assets.

## Structure

- `src/dashboard.ts` — new module: `renderDashboard(): Response` (HTML) and API handlers `handleMe(payload)`, `handleLinks(env, userId, providers)`, `handleUnlink(env, userId, providerSlug)`. `index.ts` gains only routing lines and the meta-write hooks.
- `src/types.ts` — optional `describeLink` on `AuthProvider`; a `LinkMeta` interface.
- Providers gain their `describeLink` implementations.

## Testing

`test/dashboard.test.ts` plus small additions to existing files, same stubs (in-memory KV, stubbed fetch, stubbed/verified JWT):

- `GET /` authed → 200 HTML; unauthenticated → 401; bad JWT → 403.
- `/api/me` reflects JWT claims (email, exp; name only when present).
- `/api/links`: unlinked provider has `auth_url` and `linked:false`; linked with meta shows details/timestamps; linked without meta shows `linked:true` with no details.
- `DELETE /api/links/github` removes both KV keys; unknown provider → 404 shape.
- `describeLink` request shape per provider (URL, Authorization, User-Agent for GitHub).
- Callback writes meta with details; callback still succeeds when `describeLink` throws; refresh paths update `last_refreshed`.
- Existing tests must stay green (engine behavior for CLI routes unchanged).

## Out of scope

Multi-account admin views, token display/copy in the UI, force-refresh button, re-link-overwrite (unlink + link covers it), audit history.
