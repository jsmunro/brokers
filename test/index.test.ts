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

import worker, { metaKey, writeMeta } from "../src/index";

describe("router fetch", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 401 JSON when the Access header is missing", async () => {
    const env = makeEnv();
    const request = new Request("https://broker.jsmunro.me/get-token/github/jsmunro/Iv23lifj0i4aV6qYR76i");
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "Unauthorized: Cloudflare Access Required" });
  });

  it("returns 403 JSON when the Access JWT is invalid", async () => {
    const env = makeEnv();
    const request = new Request("https://broker.jsmunro.me/get-token/github/jsmunro/Iv23lifj0i4aV6qYR76i", {
      headers: { "Cf-Access-Jwt-Assertion": "bad-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: "Invalid Access token" });
  });

  it("returns 401 JSON for an unsupported provider when unauthenticated (auth checked before routing)", async () => {
    const env = makeEnv();
    const request = new Request("https://broker.jsmunro.me/get-token/nope");
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "Unauthorized: Cloudflare Access Required" });
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

  it("returns 404 JSON for an unsupported provider with a full 3-part slug", async () => {
    const env = makeEnv();
    const request = new Request("https://broker.jsmunro.me/get-token/github/unknown-org/xyz", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "Unsupported provider: github/unknown-org/xyz" });
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
    const request = new Request("https://broker.jsmunro.me/get-token/github/jsmunro/Iv23lifj0i4aV6qYR76i", {
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

    const request = new Request("https://broker.jsmunro.me/callback/github/jsmunro/Iv23lifj0i4aV6qYR76i?code=abc123", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("GITHUB/JSMUNRO/IV23LIFJ0I4AV6QYR76I Linked!");

    const stored = await env.AUTH_TOKENS.get("refresh:github/jsmunro/Iv23lifj0i4aV6qYR76i:user@example.com");
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

    const request = new Request("https://broker.jsmunro.me/callback/github/jsmunro/Iv23lifj0i4aV6qYR76i?code=bad", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toBe("Callback Failed: bad code");
  });

  it("get-token refresh happy path returns token and persists rotated refresh token", async () => {
    const env = makeEnv();
    await env.AUTH_TOKENS.put("refresh:github/jsmunro/Iv23lifj0i4aV6qYR76i:user@example.com", "ghr_old");

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

    const request = new Request("https://broker.jsmunro.me/get-token/github/jsmunro/Iv23lifj0i4aV6qYR76i", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.token).toBe("gho_new");
    expect(body.expires_in).toBe(28800);

    const stored = await env.AUTH_TOKENS.get("refresh:github/jsmunro/Iv23lifj0i4aV6qYR76i:user@example.com");
    expect(stored).toBe("ghr_new");
  });

  it("get-token refresh failure clears the KV entry and returns setup_required", async () => {
    const env = makeEnv();
    await env.AUTH_TOKENS.put("refresh:github/jsmunro/Iv23lifj0i4aV6qYR76i:user@example.com", "ghr_old");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: "bad_refresh_token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );

    const request = new Request("https://broker.jsmunro.me/get-token/github/jsmunro/Iv23lifj0i4aV6qYR76i", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.setup_required).toBe(true);

    const stored = await env.AUTH_TOKENS.get("refresh:github/jsmunro/Iv23lifj0i4aV6qYR76i:user@example.com");
    expect(stored).toBeNull();
  });

  it("get-token refresh failure deletes both the refresh key and the meta key", async () => {
    const env = makeEnv();
    await env.AUTH_TOKENS.put("refresh:github/jsmunro/Iv23lifj0i4aV6qYR76i:user@example.com", "ghr_old");
    await env.AUTH_TOKENS.put(
      "meta:github/jsmunro/Iv23lifj0i4aV6qYR76i:user@example.com",
      JSON.stringify({ linked_at: "2026-01-01T00:00:00.000Z" })
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: "bad_refresh_token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );

    const request = new Request("https://broker.jsmunro.me/get-token/github/jsmunro/Iv23lifj0i4aV6qYR76i", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(200);
    expect(await env.AUTH_TOKENS.get("refresh:github/jsmunro/Iv23lifj0i4aV6qYR76i:user@example.com")).toBeNull();
    expect(await env.AUTH_TOKENS.get("meta:github/jsmunro/Iv23lifj0i4aV6qYR76i:user@example.com")).toBeNull();
  });

  it("callback success writes meta with linked_at and details when describeLink succeeds", async () => {
    const env = makeEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url === "https://github.com/login/oauth/access_token") {
          return new Response(
            JSON.stringify({ access_token: "gho_token", refresh_token: "ghr_refresh", expires_in: 28800 }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url === "https://api.github.com/user") {
          return new Response(JSON.stringify({ login: "octocat", id: 123, name: "Mona Lisa" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const request = new Request("https://broker.jsmunro.me/callback/github/jsmunro/Iv23lifj0i4aV6qYR76i?code=abc123", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);
    expect(res.status).toBe(200);

    const meta = (await env.AUTH_TOKENS.get("meta:github/jsmunro/Iv23lifj0i4aV6qYR76i:user@example.com", "json")) as any;
    expect(meta.linked_at).toBeTruthy();
    expect(meta.details).toEqual({ login: "octocat", id: "123", name: "Mona Lisa" });
  });

  it("callback still succeeds and stores the refresh token when describeLink rejects", async () => {
    const env = makeEnv();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url === "https://github.com/login/oauth/access_token") {
          return new Response(
            JSON.stringify({ access_token: "gho_token", refresh_token: "ghr_refresh", expires_in: 28800 }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url === "https://api.github.com/user") {
          return new Response("Unauthorized", { status: 401 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const request = new Request("https://broker.jsmunro.me/callback/github/jsmunro/Iv23lifj0i4aV6qYR76i?code=abc123", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(200);
    expect(await env.AUTH_TOKENS.get("refresh:github/jsmunro/Iv23lifj0i4aV6qYR76i:user@example.com")).toBe("ghr_refresh");

    const meta = (await env.AUTH_TOKENS.get("meta:github/jsmunro/Iv23lifj0i4aV6qYR76i:user@example.com", "json")) as any;
    expect(meta.linked_at).toBeTruthy();
    expect(meta.details).toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("callback writes meta without details when the token response omits access_token", async () => {
    const env = makeEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url === "https://github.com/login/oauth/access_token") {
          return new Response(JSON.stringify({ refresh_token: "ghr_refresh", expires_in: 28800 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const request = new Request("https://broker.jsmunro.me/callback/github/jsmunro/Iv23lifj0i4aV6qYR76i?code=abc123", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(200);
    const meta = (await env.AUTH_TOKENS.get("meta:github/jsmunro/Iv23lifj0i4aV6qYR76i:user@example.com", "json")) as any;
    expect(meta.linked_at).toBeTruthy();
    expect(meta.details).toBeUndefined();
  });

  it("get-token refresh success updates last_refreshed while preserving linked_at and details", async () => {
    const env = makeEnv();
    await env.AUTH_TOKENS.put("refresh:github/jsmunro/Iv23lifj0i4aV6qYR76i:user@example.com", "ghr_old");
    await env.AUTH_TOKENS.put(
      "meta:github/jsmunro/Iv23lifj0i4aV6qYR76i:user@example.com",
      JSON.stringify({ linked_at: "2026-01-01T00:00:00.000Z", details: { login: "octocat" } })
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ access_token: "gho_new", expires_in: 28800, refresh_token: "ghr_new" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const request = new Request("https://broker.jsmunro.me/get-token/github/jsmunro/Iv23lifj0i4aV6qYR76i", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(200);
    const meta = (await env.AUTH_TOKENS.get("meta:github/jsmunro/Iv23lifj0i4aV6qYR76i:user@example.com", "json")) as any;
    expect(meta.linked_at).toBe("2026-01-01T00:00:00.000Z");
    expect(meta.details).toEqual({ login: "octocat" });
    expect(meta.last_refreshed).toBeTruthy();
  });

  it("get-token refresh success creates a meta key when none existed before", async () => {
    const env = makeEnv();
    await env.AUTH_TOKENS.put("refresh:github/jsmunro/Iv23lifj0i4aV6qYR76i:user@example.com", "ghr_old");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ access_token: "gho_new", expires_in: 28800, refresh_token: "ghr_new" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const request = new Request("https://broker.jsmunro.me/get-token/github/jsmunro/Iv23lifj0i4aV6qYR76i", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(200);
    const meta = (await env.AUTH_TOKENS.get("meta:github/jsmunro/Iv23lifj0i4aV6qYR76i:user@example.com", "json")) as any;
    expect(meta.linked_at).toBeTruthy();
    expect(meta.last_refreshed).toBeTruthy();
  });
});

describe("metaKey / writeMeta helpers", () => {
  it("metaKey builds the meta:<slug>:<userId> KV key from a full multi-segment slug", () => {
    expect(metaKey("github/jsmunro/Iv23lifj0i4aV6qYR76i", "user@example.com")).toBe(
      "meta:github/jsmunro/Iv23lifj0i4aV6qYR76i:user@example.com"
    );
  });

  it("writeMeta writes meta without details when the provider has no describeLink method", async () => {
    const env = makeEnv();
    const fakeProvider = {
      slug: "fake",
      getAuthUrl: () => "https://example.com/auth",
      handleCallback: async () => ({ refreshToken: "x", data: {} }),
      refreshToken: async () => ({ token: "x" }),
    };

    await writeMeta(env, fakeProvider as any, "user@example.com", { access_token: "tok" });

    const meta = (await env.AUTH_TOKENS.get(metaKey("fake", "user@example.com"), "json")) as any;
    expect(meta.linked_at).toBeTruthy();
    expect(meta.details).toBeUndefined();
  });

  it("writeMeta never throws when the KV put itself fails", async () => {
    const env = makeEnv();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    (env.AUTH_TOKENS.put as any) = vi.fn(async () => {
      throw new Error("kv unavailable");
    });

    const fakeProvider = {
      slug: "fake",
      getAuthUrl: () => "",
      handleCallback: async () => ({ refreshToken: "x", data: {} }),
      refreshToken: async () => ({ token: "x" }),
    };

    await expect(
      writeMeta(env, fakeProvider as any, "user@example.com", { access_token: "tok" })
    ).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});

describe("scheduled cron rotation", () => {
  it("rotates refresh tokens for all stored keys and persists new ones", async () => {
    const env = makeEnv();
    await env.AUTH_TOKENS.put("refresh:github/jsmunro/Iv23lifj0i4aV6qYR76i:alice@example.com", "ghr_alice_old");
    await env.AUTH_TOKENS.put("refresh:github/jsmunro/Iv23lifj0i4aV6qYR76i:bob@example.com", "ghr_bob_old");

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

    expect(await env.AUTH_TOKENS.get("refresh:github/jsmunro/Iv23lifj0i4aV6qYR76i:alice@example.com")).toBe("ghr_alice_old-rotated");
    expect(await env.AUTH_TOKENS.get("refresh:github/jsmunro/Iv23lifj0i4aV6qYR76i:bob@example.com")).toBe("ghr_bob_old-rotated");
  });

  it("logs and continues when a per-key refresh fails, without deleting the key", async () => {
    const env = makeEnv();
    await env.AUTH_TOKENS.put("refresh:github/jsmunro/Iv23lifj0i4aV6qYR76i:broken@example.com", "ghr_broken");
    await env.AUTH_TOKENS.put("refresh:github/jsmunro/Iv23lifj0i4aV6qYR76i:ok@example.com", "ghr_ok");

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
    expect(await env.AUTH_TOKENS.get("refresh:github/jsmunro/Iv23lifj0i4aV6qYR76i:broken@example.com")).toBe("ghr_broken");
    expect(await env.AUTH_TOKENS.get("refresh:github/jsmunro/Iv23lifj0i4aV6qYR76i:ok@example.com")).toBe("ghr_ok_rotated");
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("updates last_refreshed in the meta key on successful cron refresh", async () => {
    const env = makeEnv();
    await env.AUTH_TOKENS.put("refresh:github/jsmunro/Iv23lifj0i4aV6qYR76i:alice@example.com", "ghr_alice_old");
    await env.AUTH_TOKENS.put(
      "meta:github/jsmunro/Iv23lifj0i4aV6qYR76i:alice@example.com",
      JSON.stringify({ linked_at: "2026-01-01T00:00:00.000Z" })
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ access_token: "tok", expires_in: 28800, refresh_token: "ghr_alice_new" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    await worker.scheduled({} as any, env, {} as any);

    const meta = (await env.AUTH_TOKENS.get("meta:github/jsmunro/Iv23lifj0i4aV6qYR76i:alice@example.com", "json")) as any;
    expect(meta.linked_at).toBe("2026-01-01T00:00:00.000Z");
    expect(meta.last_refreshed).toBeTruthy();
  });
});
