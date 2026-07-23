export interface Env {
  AUTH_TOKENS: KVNamespace;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  CLOUDFLARE_OAUTH_CLIENT_ID: string;
  CLOUDFLARE_OAUTH_CLIENT_SECRET: string;
  CLOUDFLARE_OAUTH_SCOPES: string;
  BROKER_URL: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ENVIRONMENT: string;
}

export interface TokenPayload {
  token: string;
  expires_in?: number;
  additional_data?: Record<string, any>;
}

export interface AuthProvider {
  slug: string;
  getAuthUrl(env: Env, userId: string): string;
  handleCallback(request: Request, env: Env): Promise<{ refreshToken: string; data: any }>;
  refreshToken(
    refreshToken: string,
    env: Env,
    accessJwt?: string
  ): Promise<TokenPayload & { newRefreshToken?: string }>;
  describeLink?(token: string, env: Env): Promise<Record<string, string>>;
}

export interface LinkMeta {
  linked_at: string;
  last_refreshed?: string;
  details?: Record<string, string>;
}

/**
 * Optional app-level auth used to fetch curated app metadata (e.g. a GitHub
 * App's name/description/permissions), separate from the per-user OAuth2
 * token flow. A discriminated union — the extension point for future kinds
 * (e.g. `okta-private-key-jwt`).
 */
export type AppAuthConfig = {
  kind: "github-app-jwt";
  /** Name of the `Env` var holding the numeric GitHub App id. */
  appIdVar: string;
  /** Name of the `Env` var holding the PKCS#8 PEM private key. */
  privateKeyVar: string;
};

/**
 * Curated app metadata fetched via `appAuth`. Never the raw provider blob —
 * only these documented fields are surfaced.
 */
export interface AppMetadata {
  name?: string;
  description?: string;
  owner?: string;
  permissions?: Record<string, string>;
  events?: string[];
  html_url?: string;
  fetched_at: string;
}

/**
 * A single app registration in the registry, keyed by its full slug
 * `<provider>/<org>/<clientid>`. `provider` is normally built via
 * `oauth2Provider(...)` but may be any `AuthProvider` implementation.
 */
export interface AppConfig {
  slug: string;
  displayName: string;
  provider: AuthProvider;
  /** Optional app-level auth for fetching curated metadata. */
  appAuth?: AppAuthConfig;
}
