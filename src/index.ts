import type { AuthProvider, Env } from "./types";
import { verifyAccessJwt } from "./access";
import { GitHubProvider } from "./providers/github";
import { CloudflareProvider } from "./providers/cloudflare";

const providers: Record<string, AuthProvider> = {
  github: new GitHubProvider(),
  cloudflare: new CloudflareProvider(),
};

const KV_PREFIX = "refresh:";

function kvKey(provider: string, userId: string): string {
  return `${KV_PREFIX}${provider}:${userId}`;
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
    const { refreshToken } = await provider.handleCallback(request, env);
    await env.AUTH_TOKENS.put(kvKey(provider.slug, userId), refreshToken);
    return new Response(`<html><body><h1>${provider.slug.toUpperCase()} Linked!</h1></body></html>`, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
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
    return jsonResponse({
      token: result.token,
      expires_in: result.expires_in,
      ...(result.additional_data ?? {}),
    });
  } catch (err) {
    await env.AUTH_TOKENS.delete(key);
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
    try {
      const payload = await verifyAccessJwt(accessJwt, env);
      userId = payload.email;
    } catch {
      return jsonResponse({ error: "Invalid Access token" }, 403);
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
      } catch (err) {
        console.error(`scheduled: failed to refresh ${key.name}`, err);
      }
    }
  },
};
