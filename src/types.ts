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

/** Declared OAuth/permission scopes for an app, surfaced via `/api/apps`. */
export interface AppScopes {
  declared: string | string[];
  /** When set to "metadata.permissions" and cached metadata has a `permissions`
   * object, `/api/apps` reports that resolved object instead of `declared`. */
  source?: "metadata.permissions";
}

/** Per-app access requirements, surfaced via `/api/apps` (`access.token_aud`/`link_aud` land in a later phase). */
export interface AppAccess {
  /** Access Group names (from `manifest.groups`) required to use this app. */
  groups: string[];
  /** Whether a Cloudflare Access service token is provisioned for machine use. */
  serviceToken: boolean;
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
  /** Declared scopes, from the manifest. Optional only for hand-built AppConfigs (e.g. in tests). */
  scopes?: AppScopes;
  /** Access requirements, from the manifest. Optional only for hand-built AppConfigs (e.g. in tests). */
  access?: AppAccess;
}

/**
 * `apps/manifest.json` schema (phase 1 subset). Parsed at build time via a
 * native JSON import in `src/registry.ts` — this type describes that shape.
 */
export interface ManifestGroup {
  emails?: string[];
  /** GitHub org-membership rule; a team slug scopes it, `null` means org-wide (no team). */
  github_team?: string | null;
  okta_group?: string;
}

export interface ManifestOAuth2Auth {
  kind: "oauth2";
  authorize_url: string;
  token_url: string;
  client_id_var: string;
  client_secret_var: string;
  client_auth?: "body" | "basic";
  /** Name of the `Env` var whose value is passed as the authorize URL's `scope` param. */
  authorize_params_var?: string;
  require_refresh_token?: boolean;
}

export interface ManifestAppAuth {
  kind: "github-app-jwt";
  app_id_var: string;
  private_key_var: string;
}

export interface ManifestScopes {
  declared: string | string[];
  source?: "metadata.permissions";
}

export interface ManifestAccess {
  allow_groups?: string[];
  session_duration?: string;
  service_token?: boolean;
}

export interface ManifestLinkPolicy {
  require_warp?: boolean;
  require_posture?: string[];
  require_mfa?: boolean;
}

export interface ManifestBookmark {
  app_launcher: boolean;
}

export interface ManifestApp {
  slug: string;
  display_name: string;
  auth: ManifestOAuth2Auth;
  app_auth?: ManifestAppAuth;
  scopes: ManifestScopes;
  access: ManifestAccess;
  link_policy?: ManifestLinkPolicy;
  bookmark?: ManifestBookmark;
}

export interface Manifest {
  version: 1;
  defaults: {
    access: { session_duration: string; allow_groups: string[] };
    link_policy: { require_warp?: boolean; require_posture?: string[]; require_mfa?: boolean };
  };
  groups: Record<string, ManifestGroup>;
  apps: ManifestApp[];
}
