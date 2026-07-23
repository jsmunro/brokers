import { beforeEach, describe, expect, it, vi } from "vitest";
import { apps, GITHUB_SLUG } from "../src/registry";
import { providerContractTests } from "./contract";
import { makeEnv } from "./helpers";

const provider = apps[GITHUB_SLUG]!;
const CALLBACK_URL = `https://broker.jsmunro.me/callback/${GITHUB_SLUG}?code=abc123`;

describe("GitHub app (factory-built)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  providerContractTests("github", () => apps[GITHUB_SLUG]!, {
    env: makeEnv(),
    authorizeUrl: "https://github.com/login/oauth/authorize",
    callbackRequestUrl: CALLBACK_URL,
    tokenExchangeResponse: {
      access_token: "gho_token",
      refresh_token: "ghr_refresh",
      expires_in: 28800,
      refresh_token_expires_in: 15897600,
      token_type: "bearer",
    },
    expectedRefreshToken: "ghr_refresh",
    expectedAccessToken: "gho_token",
    refreshResponse: {
      access_token: "gho_new",
      expires_in: 28800,
      refresh_token: "ghr_new",
      refresh_token_expires_in: 15897600,
    },
    expectedRefreshedToken: "gho_new",
  });

  it("builds the authorize URL with client_id, redirect_uri (3-part), and state", () => {
    const env = makeEnv();
    const authUrl = provider.getAuthUrl(env, "user@example.com");
    const url = new URL(authUrl);

    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("Iv23test");
    expect(url.searchParams.get("redirect_uri")).toBe(`https://broker.jsmunro.me/callback/${GITHUB_SLUG}`);
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("handleCallback POSTs the correct params and returns the refresh token", async () => {
    const env = makeEnv();

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input.toString()).toBe("https://github.com/login/oauth/access_token");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Accept).toBe("application/json");

      const body = new URLSearchParams(init?.body as string);
      expect(body.get("client_id")).toBe("Iv23test");
      expect(body.get("client_secret")).toBe("test-secret");
      expect(body.get("code")).toBe("abc123");
      expect(body.get("redirect_uri")).toBe(`https://broker.jsmunro.me/callback/${GITHUB_SLUG}`);

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

    const request = new Request(CALLBACK_URL);
    const result = await provider.handleCallback(request, env);

    expect(result.refreshToken).toBe("ghr_refresh");
    expect(result.data.access_token).toBe("gho_token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("handleCallback throws when GitHub returns an error", async () => {
    const env = makeEnv();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ error: "bad_verification_code", error_description: "The code is invalid" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const request = new Request(CALLBACK_URL);
    await expect(provider.handleCallback(request, env)).rejects.toThrow("The code is invalid");
  });

  it("handleCallback throws when refresh_token is missing", async () => {
    const env = makeEnv();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ access_token: "gho_token", expires_in: 28800 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );

    const request = new Request(CALLBACK_URL);
    await expect(provider.handleCallback(request, env)).rejects.toThrow(/refresh_token/);
  });

  it("refreshToken POSTs grant_type=refresh_token and returns rotated token", async () => {
    const env = makeEnv();

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

  describe("describeLink", () => {
    it("calls GitHub /user with bearer auth and returns login/name/id as strings", async () => {
      const env = makeEnv();

      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input.toString()).toBe("https://api.github.com/user");
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe("Bearer gho_token");
        expect(headers.Accept).toBe("application/vnd.github+json");
        expect(headers["User-Agent"]).toBeTruthy();

        return new Response(JSON.stringify({ login: "octocat", id: 123, name: "Mona Lisa" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await provider.describeLink!("gho_token", env);
      expect(result).toEqual({ login: "octocat", id: "123", name: "Mona Lisa" });
    });

    it("omits a null name field", async () => {
      const env = makeEnv();

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          return new Response(JSON.stringify({ login: "octocat", id: 123, name: null }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        })
      );

      const result = await provider.describeLink!("gho_token", env);
      expect(result).toEqual({ login: "octocat", id: "123" });
      expect(result.name).toBeUndefined();
    });

    it("throws on a non-2xx response", async () => {
      const env = makeEnv();

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          return new Response("Unauthorized", { status: 401 });
        })
      );

      await expect(provider.describeLink!("bad_token", env)).rejects.toThrow();
    });
  });
});
