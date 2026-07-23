import type { AuthProvider, Env, LinkMeta } from "./types";
import { GitHubProvider } from "./providers/github";
import { CloudflareProvider } from "./providers/cloudflare";

// Slugs only, for the server-rendered page skeleton (Task 2's `renderDashboardPage()`
// takes no arguments per the interface contract). The live registry used for routing
// and KV lookups is passed into `handleLinks`/`handleUnlink` by the caller in index.ts.
const DASHBOARD_PROVIDER_SLUGS: string[] = [new GitHubProvider().slug, new CloudflareProvider().slug];

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

/** `GET /api/me` — reflects the verified Access JWT claims. */
export function handleMe(payload: Record<string, unknown>): Response {
  const body: { email: string; exp?: number; name?: string; idp?: string } = {
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

function skeletonCardHtml(slug: string): string {
  return (
    `<div class="card" data-provider="${esc(slug)}" data-skeleton="true">` +
    `<h2>${esc(slug)} <span class="badge unlinked">...</span></h2>` +
    `</div>`
  );
}

/** `GET /` — server-rendered dashboard page. Provider skeleton cards are baked in at render time; the client script fills in live state. */
export function renderDashboardPage(): Response {
  const skeletonCards = DASHBOARD_PROVIDER_SLUGS.map(skeletonCardHtml).join("\n  ");

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
    expLine;
}

function renderLinkCard(entry) {
  const badgeClass = entry.linked ? "linked" : "unlinked";
  const badgeText = entry.linked ? "Linked" : "Not linked";
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

  let action;
  if (entry.linked) {
    action = '<button class="unlink" data-slug="' + esc(entry.slug) + '">Unlink</button>';
  } else {
    action = '<a class="button" href="' + esc(entry.auth_url) + '">Link</a>';
  }

  return (
    '<div class="card" data-provider="' + esc(entry.slug) + '">' +
    '<h2>' + esc(entry.slug) + ' <span class="badge ' + badgeClass + '">' + badgeText + '</span></h2>' +
    rows +
    '<div class="actions">' + action + '</div>' +
    '</div>'
  );
}

async function loadLinks() {
  const res = await fetch("/api/links");
  const links = await res.json();
  const container = document.getElementById("links");
  container.innerHTML = links.map(renderLinkCard).join("");
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
