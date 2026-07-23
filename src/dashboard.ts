import type { AppConfig, AppMetadata, AuthProvider, Env, LinkMeta } from "./types";
import { appConfigs } from "./registry";
import { getCachedAppMetadata } from "./appauth";

const KV_PREFIX = "refresh:";
const META_PREFIX = "meta:";

function kvKey(provider: string, userId: string): string {
  return `${KV_PREFIX}${provider}:${userId}`;
}

function metaKey(provider: string, userId: string): string {
  return `${META_PREFIX}${provider}:${userId}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Escapes a value for safe interpolation into HTML text/attribute content. */
export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface DevicePosture {
  rule: string;
  type: string;
  success: boolean;
}

export interface DeviceInfo {
  idp?: string;
  ip?: string;
  country?: string;
  is_warp?: boolean;
  is_gateway?: boolean;
  posture?: DevicePosture[];
  sessions_count?: number;
}

/**
 * Resolves the `CF_Authorization` value to forward to get-identity, per the
 * documented precedence: the request's own `CF_Authorization` cookie wins;
 * otherwise fall back to the verified `Cf-Access-Jwt-Assertion` header value.
 */
function resolveAccessCookie(request: Request): string | null {
  const cookieHeader = request.headers.get("Cookie") ?? request.headers.get("cookie");
  if (cookieHeader) {
    for (const part of cookieHeader.split(";")) {
      const idx = part.indexOf("=");
      if (idx === -1) continue;
      const name = part.slice(0, idx).trim();
      if (name === "CF_Authorization") {
        return part.slice(idx + 1).trim();
      }
    }
  }

  return request.headers.get("Cf-Access-Jwt-Assertion");
}

/**
 * Best-effort fetch of the caller's Cloudflare Access identity (device
 * posture, session, IP/geo). Any error or non-2xx response is logged and
 * treated as "no data" — never thrown.
 */
async function fetchIdentity(request: Request, env: Env): Promise<Record<string, unknown> | null> {
  const cfAuth = resolveAccessCookie(request);
  if (!cfAuth) {
    return null;
  }

  try {
    const res = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/get-identity`, {
      headers: { Cookie: `CF_Authorization=${cfAuth}` },
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) {
      console.error(`handleMe: get-identity returned status ${res.status}`);
      return null;
    }

    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    console.error("handleMe: get-identity request failed", err);
    return null;
  }
}

/** Curates the raw get-identity blob down to the documented subset. Never forwards the raw blob. */
function curateDevice(identity: Record<string, unknown> | null): DeviceInfo | undefined {
  if (!identity) {
    return undefined;
  }

  const device: DeviceInfo = {};

  const idp = identity.idp as { type?: unknown } | undefined;
  if (idp && typeof idp.type === "string") {
    device.idp = idp.type;
  }

  if (typeof identity.ip === "string") {
    device.ip = identity.ip;
  }

  const geo = identity.geo as { country?: unknown } | undefined;
  if (geo && typeof geo.country === "string") {
    device.country = geo.country;
  }

  if (typeof identity.is_warp === "boolean") {
    device.is_warp = identity.is_warp;
  }
  if (typeof identity.is_gateway === "boolean") {
    device.is_gateway = identity.is_gateway;
  }

  const devicePosture = identity.devicePosture as Record<string, unknown> | undefined;
  if (devicePosture && typeof devicePosture === "object") {
    const entries = Object.values(devicePosture) as Array<Record<string, unknown>>;
    if (entries.length > 0) {
      device.posture = entries.map((entry) => ({
        rule: entry?.rule_name as string,
        type: entry?.type as string,
        success: entry?.success as boolean,
      }));
    }
  }

  const deviceSessions = identity.device_sessions as Record<string, unknown> | undefined;
  if (deviceSessions && typeof deviceSessions === "object") {
    const count = Object.keys(deviceSessions).length;
    if (count > 0) {
      device.sessions_count = count;
    }
  }

  return device;
}

