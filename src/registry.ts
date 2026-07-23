import type { AppConfig, AuthProvider, Env } from "./types";
import { oauth2Provider } from "./oauth2";

const GITHUB_USER_URL = "https://api.github.com/user";
const CLOUDFLARE_USERINFO_URL = "https://dash.cloudflare.com/oauth2/userinfo";

export const GITHUB_SLUG = "github/jsmunro/Iv23lifj0i4aV6qYR76i";
export const CLOUDFLARE_SLUG = "cloudflare/jackm/9f2c965eeb2fcc390fc3843935de35bc";

async function githubDescribeLink(token: string, _env: Env): Promise<Record<string, string>> {
  const res = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "central-auth-broker",
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub describeLink failed (${res.status})`);
  }

  const json = (await res.json()) as { login?: string; name?: string | null; id?: number };
  const details: Record<string, string> = {};
  if (json.login !== undefined && json.login !== null) {
    details.login = String(json.login);
  }
  if (json.id !== undefined && json.id !== null) {
    details.id = String(json.id);
  }
  if (json.name !== undefined && json.name !== null) {
    details.name = String(json.name);
  }
  return details;
}

async function cloudflareDescribeLink(token: string, _env: Env): Promise<Record<string, string>> {
  const res = await fetch(CLOUDFLARE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`Cloudflare describeLink failed (${res.status})`);
  }

  const json = (await res.json()) as Record<string, unknown>;
  const details: Record<string, string> = {};
  for (const [key, value] of Object.entries(json)) {
    if (typeof value === "string" || typeof value === "number") {
      details[key] = String(value);
    }
  }
  return details;
}

/**
 * The two registered apps. Engine and dashboard import ONLY from this
 * module — the registry key IS the routing/KV slug.
 */
export const appConfigs: Record<string, AppConfig> = {
  [GITHUB_SLUG]: {
    slug: GITHUB_SLUG,
    displayName: "Brokers repo",
    provider: oauth2Provider({
      slug: GITHUB_SLUG,
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      clientIdVar: "GITHUB_CLIENT_ID",
      clientSecretVar: "GITHUB_CLIENT_SECRET",
      clientAuth: "body",
      describeLink: githubDescribeLink,
    }),
  },
  [CLOUDFLARE_SLUG]: {
    slug: CLOUDFLARE_SLUG,
    displayName: "central-auth-broker",
    provider: oauth2Provider({
      slug: CLOUDFLARE_SLUG,
      authorizeUrl: "https://dash.cloudflare.com/oauth2/auth",
      tokenUrl: "https://dash.cloudflare.com/oauth2/token",
      clientIdVar: "CLOUDFLARE_OAUTH_CLIENT_ID",
      clientSecretVar: "CLOUDFLARE_OAUTH_CLIENT_SECRET",
      clientAuth: "body",
      authorizeParams: (env) => ({ scope: env.CLOUDFLARE_OAUTH_SCOPES }),
      describeLink: cloudflareDescribeLink,
    }),
  },
};

/** `AuthProvider`s keyed by full slug, for routing and refresh/callback handling. */
export const apps: Record<string, AuthProvider> = Object.fromEntries(
  Object.entries(appConfigs).map(([slug, config]) => [slug, config.provider])
);
