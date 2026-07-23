import { beforeEach, describe, expect, it, vi } from "vitest";
import { oauth2Provider, type OAuth2Config } from "../src/oauth2";
import { providerContractTests } from "./contract";
import { makeEnv } from "./helpers";

const baseConfig: OAuth2Config = {
  slug: "testprov/org/client123",
  authorizeUrl: "https://example.com/oauth/authorize",
  tokenUrl: "https://example.com/oauth/token",
  clientIdVar: "GITHUB_CLIENT_ID",
  clientSecretVar: "GITHUB_CLIENT_SECRET",
};

const CALLBACK_URL = "https://broker.jsmunro.me/callback/testprov/org/client123?code=abc123";

describe("oauth2Provider factory", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  providerContractTests("generic body-auth provider", () => oauth2Provider(baseConfig), {
    env: makeEnv(),
    authorizeUrl: baseConfig.authorizeUrl,
    callbackRequestUrl: CALLBACK_URL,
    tokenExchangeResponse: { access_token: "tok", refresh_token: "refresh1", expires_in: 3600 },
    expectedRefreshToken: "refresh1",
    expectedAccessToken: "tok",
    refreshResponse: { access_token: "tok2", refresh_token: "refresh2", expires_in: 3600 },
    expectedRefreshedToken: "tok2",
  });

  it("derives redirect_uri from BROKER_URL and the full slug", () => {
    const env = makeEnv();
    const provider = oauth2Provider(baseConfig);
    const url = new URL(provider.getAuthUrl(env, "user@example.com"));
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://broker.jsmunro.me/callback/testprov/org/client123"
    );
  });

  it("authorizeParams are merged into the authorize URL", () => {
    const env = makeEnv();
    const provider = oauth2Provider({
      ...baseConfig,
      authorizeParams: () => ({ scope: "read write" }),
    });
    const url = new URL(provider.getAuthUrl(env, "user@example.com"));
    expect(url.searchParams.get("scope")).toBe("read write");
  });

  it("body auth (default) sends client_id/client_secret in the POST body with no Authorization header", async () => {
    const env = makeEnv();
    const provider = oauth2Provider({ ...baseConfig, clientAuth: "body" });

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
      expect(headers.Accept).toBe("application/json");

      const body = new URLSearchParams(init?.body as string);
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("abc123");
      expect(body.get("client_id")).toBe(env.GITHUB_CLIENT_ID);
      expect(body.get("client_secret")).toBe(env.GITHUB_CLIENT_SECRET);

      return new Response(
        JSON.stringify({ access_token: "tok", refresh_token: "r", expires_in: 10 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = new Request(CALLBACK_URL);
    await provider.handleCallback(request, env);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("basic auth sends an Authorization: Basic header and omits client_id/client_secret from the body", async () => {
    const env = makeEnv();
    const provider = oauth2Provider({ ...baseConfig, clientAuth: "basic" });

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      const expected = `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`;
      expect(headers.Authorization).toBe(expected);

      const body = new URLSearchParams(init?.body as string);
      expect(body.get("client_id")).toBeNull();
      expect(body.get("client_secret")).toBeNull();
      expect(body.get("grant_type")).toBe("authorization_code");

      return new Response(
        JSON.stringify({ access_token: "tok", refresh_token: "r", expires_in: 10 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = new Request(CALLBACK_URL);
    await provider.handleCallback(request, env);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws a clear config error when the client id env var is missing", async () => {
    const env = makeEnv({ GITHUB_CLIENT_ID: "" });
    const provider = oauth2Provider(baseConfig);
    const request = new Request(CALLBACK_URL);
    await expect(provider.handleCallback(request, env)).rejects.toThrow(/GITHUB_CLIENT_ID/);
  });

  it("requireRefreshToken: false allows handleCallback to succeed without a refresh_token", async () => {
    const env = makeEnv();
    const provider = oauth2Provider({ ...baseConfig, requireRefreshToken: false });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 10 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );

    const request = new Request(CALLBACK_URL);
    const result = await provider.handleCallback(request, env);
    expect(result.data.access_token).toBe("tok");
  });

  it("extractTokens can rename fields; the factory re-attaches access_token onto returned data", async () => {
    const env = makeEnv();
    const provider = oauth2Provider({
      ...baseConfig,
      extractTokens: (json: any) => ({
        access_token: json.token,
        refresh_token: json.refresh,
        expires_in: json.ttl,
      }),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ token: "renamed-tok", refresh: "renamed-refresh", ttl: 99 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const request = new Request(CALLBACK_URL);
    const result = await provider.handleCallback(request, env);
    expect(result.refreshToken).toBe("renamed-refresh");
    expect(result.data.access_token).toBe("renamed-tok");
    expect(result.data.token).toBe("renamed-tok");
  });

  it("refreshToken uses extractTokens too, and omits newRefreshToken when absent", async () => {
    const env = makeEnv();
    const provider = oauth2Provider({
      ...baseConfig,
      extractTokens: (json: any) => ({ access_token: json.token, expires_in: json.ttl }),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ token: "new-tok", ttl: 42 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );

    const result = await provider.refreshToken("old-refresh", env);
    expect(result.token).toBe("new-tok");
    expect(result.expires_in).toBe(42);
    expect(result.newRefreshToken).toBeUndefined();
  });

  it("describeLink delegates to the configured function", async () => {
    const env = makeEnv();
    const describeLink = vi.fn(async () => ({ x: "y" }));
    const provider = oauth2Provider({ ...baseConfig, describeLink });

    const result = await provider.describeLink!("tok", env);
    expect(result).toEqual({ x: "y" });
    expect(describeLink).toHaveBeenCalledWith("tok", env);
  });

  it("has no describeLink when not configured", () => {
    const provider = oauth2Provider(baseConfig);
    expect(provider.describeLink).toBeUndefined();
  });
});