/** `GET /api/me` — reflects the verified Access JWT claims, plus best-effort device/session enrichment. */
export async function handleMe(payload: Record<string, unknown>, request: Request, env: Env): Promise<Response> {
  const body: { email: string; exp?: number; name?: string; idp?: string; device?: DeviceInfo } = {
    email: payload.email as string,
  };

  if (typeof payload.exp === "number") {
    body.exp = payload.exp;
  }
  if (typeof payload.name === "string") {
    body.name = payload.name;
  }
  const idp = payload.idp as { type?: string } | undefined;
  if (idp && typeof idp.type === "string") {
    body.idp = idp.type;
  }

  const identity = await fetchIdentity(request, env);
  const device = curateDevice(identity);
  if (device) {
    body.device = device;
  }

  return jsonResponse(body);
}

/** `GET /api/links` — one entry per registered provider. */
export async function handleLinks(
  env: Env,
  userId: string,
  providers: Record<string, AuthProvider>
): Promise<Response> {
  const entries = await Promise.all(
    Object.values(providers).map(async (provider) => {
      const linked = (await env.AUTH_TOKENS.get(kvKey(provider.slug, userId))) !== null;

      if (!linked) {
        return {
          slug: provider.slug,
          linked: false,
          auth_url: provider.getAuthUrl(env, userId),
        };
      }

      const meta = (await env.AUTH_TOKENS.get(metaKey(provider.slug, userId), "json")) as LinkMeta | null;
      return {
        slug: provider.slug,
        linked: true,
        ...(meta?.linked_at ? { linked_at: meta.linked_at } : {}),
        ...(meta?.last_refreshed ? { last_refreshed: meta.last_refreshed } : {}),
        ...(meta?.details ? { details: meta.details } : {}),
      };
    })
  );

  return jsonResponse(entries);
}

/**
 * Resolves the `scopes` value reported by `/api/apps` for a single app: the
 * manifest-declared value, unless `scopes.source` is `"metadata.permissions"`
 * and cached metadata has a `permissions` object — in which case that
 * resolved object is reported instead (Task 2 adds `access.token_aud`/`link_aud`).
 */
function resolveScopes(
  config: AppConfig,
  metadata: AppMetadata | null
): string | string[] | Record<string, string> | undefined {
  if (!config.scopes) {
    return undefined;
  }
  if (config.scopes.source === "metadata.permissions" && metadata?.permissions) {
    return metadata.permissions;
  }
  return config.scopes.declared;
}

/**
 * `GET /api/apps` — one entry per registered app: `{ slug, provider, org,
 * client_id, display_name, metadata?, scopes?, access? }`, `metadata`
 * populated from the KV cache when present, `scopes`/`access` derived from
 * the manifest (`access.token_aud`/`link_aud` land in a later phase). This is
 * the name→slug resolution source for the CLI and dashboard.
 */
export async function handleApps(
  env: Env,
  configs: Record<string, AppConfig> = appConfigs
): Promise<Response> {
  const entries = await Promise.all(
    Object.values(configs).map(async (config) => {
      const [provider, org, client_id] = config.slug.split("/");
      const metadata = await getCachedAppMetadata(env, config.slug);
      const scopes = resolveScopes(config, metadata);
      return {
        slug: config.slug,
        provider,
        org,
        client_id,
        display_name: config.displayName,
        ...(metadata ? { metadata } : {}),
        ...(scopes !== undefined ? { scopes } : {}),
        ...(config.access
          ? { access: { groups: config.access.groups, service_token: config.access.serviceToken } }
          : {}),
      };
    })
  );

  return jsonResponse(entries);
}

/** `DELETE /api/links/<provider>` — deletes both the refresh and meta KV keys. */
export async function handleUnlink(
  env: Env,
  userId: string,
  providers: Record<string, AuthProvider>,
  slug: string
): Promise<Response> {
  if (!providers[slug]) {
    return jsonResponse({ error: `Unsupported provider: ${slug}` }, 404);
  }

  await env.AUTH_TOKENS.delete(kvKey(slug, userId));
  await env.AUTH_TOKENS.delete(metaKey(slug, userId));

  return jsonResponse({ ok: true });
}

function skeletonCardHtml(config: AppConfig): string {
  return (
    `<div class="card" data-provider="${esc(config.slug)}" data-skeleton="true">` +
    `<h2>${esc(config.displayName)} <span class="badge unlinked">...</span></h2>` +
    `<div class="muted">${esc(config.slug)}</div>` +
    `</div>`
  );
}

