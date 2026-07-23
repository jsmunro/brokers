import type { AuthProvider, Env, TokenPayload } from "./types";

/** Minimal shape a token endpoint response is normalized into. */
export interface ExtractedTokens {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface OAuth2Config {
  /** Full `<provider>/<org>/<clientid>` slug; also used to derive `redirect_uri`. */
  slug: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Name of the `Env` property holding the OAuth client id. */
  clientIdVar: keyof Env & string;
  /** Name of the `Env` property holding the OAuth client secret. */
  clientSecretVar: keyof Env & string;
  /**
   * How client credentials are sent on token requests. "body" (default) puts
   * `client_id`/`client_secret` in the form-encoded POST body; "basic" sends
   * `Authorization: Basic base64(id:secret)` and omits them from the body.
   */
  clientAuth?: "body" | "basic";
  /** Extra authorize-URL query params, merged in after the standard ones. */
  authorizeParams?(env: Env): Record<string, string>;
  /** Extra token-request body params, merged in on both callback and refresh. */
  tokenParams?(env: Env): Record<string, string>;
  /** Normalizes a token endpoint JSON response. Defaults to access_token/refresh_token/expires_in. */
  extractTokens?(json: any): ExtractedTokens;
  /** Whether the initial callback exchange must return a refresh_token. Defaults to true. */
  requireRefreshToken?: boolean;
  describeLink?(token: string, env: Env): Promise<Record<string, string>>;
}

function getEnvVar(env: Env, name: string): string {
  const value = (env as unknown as Record<string, unknown>)[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required config: ${name} is not set`);
  }
  return value;
}

function defaultExtractTokens(json: any): ExtractedTokens {
  return {
    access_token: json?.access_token,
    refresh_token: json?.refresh_token,
    expires_in: json?.expires_in,
  };
}

/** Builds an `AuthProvider` implementing the standard OAuth2 authorization-code + refresh flow. */
export function oauth2Provider(config: OAuth2Config): AuthProvider {
  const extractTokens = config.extractTokens ?? defaultExtractTokens;
  const requireRefreshToken = config.requireRefreshToken ?? true;
  const redirectUri = (env: Env): string => `${env.BROKER_URL}/callback/${config.slug}`;

  function buildTokenRequestInit(
    env: Env,
    bodyParams: Record<string, string>
  ): { headers: Record<string, string>; body: string } {
    const clientId = getEnvVar(env, config.clientIdVar);
    const clientSecret = getEnvVar(env, config.clientSecretVar);

    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    };

    const params = { ...bodyParams };
    if (config.clientAuth === "basic") {
      headers.Authorization = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
    } else {
      params.client_id = clientId;
      params.client_secret = clientSecret;
    }

    return { headers, body: new URLSearchParams(params).toString() };
  }

  return {
    slug: config.slug,

    getAuthUrl(env: Env, _userId: string): string {
      const state = crypto.randomUUID();
      const params = new URLSearchParams({
        client_id: getEnvVar(env, config.clientIdVar),
        redirect_uri: redirectUri(env),
        response_type: "code",
        state,
        ...(config.authorizeParams?.(env) ?? {}),
      });
      return `${config.authorizeUrl}?${params.toString()}`;
    },

    async handleCallback(request: Request, env: Env): Promise<{ refreshToken: string; data: any }> {
      const url = new URL(request.url);
      const code = url.searchParams.get("code");
      if (!code) {
        throw new Error("Missing code parameter");
      }

      const { headers, body } = buildTokenRequestInit(env, {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(env),
        ...(config.tokenParams?.(env) ?? {}),
      });

      const res = await fetch(config.tokenUrl, { method: "POST", headers, body });
      const json = (await res.json()) as any;

      if (!res.ok || json.error) {
        throw new Error(
          json.error_description || json.error || `${config.slug} token exchange failed (${res.status})`
        );
      }

      const tokens = extractTokens(json);

      if (requireRefreshToken && !tokens.refresh_token) {
        throw new Error(
          `${config.slug} did not return a refresh_token; ensure offline/refresh access is granted`
        );
      }

      const data = { ...json };
      if (tokens.access_token !== undefined) {
        data.access_token = tokens.access_token;
      }

      return { refreshToken: tokens.refresh_token as string, data };
    },

    async refreshToken(
      refreshTokenValue: string,
      env: Env,
      _accessJwt?: string
    ): Promise<TokenPayload & { newRefreshToken?: string }> {
      const { headers, body } = buildTokenRequestInit(env, {
        grant_type: "refresh_token",
        refresh_token: refreshTokenValue,
        ...(config.tokenParams?.(env) ?? {}),
      });

      const res = await fetch(config.tokenUrl, { method: "POST", headers, body });
      const json = (await res.json()) as any;

      if (!res.ok || json.error) {
        throw new Error(
          json.error_description || json.error || `${config.slug} token refresh failed (${res.status})`
        );
      }

      const tokens = extractTokens(json);
      if (!tokens.access_token) {
        throw new Error(`${config.slug} refresh response missing access_token`);
      }

      const result: TokenPayload & { newRefreshToken?: string } = {
        token: tokens.access_token,
        expires_in: tokens.expires_in,
      };
      if (tokens.refresh_token) {
        result.newRefreshToken = tokens.refresh_token;
      }
      return result;
    },

    ...(config.describeLink ? { describeLink: config.describeLink } : {}),
  };
}
