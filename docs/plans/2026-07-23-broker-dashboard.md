# Broker Web Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Access-authenticated dashboard at `https://broker.jsmunro.me/` showing CF identity, linked/available providers with per-link details, with web-based link and unlink.

**Architecture:** New `src/dashboard.ts` module (HTML render + JSON API handlers) wired into the existing router; optional `describeLink` on `AuthProvider`; new `meta:<provider>:<userId>` KV key holding `linked_at`/`last_refreshed`/`details`, written by the callback and refresh paths.

**Tech Stack:** Existing stack only — Cloudflare Worker TypeScript (strict), vitest with stubbed fetch + in-memory KV, zero runtime npm deps, no build step for the page (inline HTML/CSS/JS string).

## Global Constraints

- Spec is `docs/superpowers/specs/2026-07-23-broker-dashboard-design.md` — binding; read it before implementing. Its route shapes, KV formats, and test list are requirements, verbatim.
- Existing behavior of `get-token` and `callback` responses for the CLI MUST NOT change (all existing tests stay green), except: callback success HTML additionally contains a link back to `/`, and callback/refresh additionally maintain the meta key.
- Auth on every new route reuses the existing header check + `verifyAccessJwt` with identical 401/403 JSON shapes as current routes. Auth precedes all routing decisions (established invariant).
- KV meta key: `meta:<provider>:<userId>`, JSON `{ linked_at: string, last_refreshed?: string, details?: Record<string,string> }`, ISO-8601 timestamps via `new Date().toISOString()`.
- New interfaces (exact):
  ```ts
  // types.ts additions
  export interface LinkMeta { linked_at: string; last_refreshed?: string; details?: Record<string, string>; }
  // on AuthProvider:
  describeLink?(token: string, env: Env): Promise<Record<string, string>>;
  ```
- `/api/links` entry shape (exact): `{ slug: string, linked: boolean, linked_at?: string, last_refreshed?: string, details?: Record<string,string>, auth_url?: string }` — `auth_url` only when `linked === false`.
- `/api/me` shape: `{ email: string, exp?: number, name?: string, idp?: string }` — optional fields only when present in the verified JWT payload (`idp` from payload `idp.type` if present).
- Meta writes are ALWAYS best-effort: wrap in try/catch, `console.error` on failure, never fail the user-facing response. `describeLink` failures likewise.
- All new response bodies JSON except `GET /` (text/html). `DELETE /api/links/<provider>` → `{ ok: true }`; unknown slug → existing 404 `{"error":"Unsupported provider: <slug>"}` shape.
- Page: single HTML string, inline CSS with `prefers-color-scheme: dark` support, inline `<script>` using `fetch('/api/me')`, `fetch('/api/links')`, `fetch('/api/links/'+slug, {method:'DELETE'})` after `confirm()`. Link button = plain `<a>` to `auth_url`. No external assets, no framework.
- Verification bar per task: `npx tsc --noEmit` clean AND `npx vitest run` fully green before commit. Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Link metadata layer (types, describeLink, engine hooks)

**Files:**
- Modify: `src/types.ts` (add `LinkMeta`, optional `describeLink` to `AuthProvider`)
- Modify: `src/providers/github.ts`, `src/providers/cloudflare.ts` (add `describeLink`)
- Modify: `src/index.ts` (callback meta write; `get-token` + cron `last_refreshed` update; refresh-failure cleanup and future unlink helper delete BOTH keys — extract shared helpers `metaKey(provider,userId)`, `writeMeta`, `touchMeta`)
- Test: extend `test/github.test.ts`, `test/cloudflare.test.ts`, `test/index.test.ts`

