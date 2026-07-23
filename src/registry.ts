import type { AppConfig, AuthProvider, Env, Manifest } from "./types";
import { oauth2Provider } from "./oauth2";
import manifestJson from "../apps/manifest.json";

// wrangler/esbuild and vitest both resolve this as a native JSON import
// (tsconfig `resolveJsonModule`); the manifest is the single source of truth
// for app registration — this module is a thin adapter from it to the
// worker's runtime types. `describeLink`/`appAuth` wiring that needs actual
// code (not just data) stays here, keyed by slug.
const manifest = manifestJson as unknown as Manifest;

export const GITHUB_SLUG = "github/jsmunro/Iv23lifj0i4aV6qYR76i";
export const CLOUDFLARE_SLUG = "cloudflare/jackm/9f2c965eeb2fcc390fc3843935de35bc";

const GITHUB_USER_URL = "https://api.github.com/user";
const CLOUDFLARE_USERINFO_URL = "https://dash.cloudflare.com/oauth2/userinfo";

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
 * `describeLink` implementations, keyed by full slug. The manifest carries no
 * code — only data — so this map is how code-side behavior stays wired to a
 * manifest-declared app.
 */
const describeLinkBySlug: Record<string, (token: string, env: Env) => Promise<Record<string, string>>> = {
  [GITHUB_SLUG]: githubDescribeLink,
  [CLOUDFLARE_SLUG]: cloudflareDescribeLink,
};

/** Builds an `authorizeParams` fn reading a single env var as the `scope` value, or `undefined` if unset. */
function buildAuthorizeParams(
  authorizeParamsVar: string | undefined
): ((env: Env) => Record<string, string>) | undefined {
  if (!authorizeParamsVar) {
    return undefined;
  }
  return (env: Env) => ({ scope: (env as unknown as Record<string, string>)[authorizeParamsVar] ?? "" });
}

function buildAppConfig(app: Manifest["apps"][number]): AppConfig {
  const provider = oauth2Provider({
    slug: app.slug,
    authorizeUrl: app.auth.authorize_url,
    tokenUrl: app.auth.token_url,
    clientIdVar: app.auth.client_id_var as keyof Env & string,
    clientSecretVar: app.auth.client_secret_var as keyof Env & string,
    clientAuth: app.auth.client_auth,
    authorizeParams: buildAuthorizeParams(app.auth.authorize_params_var),
    requireRefreshToken: app.auth.require_refresh_token,
    describeLink: describeLinkBySlug[app.slug],
  });

  const config: AppConfig = {
    slug: app.slug,
    displayName: app.display_name,
    provider,
    scopes: {
      declared: app.scopes.declared,
      ...(app.scopes.source ? { source: app.scopes.source } : {}),
    },
    access: {
      groups: app.access.allow_groups ?? manifest.defaults.access.allow_groups,
      serviceToken: app.access.service_token ?? false,
    },
  };

  if (app.app_auth) {
    config.appAuth = {
      kind: "github-app-jwt",
      appIdVar: app.app_auth.app_id_var,
      privateKeyVar: app.app_auth.private_key_var,
    };
  }

  return config;
}

/**
 * The registered apps, built from `apps/manifest.json`. Engine and dashboard
 * import ONLY from this module — the registry key IS the routing/KV slug.
 */
export const appConfigs: Record<string, AppConfig> = Object.fromEntries(
  manifest.apps.map((app) => [app.slug, buildAppConfig(app)])
);

/** `AuthProvider`s keyed by full slug, for routing and refresh/callback handling. */
export const apps: Record<string, AuthProvider> = Object.fromEntries(
  Object.entries(appConfigs).map(([slug, config]) => [slug, config.provider])
);