/** `GET /` — server-rendered dashboard page. Provider skeleton cards are baked in at render time; the client script fills in live state. */
export function renderDashboardPage(): Response {
  const skeletonCards = Object.values(appConfigs).map(skeletonCardHtml).join("\n  ");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Auth Broker Dashboard</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9;
    --card-bg: #ffffff;
    --text: #1a1a1a;
    --muted: #6b7280;
    --border: #e5e7eb;
    --accent: #2563eb;
    --danger: #dc2626;
    --badge-linked-bg: #dcfce7;
    --badge-linked-text: #166534;
    --badge-unlinked-bg: #f3f4f6;
    --badge-unlinked-text: #4b5563;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115;
      --card-bg: #1a1d24;
      --text: #e5e7eb;
      --muted: #9ca3af;
      --border: #2a2e37;
      --accent: #60a5fa;
      --danger: #f87171;
      --badge-linked-bg: #14351f;
      --badge-linked-text: #86efac;
      --badge-unlinked-bg: #262a33;
      --badge-unlinked-text: #9ca3af;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 2rem 1rem;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  main {
    max-width: 640px;
    margin: 0 auto;
  }
  h1 {
    font-size: 1.5rem;
    margin: 0 0 1.5rem;
  }
  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.25rem 1.5rem;
    margin-bottom: 1rem;
  }
  .card h2 {
    font-size: 1rem;
    margin: 0 0 0.5rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .muted { color: var(--muted); font-size: 0.9rem; }
  .badge {
    display: inline-block;
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.15rem 0.6rem;
    border-radius: 999px;
  }
  .badge.linked { background: var(--badge-linked-bg); color: var(--badge-linked-text); }
  .badge.unlinked { background: var(--badge-unlinked-bg); color: var(--badge-unlinked-text); }
  .row { font-size: 0.9rem; margin: 0.15rem 0; }
  .row .k { color: var(--muted); }
  .actions { margin-top: 0.75rem; }
  a.button, button {
    display: inline-block;
    font: inherit;
    font-weight: 600;
    font-size: 0.85rem;
    padding: 0.45rem 0.9rem;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--accent);
    color: white;
    text-decoration: none;
    cursor: pointer;
  }
  button.unlink {
    background: transparent;
    color: var(--danger);
    border-color: var(--danger);
  }
  #loading { color: var(--muted); }
</style>
</head>
<body>
<main>
  <h1>Auth Broker</h1>
  <section id="identity" class="card">
    <p class="muted">Loading...</p>
  </section>
  <div id="loading" class="muted">Loading providers...</div>
  <section id="links">
  ${skeletonCards}
  </section>
</main>
<script>
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderDeviceSection(device) {
  if (!device) {
    return "";
  }

  let rows = "";
  if (device.idp) {
    rows += '<div class="row"><span class="k">IdP:</span> ' + esc(device.idp) + '</div>';
  }
  if (device.ip) {
    rows +=
      '<div class="row"><span class="k">IP:</span> ' +
      esc(device.ip) +
      (device.country ? ' (' + esc(device.country) + ')' : '') +
      '</div>';
  }
  if (typeof device.is_warp === "boolean") {
    rows +=
      '<div class="row"><span class="k">WARP:</span> <span class="badge ' +
      (device.is_warp ? "linked" : "unlinked") +
      '">' + (device.is_warp ? "On" : "Off") + '</span></div>';
  }
  if (typeof device.is_gateway === "boolean") {
    rows +=
      '<div class="row"><span class="k">Gateway:</span> <span class="badge ' +
      (device.is_gateway ? "linked" : "unlinked") +
      '">' + (device.is_gateway ? "On" : "Off") + '</span></div>';
  }
  if (Array.isArray(device.posture)) {
    for (const check of device.posture) {
      rows +=
        '<div class="row">' +
        (check.success ? "✓" : "✗") +
        ' ' + esc(check.rule) +
        '</div>';
    }
  }
  if (typeof device.sessions_count === "number") {
    rows += '<div class="row"><span class="k">Active sessions:</span> ' + esc(device.sessions_count) + '</div>';
  }

  return '<h3>Device &amp; session</h3>' + rows;
}

