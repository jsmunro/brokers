import { describe, expect, it, vi } from "vitest";
import { makeEnv } from "./helpers";

vi.mock("../src/access", () => ({
  verifyAccessJwt: vi.fn(async (jwt: string) => {
    if (jwt === "valid-jwt") {
      return { email: "user@example.com", exp: 1234567890 };
    }
    if (jwt === "valid-jwt-with-name") {
      return { email: "user@example.com", exp: 1234567890, name: "Jane Doe", idp: { type: "github" } };
    }
    throw new Error("invalid");
  }),
}));

import worker from "../src/index";

describe("GET /", () => {
  it("returns 401 JSON when unauthenticated", async () => {
    const env = makeEnv();
    const request = new Request("https://broker.jsmunro.me/");
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "Unauthorized: Cloudflare Access Required" });
  });

  it("returns 403 JSON for an invalid JWT", async () => {
    const env = makeEnv();
    const request = new Request("https://broker.jsmunro.me/", {
      headers: { "Cf-Access-Jwt-Assertion": "bad-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: "Invalid Access token" });
  });

  it("returns 200 HTML containing provider slugs and an identity element when authed", async () => {
    const env = makeEnv();
    const request = new Request("https://broker.jsmunro.me/", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("github");
    expect(html).toContain("cloudflare");
    expect(html).toContain('id="identity"');
  });
});

describe("GET /api/me", () => {
  it("returns email and exp from the JWT", async () => {
    const env = makeEnv();
    const request = new Request("https://broker.jsmunro.me/api/me", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.email).toBe("user@example.com");
    expect(body.exp).toBe(1234567890);
    expect(body.name).toBeUndefined();
    expect(body.idp).toBeUndefined();
  });

  it("includes name and idp only when claimed", async () => {
    const env = makeEnv();
    const request = new Request("https://broker.jsmunro.me/api/me", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt-with-name" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.name).toBe("Jane Doe");
    expect(body.idp).toBe("github");
  });

  it("401 when unauthenticated", async () => {
    const env = makeEnv();
    const request = new Request("https://broker.jsmunro.me/api/me");
    const res = await worker.fetch(request, env, {} as any);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/links", () => {
  it("lists linked-with-meta github and unlinked cloudflare", async () => {
    const env = makeEnv();
    await env.AUTH_TOKENS.put("refresh:github:user@example.com", "ghr_token");
    await env.AUTH_TOKENS.put(
      "meta:github:user@example.com",
      JSON.stringify({
        linked_at: "2026-01-01T00:00:00.000Z",
        last_refreshed: "2026-01-02T00:00:00.000Z",
        details: { login: "octocat" },
      })
    );

    const request = new Request("https://broker.jsmunro.me/api/links", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];

    const github = body.find((e) => e.slug === "github");
    expect(github.linked).toBe(true);
    expect(github.details).toEqual({ login: "octocat" });
    expect(github.linked_at).toBe("2026-01-01T00:00:00.000Z");
    expect(github.last_refreshed).toBe("2026-01-02T00:00:00.000Z");
    expect(github.auth_url).toBeUndefined();

    const cloudflare = body.find((e) => e.slug === "cloudflare");
    expect(cloudflare.linked).toBe(false);
    expect(cloudflare.auth_url).toContain("https://dash.cloudflare.com/oauth2/auth");
    expect(cloudflare.details).toBeUndefined();
  });

  it("linked without meta reports linked:true with no details", async () => {
    const env = makeEnv();
    await env.AUTH_TOKENS.put("refresh:github:user@example.com", "ghr_token");

    const request = new Request("https://broker.jsmunro.me/api/links", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    const body = (await res.json()) as any[];
    const github = body.find((e) => e.slug === "github");
    expect(github.linked).toBe(true);
    expect(github.details).toBeUndefined();
    expect(github.linked_at).toBeUndefined();
    expect(github.auth_url).toBeUndefined();
  });

  it("401 when unauthenticated", async () => {
    const env = makeEnv();
    const request = new Request("https://broker.jsmunro.me/api/links");
    const res = await worker.fetch(request, env, {} as any);
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/links/<provider>", () => {
  it("deletes both KV keys and returns ok:true", async () => {
    const env = makeEnv();
    await env.AUTH_TOKENS.put("refresh:github:user@example.com", "ghr_token");
    await env.AUTH_TOKENS.put(
      "meta:github:user@example.com",
      JSON.stringify({ linked_at: "2026-01-01T00:00:00.000Z" })
    );

    const request = new Request("https://broker.jsmunro.me/api/links/github", {
      method: "DELETE",
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toEqual({ ok: true });

    expect(await env.AUTH_TOKENS.get("refresh:github:user@example.com")).toBeNull();
    expect(await env.AUTH_TOKENS.get("meta:github:user@example.com")).toBeNull();
  });

  it("returns 404 unsupported-provider shape for an unknown slug", async () => {
    const env = makeEnv();
    const request = new Request("https://broker.jsmunro.me/api/links/nope", {
      method: "DELETE",
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "Unsupported provider: nope" });
  });

  it("is idempotent: unlinking an already-unlinked provider still returns ok:true", async () => {
    const env = makeEnv();
    const request = new Request("https://broker.jsmunro.me/api/links/github", {
      method: "DELETE",
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toEqual({ ok: true });
  });

  it("401 when unauthenticated", async () => {
    const env = makeEnv();
    const request = new Request("https://broker.jsmunro.me/api/links/github", { method: "DELETE" });
    const res = await worker.fetch(request, env, {} as any);
    expect(res.status).toBe(401);
  });
});

describe("callback success page", () => {
  it("links back to the dashboard", async () => {
    const env = makeEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ access_token: "gho_token", refresh_token: "ghr_refresh", expires_in: 28800 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const request = new Request("https://broker.jsmunro.me/callback/github?code=abc123", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);
    const text = await res.text();
    expect(text).toContain('<a href="/">Back to dashboard</a>');
  });
});
