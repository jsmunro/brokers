import type { AuthProvider, Env, LinkMeta } from "./types";
import { verifyAccessJwt } from "./access";
import { GitHubProvider } from "./providers/github";
import { CloudflareProvider } from "./providers/cloudflare";
import { renderDashboardPage, handleMe, handleLinks, handleUnlink } from "./dashboard";

const providers: Record<string, AuthProvider> = {
  github: new GitHubProvider(),
  cloudflare: new CloudflareProvider(),
};

const KV_PREFIX = "refresh:";
const META_PREFIX = "meta:";

function kvKey(provider: string, userId: string): string {
  return `${KV_PREFIX}${provider}:${userId}`;
}

/** KV key for a provider link's metadata. Exported for the dashboard layer (Task 2). */
export function metaKey(provider: string, userId: string): string {
  return `${META_PREFIX}${provider}:${userId}`;
}

/**
 * Best-effort write of the link metadata after a successful callback. Never
 * throws: any failure (KV or describeLink) is logged and swallowed so it can
 * never fail the user-facing callback response.
 */
export async function writeMeta(
  env: Env,
  provider: AuthProvider,
  userId: string,
  data: any
): Promise<void> {
  try {
    const meta: LinkMeta = { linked_at: new Date().toISOString() };

    if (provider.describeLink && data?.access_token) {
      try {
        meta.details = await provider.describeLink(data.access_token, env);
      } catch (err) {
        console.error(`writeMeta: describeLink failed for ${provider.slug}:${userId}`, err);
      }
    }

    await env.AUTH_TOKENS.put(metaKey(provider.slug, userId), JSON.stringify(meta));
  } catch (err) {
    console.error(`writeMeta: failed to write meta for ${provider.slug}:${userId}`, err);
  }
}

/**
 * Best-effort update of `last_refreshed` on the meta key, preserving any
 * existing `linked_at`/`details`. Creates the meta key if it's absent (e.g.
 * for links created before this feature existed). Never throws.
 */
export async function touchMeta(env: Env, providerSlug: string, userId: string): Promise<void> {
  try {
    const key = metaKey(providerSlug, userId);
    const existing = (await env.AUTH_TOKENS.get(key, "json")) as LinkMeta | null;
    const meta: LinkMeta = existing ? { ...existing } : { linked_at: new Date().toISOString() };
    meta.last_refreshed = new Date().toISOString();
    await env.AUTH_TOKENS.put(key, JSON.stringify(meta));
  } catch (err) {
    console.error(`touchMeta: failed to update meta for ${providerSlug}:${userId}`, err);
  }
}

/** Best-effort delete of the meta key. Never throws. */
async function deleteMeta(env: Env, providerSlug: string, userId: string): Promise<void> {
  try {
    await env.AUTH_TOKENS.delete(metaKey(providerSlug, userId));
  } catch (err) {
    console.error(`deleteMeta: failed to delete meta for ${providerSlug}:${userId}`, err);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function setupRequiredResponse(provider: AuthProvider, env: Env, userId: string): Promise<Response> {
  return jsonResponse({ setup_required: true, url: provider.getAuthUrl(env, userId) });
}

async function handleCallback(
  provider: AuthProvider,
  request: Request,
  env: Env,
  userId: string
): Promise<Response> {
  try {
    const { refreshToken, data } = await provider.handleCallback(request, env);
    await env.AUTH_TOKENS.put(kvKey(provider.slug, userId), refreshToken);
    await writeMeta(env, provider, userId, data);
    return new Response(
      `<html><body><h1>${provider.slug.toUpperCase()} Linked!</h1><a href="/">Back to dashboard</a></body></html>`,
      {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(`Callback Failed: ${message}`, {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

async function handleGetToken(
  provider: AuthProvider,
  env: Env,
  userId: string,
  accessJwt: string
): Promise<Response> {
  const key = kvKey(provider.slug, userId);
  const storedRefreshToken = await env.AUTH_TOKENS.get(key);

  if (!storedRefreshToken) {
    return setupRequiredResponse(provider, env, userId);
  }

  try {
    const result = await provider.refreshToken(storedRefreshToken, env, accessJwt);
    if (result.newRefreshToken) {
      await env.AUTH_TOKENS.put(key, result.newRefreshToken);
    }
    await touchMeta(env, provider.slug, userId);
    return jsonResponse({
      token: result.token,
      expires_in: result.expires_in,
      ...(result.additional_data ?? {}),
    });
  } catch (err) {
    await env.AUTH_TOKENS.delete(key);
    await deleteMeta(env, provider.slug, userId);
    return setupRequiredResponse(provider, env, userId);
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const [action, providerSlug] = segments;

    const accessJwt = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!accessJwt) {
      return jsonResponse({ error: "Unauthorized: Cloudflare Access Required" }, 401);
    }

    let userId: string;
    let payload: Record<string, unknown>;
    try {
      payload = await verifyAccessJwt(accessJwt, env);
      userId = payload.email as string;
    } catch {
      return jsonResponse({ error: "Invalid Access token" }, 403);
    }

    if (segments.length === 0 && request.method === "GET") {
      return renderDashboardPage();
    }

    if (action === "api" && segments[1] === "me" && segments.length === 2 && request.method === "GET") {
      return handleMe(payload);
    }

    if (action === "api" && segments[1] === "links" && segments.length === 2 && request.method === "GET") {
      return handleLinks(env, userId, providers);
    }

    if (action === "api" && segments[1] === "links" && segments.length === 3 && request.method === "DELETE") {
      return handleUnlink(env, userId, providers, segments[2]!);
    }

    if (action !== "get-token" && action !== "callback") {
      return new Response("Endpoint Not Found", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }

    if (!providerSlug || !providers[providerSlug]) {
      return jsonResponse({ error: `Unsupported provider: ${providerSlug ?? ""}` }, 404);
    }

    const provider = providers[providerSlug]!;

    if (action === "callback") {
      return handleCallback(provider, request, env, userId);
    }

    return handleGetToken(provider, env, userId, accessJwt);
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const list = await env.AUTH_TOKENS.list({ prefix: KV_PREFIX });
    for (const key of list.keys) {
      try {
        const parts = key.name.slice(KV_PREFIX.length).split(":");
        const providerSlug = parts[0];
        const userId = parts.slice(1).join(":");
        const provider = providerSlug ? providers[providerSlug] : undefined;
        if (!provider) {
          console.error(`scheduled: unknown provider for key ${key.name}`);
          continue;
        }

        const refreshToken = await env.AUTH_TOKENS.get(key.name);
        if (!refreshToken) {
          continue;
        }

        const result = await provider.refreshToken(refreshToken, env);
        if (result.newRefreshToken) {
          await env.AUTH_TOKENS.put(key.name, result.newRefreshToken);
        }
        await touchMeta(env, provider.slug, userId);
      } catch (err) {
        console.error(`scheduled: failed to refresh ${key.name}`, err);
      }
    }
  },
};
