import type { AuthProvider, Env, TokenPayload } from "../types";

const CLOUDFLARE_AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
const CLOUDFLARE_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";

interface CloudflareTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export class CloudflareProvider implements AuthProvider {
  slug = "cloudflare";

  getAuthUrl(env: Env, _userId: string): string {
    const redirectUri = `${env.BROKER_URL}/callback/cloudflare`;
    const state = crypto.randomUUID();
    const params = new URLSearchParams({
      client_id: env.CLOUDFLARE_OAUTH_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      state,
      scope: env.CLOUDFLARE_OAUTH_SCOPES,
    });
    return `${CLOUDFLARE_AUTHORIZE_URL}?${params.toString()}`;
  }

  async handleCallback(request: Request, env: Env): Promise<{ refreshToken: string; data: any }> {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    if (!code) {
      throw new Error("Missing code parameter");
    }

    const redirectUri = `${env.BROKER_URL}/callback/cloudflare`;
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: env.CLOUDFLARE_OAUTH_CLIENT_ID,
      client_secret: env.CLOUDFLARE_OAUTH_CLIENT_SECRET,
    });

    const res = await fetch(CLOUDFLARE_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    const json = (await res.json()) as CloudflareTokenResponse;

    if (!res.ok || json.error) {
      throw new Error(json.error_description || json.error || `Cloudflare token exchange failed (${res.status})`);
    }

    if (!json.refresh_token) {
      throw new Error(
        "Cloudflare did not return a refresh_token; ensure offline_access is included in the OAuth client's scopes"
      );
    }

    return {
      refreshToken: json.refresh_token,
      data: json,
    };
  }

  async refreshToken(
    refreshToken: string,
    env: Env,
    _accessJwt?: string
  ): Promise<TokenPayload & { newRefreshToken?: string }> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: env.CLOUDFLARE_OAUTH_CLIENT_ID,
      client_secret: env.CLOUDFLARE_OAUTH_CLIENT_SECRET,
    });

    const res = await fetch(CLOUDFLARE_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    const json = (await res.json()) as CloudflareTokenResponse;

    if (!res.ok || json.error) {
      throw new Error(json.error_description || json.error || `Cloudflare token refresh failed (${res.status})`);
    }

    if (!json.access_token) {
      throw new Error("Cloudflare refresh response missing access_token");
    }

    const result: TokenPayload & { newRefreshToken?: string } = {
      token: json.access_token,
      expires_in: json.expires_in,
    };

    if (json.refresh_token) {
      result.newRefreshToken = json.refresh_token;
    }

    return result;
  }
}
