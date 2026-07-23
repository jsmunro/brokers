import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubProvider } from "../src/providers/github";
import { makeEnv } from "./helpers";

describe("GitHubProvider", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds the authorize URL with client_id, redirect_uri, and state", () => {
    const env = makeEnv();
    const provider = new GitHubProvider();
    const authUrl = provider.getAuthUrl(env, "user@example.com");
    const url = new URL(authUrl);

    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("Iv23test");
    expect(url.searchParams.get("redirect_uri")).toBe("https://broker.jsmunro.me/callback/github");
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("handleCallback POSTs the correct params and returns the refresh token", async () => {
    const env = makeEnv();
    const provider = new GitHubProvider();

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input.toString()).toBe("https://github.com/login/oauth/access_token");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Accept).toBe("application/json");

      const body = new URLSearchParams(init?.body as string);
      expect(body.get("client_id")).toBe("Iv23test");
      expect(body.get("client_secret")).toBe("test-secret");
      expect(body.get("code")).toBe("abc123");
      expect(body.get("redirect_uri")).toBe("https://broker.jsmunro.me/callback/github");

      return new Response(
        JSON.stringify({
          access_token: "gho_token",
          refresh_token: "ghr_refresh",
          expires_in: 28800,
          refresh_token_expires_in: 15897600,
          token_type: "bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = new Request("https://broker.jsmunro.me/callback/github?code=abc123");
    const result = await provider.handleCallback(request, env);

    expect(result.refreshToken).toBe("ghr_refresh");
    expect(result.data.access_token).toBe("gho_token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("handleCallback throws when GitHub returns an error", async () => {
    const env = makeEnv();
    const provider = new GitHubProvider();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ error: "bad_verification_code", error_description: "The code is invalid" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const request = new Request("https://broker.jsmunro.me/callback/github?code=bad");
    await expect(provider.handleCallback(request, env)).rejects.toThrow("The code is invalid");
  });

  it("handleCallback throws when refresh_token is missing", async () => {
    const env = makeEnv();
    const provider = new GitHubProvider();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ access_token: "gho_token", expires_in: 28800 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );

    const request = new Request("https://broker.jsmunro.me/callback/github?code=abc123");
    await expect(provider.handleCallback(request, env)).rejects.toThrow(/refresh_token/);
  });

  it("refreshToken POSTs grant_type=refresh_token and returns rotated token", async () => {
    const env = makeEnv();
    const provider = new GitHubProvider();

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input.toString()).toBe("https://github.com/login/oauth/access_token");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Accept).toBe("application/json");

      const body = new URLSearchParams(init?.body as string);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("ghr_old");
      expect(body.get("client_id")).toBe("Iv23test");
      expect(body.get("client_secret")).toBe("test-secret");

      return new Response(
        JSON.stringify({
          access_token: "gho_new",
          expires_in: 28800,
          refresh_token: "ghr_new",
          refresh_token_expires_in: 15897600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider.refreshToken("ghr_old", env);
    expect(result.token).toBe("gho_new");
    expect(result.expires_in).toBe(28800);
    expect(result.newRefreshToken).toBe("ghr_new");
  });

  it("refreshToken throws on GitHub error response", async () => {
    const env = makeEnv();
    const provider = new GitHubProvider();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: "bad_refresh_token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );

    await expect(provider.refreshToken("ghr_old", env)).rejects.toThrow("bad_refresh_token");
  });
});
