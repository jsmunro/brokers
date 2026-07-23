import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeEnv, makeKvStub } from "./helpers";

vi.mock("../src/access", () => ({
  verifyAccessJwt: vi.fn(async (jwt: string) => {
    if (jwt === "valid-jwt") {
      return { email: "user@example.com" };
    }
    throw new Error("invalid");
  }),
}));

import worker from "../src/index";

describe("router fetch", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 401 JSON when the Access header is missing", async () => {
    const env = makeEnv();
    const request = new Request("https://broker.jsmunro.me/get-token/github");
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "Unauthorized: Cloudflare Access Required" });
  });

  it("returns 403 JSON when the Access JWT is invalid", async () => {
    const env = makeEnv();
    const request = new Request("https://broker.jsmunro.me/get-token/github", {
      headers: { "Cf-Access-Jwt-Assertion": "bad-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: "Invalid Access token" });
  });

  it("returns 404 JSON for an unsupported provider", async () => {
    const env = makeEnv();
    const request = new Request("https://broker.jsmunro.me/get-token/nope", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "Unsupported provider: nope" });
  });

  it("returns 404 text for an unknown action", async () => {
    const env = makeEnv();
    const request = new Request("https://broker.jsmunro.me/frobnicate/github", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toBe("Endpoint Not Found");
  });

  it("get-token returns setup_required when no refresh token is stored", async () => {
    const env = makeEnv();
    const request = new Request("https://broker.jsmunro.me/get-token/github", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.setup_required).toBe(true);
    expect(body.url).toContain("https://github.com/login/oauth/authorize");
  });

  it("callback happy path stores the refresh token and returns an HTML success page", async () => {
    const env = makeEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            access_token: "gho_token",
            refresh_token: "ghr_refresh",
            expires_in: 28800,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const request = new Request("https://broker.jsmunro.me/callback/github?code=abc123", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("GITHUB Linked!");

    const stored = await env.AUTH_TOKENS.get("refresh:github:user@example.com");
    expect(stored).toBe("ghr_refresh");
  });

  it("callback failure returns 400 text with the error message", async () => {
    const env = makeEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: "bad_verification_code", error_description: "bad code" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );

    const request = new Request("https://broker.jsmunro.me/callback/github?code=bad", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toBe("Callback Failed: bad code");
  });

  it("get-token refresh happy path returns token and persists rotated refresh token", async () => {
    const env = makeEnv();
    await env.AUTH_TOKENS.put("refresh:github:user@example.com", "ghr_old");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            access_token: "gho_new",
            expires_in: 28800,
            refresh_token: "ghr_new",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const request = new Request("https://broker.jsmunro.me/get-token/github", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.token).toBe("gho_new");
    expect(body.expires_in).toBe(28800);

    const stored = await env.AUTH_TOKENS.get("refresh:github:user@example.com");
    expect(stored).toBe("ghr_new");
  });

  it("get-token refresh failure clears the KV entry and returns setup_required", async () => {
    const env = makeEnv();
    await env.AUTH_TOKENS.put("refresh:github:user@example.com", "ghr_old");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: "bad_refresh_token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );

    const request = new Request("https://broker.jsmunro.me/get-token/github", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.setup_required).toBe(true);

    const stored = await env.AUTH_TOKENS.get("refresh:github:user@example.com");
    expect(stored).toBeNull();
  });
});

describe("scheduled cron rotation", () => {
  it("rotates refresh tokens for all stored keys and persists new ones", async () => {
    const env = makeEnv();
    await env.AUTH_TOKENS.put("refresh:github:alice@example.com", "ghr_alice_old");
    await env.AUTH_TOKENS.put("refresh:github:bob@example.com", "ghr_bob_old");

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(init?.body as string);
      const refreshToken = body.get("refresh_token");
      return new Response(
        JSON.stringify({
          access_token: `token-for-${refreshToken}`,
          expires_in: 28800,
          refresh_token: `${refreshToken}-rotated`,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await worker.scheduled({} as any, env, {} as any);

    expect(await env.AUTH_TOKENS.get("refresh:github:alice@example.com")).toBe("ghr_alice_old-rotated");
    expect(await env.AUTH_TOKENS.get("refresh:github:bob@example.com")).toBe("ghr_bob_old-rotated");
  });

  it("logs and continues when a per-key refresh fails, without deleting the key", async () => {
    const env = makeEnv();
    await env.AUTH_TOKENS.put("refresh:github:broken@example.com", "ghr_broken");
    await env.AUTH_TOKENS.put("refresh:github:ok@example.com", "ghr_ok");

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = new URLSearchParams(init?.body as string);
        const refreshToken = body.get("refresh_token");
        if (refreshToken === "ghr_broken") {
          return new Response(JSON.stringify({ error: "bad_refresh_token" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({ access_token: "tok", expires_in: 28800, refresh_token: "ghr_ok_rotated" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    await worker.scheduled({} as any, env, {} as any);

    // The broken key must NOT be deleted by cron (unlike get-token behavior).
    expect(await env.AUTH_TOKENS.get("refresh:github:broken@example.com")).toBe("ghr_broken");
    expect(await env.AUTH_TOKENS.get("refresh:github:ok@example.com")).toBe("ghr_ok_rotated");
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
