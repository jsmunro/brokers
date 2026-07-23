export interface Env {
  AUTH_TOKENS: KVNamespace;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
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