**Interfaces:**
- Consumes: existing `AuthProvider`, `kvKey`, engine handlers.
- Produces (Task 2 relies on): `metaKey(provider: string, userId: string): string` exported from `src/index.ts` (or a new `src/meta.ts` if `index.ts` would exceed ~300 lines — implementer's call, but export both `metaKey` and `LinkMeta` reads via `env.AUTH_TOKENS.get(metaKey(...), "json")`).

- [ ] Write failing tests: GitHub `describeLink` calls `https://api.github.com/user` with `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `User-Agent` present; returns `{login, name, id}` as strings, omitting null name; non-2xx throws. Cloudflare `describeLink` calls `https://dash.cloudflare.com/oauth2/userinfo` with bearer auth; returns flattened string/number claims; non-2xx throws.
- [ ] Write failing engine tests: callback success writes `meta:github:user@…` with `linked_at` and `details` (stub provider returning `data.access_token` and a `describeLink`); callback still 200 and stores refresh token when `describeLink` rejects (meta then has `linked_at`, no details); callback with provider lacking `describeLink` or `data.access_token` writes meta without details; `get-token` refresh success updates `last_refreshed` preserving `linked_at`/`details`; cron refresh success updates `last_refreshed`; `get-token` refresh-failure cleanup deletes refresh AND meta keys.
- [ ] Run: `npx vitest run` — new tests FAIL, existing pass.
- [ ] Implement: types additions; both `describeLink` methods; engine hooks per spec (callback uses `data.access_token` when present; all meta ops best-effort try/catch with `console.error`).
- [ ] Run: `npx tsc --noEmit` clean; `npx vitest run` all green.
- [ ] Commit: `feat: link metadata (describeLink + meta KV key)`

### Task 2: Dashboard module and routes

**Files:**
- Create: `src/dashboard.ts`
- Modify: `src/index.ts` (route wiring only: `GET /` → page; `GET /api/me`; `GET /api/links`; `DELETE /api/links/<provider>`)
- Test: `test/dashboard.test.ts`

**Interfaces:**
- Consumes from Task 1: `metaKey`, `LinkMeta`; existing `providers` registry, `kvKey`, verified JWT payload (engine passes payload + userId into handlers).
- Produces: `renderDashboardPage(): Response`; `handleMe(payload: Record<string, unknown>): Response`; `handleLinks(env: Env, userId: string, providers: Record<string, AuthProvider>): Promise<Response>`; `handleUnlink(env: Env, userId: string, providers: Record<string, AuthProvider>, slug: string): Promise<Response>` — all exported from `src/dashboard.ts`.

- [ ] Write failing route tests (via the exported worker `fetch` with stub Env/JWT, mirroring existing router tests): unauthenticated `GET /` → 401 JSON; bad JWT → 403; authed `GET /` → 200 `text/html` containing provider slugs and an element with id `identity`; `GET /api/me` → email/exp from JWT, `name` present only when claimed; `GET /api/links` → for stub registry {github linked-with-meta, cloudflare unlinked}: linked entry has `linked:true`, details, timestamps, NO `auth_url`; unlinked entry has `linked:false` and `auth_url` equal to provider `getAuthUrl`; linked-without-meta → `linked:true`, no details; `DELETE /api/links/github` → `{ok:true}` and both KV keys gone; `DELETE /api/links/nope` → 404 unsupported-provider shape; `DELETE` on unlinked provider still `{ok:true}` (idempotent).
- [ ] Run: `npx vitest run` — new tests FAIL.
- [ ] Implement `src/dashboard.ts` (handlers + HTML template per Global Constraints; page JS renders identity card and provider cards with Link `<a>`/Unlink button + `confirm()`; escape all dynamic values interpolated into HTML via a small `esc()` helper) and wire routes in `index.ts` AFTER auth, BEFORE the action/provider 404 logic; callback success page gains `<a href="/">Back to dashboard</a>`.
- [ ] Run: `npx tsc --noEmit` clean; `npx vitest run` all green (existing suites untouched-green).
- [ ] Commit: `feat: web dashboard (identity, links, web link/unlink)`

### Task 3: Deploy and verify (controller-executed)

- [ ] `CLOUDFLARE_API_TOKEN=$(op read "op://Services/Cloudflare User API Token/password") npx wrangler deploy`
- [ ] Authed curl `GET /` returns 200 HTML; `GET /api/links` lists both providers with correct linked flags; unauthenticated `GET /api/me` → Access 302.
- [ ] Report dashboard URL to user.