async function loadIdentity() {
  const res = await fetch("/api/me");
  const me = await res.json();
  const identity = document.getElementById("identity");
  const expLine = me.exp
    ? '<div class="row"><span class="k">Session expires:</span> ' + esc(new Date(me.exp * 1000).toLocaleString()) + '</div>'
    : "";
  identity.innerHTML =
    '<h2>' + esc(me.name || me.email) + '</h2>' +
    '<div class="row"><span class="k">Email:</span> ' + esc(me.email) + '</div>' +
    (me.idp ? '<div class="row"><span class="k">Identity provider:</span> ' + esc(me.idp) + '</div>' : '') +
    expLine +
    renderDeviceSection(me.device);
}

function renderLinkCard(entry) {
  function summarizeScopes(scopes) {
    if (scopes === undefined || scopes === null) {
      return "";
    }
    if (Array.isArray(scopes)) {
      return scopes.join(", ");
    }
    if (typeof scopes === "object") {
      return Object.keys(scopes)
        .map(function (key) {
          return key + ":" + scopes[key];
        })
        .join(", ");
    }
    return String(scopes);
  }

  const badgeClass = entry.linked ? "linked" : "unlinked";
  const badgeText = entry.linked ? "Linked" : "Not linked";
  const title = (entry.metadata && entry.metadata.name) || entry.display_name || entry.slug;
  let rows = "";
  if (entry.details) {
    for (const key of Object.keys(entry.details)) {
      rows += '<div class="row"><span class="k">' + esc(key) + ':</span> ' + esc(entry.details[key]) + '</div>';
    }
  }
  if (entry.linked_at) {
    rows += '<div class="row"><span class="k">Linked:</span> ' + esc(new Date(entry.linked_at).toLocaleString()) + '</div>';
  }
  if (entry.last_refreshed) {
    rows += '<div class="row"><span class="k">Last refreshed:</span> ' + esc(new Date(entry.last_refreshed).toLocaleString()) + '</div>';
  }
  const scopesSummary = summarizeScopes(entry.scopes);
  if (scopesSummary) {
    rows += '<div class="row"><span class="k">Scopes:</span> ' + esc(scopesSummary) + '</div>';
  }
  if (entry.access && Array.isArray(entry.access.groups) && entry.access.groups.length > 0) {
    rows +=
      '<div class="row"><span class="k">Required groups:</span> ' +
      esc(entry.access.groups.join(", ")) +
      '</div>';
  }

  let action;
  if (entry.linked) {
    action = '<button class="unlink" data-slug="' + esc(entry.slug) + '">Unlink</button>';
  } else {
    action = '<a class="button" href="' + esc(entry.auth_url) + '">Link</a>';
  }

  return (
    '<div class="card" data-provider="' + esc(entry.slug) + '">' +
    '<h2>' + esc(title) + ' <span class="badge ' + badgeClass + '">' + badgeText + '</span></h2>' +
    '<div class="muted">' + esc(entry.slug) + '</div>' +
    rows +
    '<div class="actions">' + action + '</div>' +
    '</div>'
  );
}

async function loadLinks() {
  const [linksRes, appsRes] = await Promise.all([fetch("/api/links"), fetch("/api/apps")]);
  const links = await linksRes.json();
  const apps = await appsRes.json();
  const appsBySlug = {};
  apps.forEach(function (app) {
    appsBySlug[app.slug] = app;
  });
  const merged = links.map(function (entry) {
    const app = appsBySlug[entry.slug] || {};
    return Object.assign({}, entry, {
      display_name: app.display_name,
      metadata: app.metadata,
      scopes: app.scopes,
      access: app.access,
    });
  });

  const container = document.getElementById("links");
  container.innerHTML = merged.map(renderLinkCard).join("");
  document.getElementById("loading").style.display = "none";

  container.querySelectorAll("button.unlink").forEach(function (btn) {
    btn.addEventListener("click", async function () {
      const slug = btn.getAttribute("data-slug");
      if (!confirm("Unlink " + slug + "?")) {
        return;
      }
      await fetch("/api/links/" + slug, { method: "DELETE" });
      await loadLinks();
    });
  });
}

loadIdentity();
loadLinks();
</script>
</body>
</html>
`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html" },
  });
}
