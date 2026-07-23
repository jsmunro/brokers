import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareProvider } from "../src/providers/cloudflare";
import { makeEnv } from "./helpers";

describe("CloudflareProvider", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds the authorize URL with client_id, redirect_uri, response_type, state, and scope", () => {
    const env = makeEnv();
    const provider = new CloudflareProvider();
    const authUrl = provider.getAuthUrl(env, "user@example.com");
    const url = new URL(authUrl);

    expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/oauth2/auth");
    expect(url.searchParams.get("client_id")).toBe("cf-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://broker.jsmunro.me/callback/cloudflare");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("scope")).toBe(env.CLOUDFLARE_OAUTH_SCOPES);
  });

  it("handleCallback POSTs the correct params and returns the refresh token", async () => {
    const env = makeEnv();
    const provider = new CloudflareProvider();

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input.toString()).toBe("https://dash.cloudflare.com/oauth2/token");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Accept).toBe("application/json");
      expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");

      const body = new URLSearchParams(init?.body as string);
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("abc123");
      expect(body.get("redirect_uri")).toBe("https://broker.jsmunro.me/callback/cloudflare");
      expect(body.get("client_id")).toBe("cf-client-id");
      expect(body.get("client_secret")).toBe("cf-client-secret");

      return new Response(
        JSON.stringify({
          access_token: "cf_access",
          refresh_token: "cf_refresh",
          expires_in: 3600,
          scope: "offline_access",
          token_type: "bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = new Request("https://broker.jsmunro.me/callback/cloudflare?code=abc123");
    const result = await provider.handleCallback(request, env);

    expect(result.refreshToken).toBe("cf_refresh");
    expect(result.data.access_token).toBe("cf_access");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("handleCallback throws when code parameter is missing", async () => {
    const env = makeEnv();
    const provider = new CloudflareProvider();

    const request = new Request("https://broker.jsmunro.me/callback/cloudflare");
    await expect(provider.handleCallback(request, env)).rejects.toThrow("Missing code parameter");
  });

  it("handleCallback throws with error_description when Cloudflare returns an error", async () => {
    const env = makeEnv();
    const provider = new CloudflareProvider();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "The code is invalid or expired" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const request = new Request("https://broker.jsmunro.me/callback/cloudflare?code=bad");
    await expect(provider.handleCallback(request, env)).rejects.toThrow("The code is invalid or expired");
  });

  it("handleCallback throws when refresh_token is missing", async () => {
    const env = makeEnv();
    const provider = new CloudflareProvider();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ access_token: "cf_access", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );

    const request = new Request("https://broker.jsmunro.me/callback/cloudflare?code=abc123");
    await expect(provider.handleCallback(request, env)).rejects.toThrow(/refresh_token/);
  });

  it("refreshToken POSTs grant_type=refresh_token and returns rotated token", async () => {
    const env = makeEnv();
    const provider = new CloudflareProvider();

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input.toString()).toBe("https://dash.cloudflare.com/oauth2/token");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Accept).toBe("application/json");
      expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");

      const body = new URLSearchParams(init?.body as string);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("cf_old");
      expect(body.get("client_id")).toBe("cf-client-id");
      expect(body.get("client_secret")).toBe("cf-client-secret");

      return new Response(
        JSON.stringify({
          access_token: "cf_new",
          expires_in: 3600,
          refresh_token: "cf_new_refresh",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider.refreshToken("cf_old", env);
    expect(result.token).toBe("cf_new");
    expect(result.expires_in).toBe(3600);
    expect(result.newRefreshToken).toBe("cf_new_refresh");
  });

  it("refreshToken returns undefined newRefreshToken when Cloudflare doesn't rotate it", async () => {
    const env = makeEnv();
    const provider = new CloudflareProvider();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ access_token: "cf_new", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );

    const result = await provider.refreshToken("cf_old", env);
    expect(result.token).toBe("cf_new");
    expect(result.newRefreshToken).toBeUndefined();
  });

  it("refreshToken throws on Cloudflare error response", async () => {
    const env = makeEnv();
    const provider = new CloudflareProvider();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "Refresh token is invalid" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    await expect(provider.refreshToken("cf_old", env)).rejects.toThrow("Refresh token is invalid");
  });
});
