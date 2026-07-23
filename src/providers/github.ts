import type { AuthProvider, Env, TokenPayload } from "../types";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

interface GitHubTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export class GitHubProvider implements AuthProvider {
  slug = "github";

  getAuthUrl(env: Env, _userId: string): string {
    const redirectUri = `${env.BROKER_URL}/callback/github`;
    const state = crypto.randomUUID();
    const params = new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      redirect_uri: redirectUri,
      state,
    });
    return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
  }

  async handleCallback(request: Request, env: Env): Promise<{ refreshToken: string; data: any }> {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    if (!code) {
      throw new Error("Missing code parameter");
    }

    const redirectUri = `${env.BROKER_URL}/callback/github`;
    const body = new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    });

    const res = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    const json = (await res.json()) as GitHubTokenResponse;

    if (json.error) {
      throw new Error(json.error_description || json.error);
    }

    if (!json.refresh_token) {
      throw new Error(
        "GitHub did not return a refresh_token; ensure the GitHub App has expiring user tokens enabled"
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
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
    });

    const res = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    const json = (await res.json()) as GitHubTokenResponse;

    if (json.error) {
      throw new Error(json.error_description || json.error);
    }

    if (!json.access_token) {
      throw new Error("GitHub refresh response missing access_token");
    }

    return {
      token: json.access_token,
      expires_in: json.expires_in,
      newRefreshToken: json.refresh_token,
    };
  }

  async describeLink(token: string, _env: Env): Promise<Record<string, string>> {
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
}
