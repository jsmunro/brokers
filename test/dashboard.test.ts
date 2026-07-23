import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// Every route now goes through handleMe's best-effort get-identity enrichment
// on /api/me. Default to a rejecting stub so unrelated tests never hit the
// real network; tests that care about get-identity install their own stub.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network disabled in tests");
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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
    expect(html).toContain("renderDeviceSection");
  });
});

describe("renderDeviceSection (inline client script)", () => {
  // The identity card's device/session section is rendered client-side from
  // `/api/me`'s `device` field. Extract the function from the served page and
  // exercise it directly rather than executing a full browser DOM.
  function extractRenderDeviceSection(html: string): (device: any) => string {
    const start = html.indexOf("function renderDeviceSection");
    const end = html.indexOf("\nasync function loadIdentity");
    const src = html.slice(start, end);
    const esc = (s: unknown) =>
      String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    // eslint-disable-next-line no-new-func
    return new Function("esc", `${src}\nreturn renderDeviceSection;`)(esc);
  }

  it("renders nothing when device is absent", async () => {
    const env = makeEnv();
    const request = new Request("https://broker.jsmunro.me/", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);
    const html = await res.text();
    const render = extractRenderDeviceSection(html);

    expect(render(undefined)).toBe("");
  });

  it("renders IdP, IP/country, WARP/Gateway pills, and posture rows when device is present", async () => {
    const env = makeEnv();
    const request = new Request("https://broker.jsmunro.me/", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);
    const html = await res.text();
    const render = extractRenderDeviceSection(html);

    const out = render({
      idp: "onetimepin",
      ip: "203.0.113.7",
      country: "AU",
      is_warp: true,
      is_gateway: false,
      posture: [{ rule: "Minimum OS", type: "os_version", success: true }],
    });

    expect(out).toContain("Device &amp; session");
    expect(out).toContain("onetimepin");
    expect(out).toContain("203.0.113.7");
    expect(out).toContain("AU");
    expect(out).toContain("On");
    expect(out).toContain("Off");
    expect(out).toContain("Minimum OS");
    expect(out).toContain("✓");
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
    expect(body.device).toBeUndefined();
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

describe("GET /api/me device enrichment", () => {
  const fullIdentity = {
    id: "identity-id",
    name: "Jane Doe",
    email: "user@example.com",
    idp: { id: "idp-id", type: "onetimepin" },
    geo: { country: "AU" },
    ip: "203.0.113.7",
    devicePosture: {
      "uuid-1": { type: "os_version", rule_name: "Minimum OS", success: true },
      "uuid-2": { type: "disk_encryption", rule_name: "Disk Encrypted", success: false },
    },
    is_warp: true,
    is_gateway: false,
    device_sessions: { "session-1": {}, "session-2": {} },
  };

  it("calls get-identity with the request's CF_Authorization cookie taking precedence over the header", async () => {
    const env = makeEnv();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input.toString()).toBe(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/get-identity`);
      const headers = init?.headers as Record<string, string>;
      expect(headers.Cookie).toBe("CF_Authorization=cookie-value");
      return new Response(JSON.stringify(fullIdentity), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = new Request("https://broker.jsmunro.me/api/me", {
      headers: {
        "Cf-Access-Jwt-Assertion": "valid-jwt",
        Cookie: "CF_Authorization=cookie-value; other=1",
      },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the Cf-Access-Jwt-Assertion header as the cookie value when no cookie header is present", async () => {
    const env = makeEnv();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Cookie).toBe("CF_Authorization=valid-jwt");
      return new Response(JSON.stringify(fullIdentity), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = new Request("https://broker.jsmunro.me/api/me", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("curates the get-identity response into the documented device subset", async () => {
    const env = makeEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify(fullIdentity), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );

    const request = new Request("https://broker.jsmunro.me/api/me", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);
    const body = (await res.json()) as any;

    expect(body.device).toEqual({
      idp: "onetimepin",
      ip: "203.0.113.7",
      country: "AU",
      is_warp: true,
      is_gateway: false,
      posture: [
        { rule: "Minimum OS", type: "os_version", success: true },
        { rule: "Disk Encrypted", type: "disk_encryption", success: false },
      ],
      sessions_count: 2,
    });
  });

  it("omits fields that are absent or wrong-typed in the source, and never forwards the raw blob", async () => {
    const env = makeEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            id: "identity-id",
            email: "user@example.com",
            ip: 12345, // wrong type -> omit
            geo: {}, // no country -> omit
            devicePosture: {}, // empty -> omit
            device_sessions: {}, // no keys -> omit
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const request = new Request("https://broker.jsmunro.me/api/me", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);
    const body = (await res.json()) as any;

    expect(body.device).toEqual({});
    expect(body.device.ip).toBeUndefined();
    expect(body.device.country).toBeUndefined();
    expect(body.device.posture).toBeUndefined();
    expect(body.device.sessions_count).toBeUndefined();
    expect(body.device.id).toBeUndefined();
    expect(body.device.email).toBeUndefined();
  });

  it("returns exactly the base shape (no device field) when get-identity errors", async () => {
    const env = makeEnv();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network error");
      })
    );

    const request = new Request("https://broker.jsmunro.me/api/me", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toEqual({ email: "user@example.com", exp: 1234567890 });
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("returns exactly the base shape (no device field) when get-identity responds non-2xx", async () => {
    const env = makeEnv();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response("forbidden", { status: 403 });
      })
    );

    const request = new Request("https://broker.jsmunro.me/api/me", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toEqual({ email: "user@example.com", exp: 1234567890 });
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

describe("GET /api/links", () => {
  it("lists linked-with-meta github and unlinked cloudflare", async () => {
    const env = makeEnv();
    await env.AUTH_TOKENS.put("refresh:github/jsmunro/Iv23lifj0i4aV6qYR76i:user@example.com", "ghr_token");
    await env.AUTH_TOKENS.put(
      "meta:github/jsmunro/Iv23lifj0i4aV6qYR76i:user@example.com",
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

    const github = body.find((e) => e.slug === "github/jsmunro/Iv23lifj0i4aV6qYR76i");
    expect(github.linked).toBe(true);
    expect(github.details).toEqual({ login: "octocat" });
    expect(github.linked_at).toBe("2026-01-01T00:00:00.000Z");
    expect(github.last_refreshed).toBe("2026-01-02T00:00:00.000Z");
    expect(github.auth_url).toBeUndefined();

    const cloudflare = body.find((e) => e.slug === "cloudflare/jackm/9f2c965eeb2fcc390fc3843935de35bc");
    expect(cloudflare.linked).toBe(false);
    expect(cloudflare.auth_url).toContain("https://dash.cloudflare.com/oauth2/auth");
    expect(cloudflare.details).toBeUndefined();
  });

  it("linked without meta reports linked:true with no details", async () => {
    const env = makeEnv();
    await env.AUTH_TOKENS.put("refresh:github/jsmunro/Iv23lifj0i4aV6qYR76i:user@example.com", "ghr_token");

    const request = new Request("https://broker.jsmunro.me/api/links", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    const body = (await res.json()) as any[];
    const github = body.find((e) => e.slug === "github/jsmunro/Iv23lifj0i4aV6qYR76i");
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
    await env.AUTH_TOKENS.put("refresh:github/jsmunro/Iv23lifj0i4aV6qYR76i:user@example.com", "ghr_token");
    await env.AUTH_TOKENS.put(
      "meta:github/jsmunro/Iv23lifj0i4aV6qYR76i:user@example.com",
      JSON.stringify({ linked_at: "2026-01-01T00:00:00.000Z" })
    );

    const request = new Request("https://broker.jsmunro.me/api/links/github/jsmunro/Iv23lifj0i4aV6qYR76i", {
      method: "DELETE",
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toEqual({ ok: true });

    expect(await env.AUTH_TOKENS.get("refresh:github/jsmunro/Iv23lifj0i4aV6qYR76i:user@example.com")).toBeNull();
    expect(await env.AUTH_TOKENS.get("meta:github/jsmunro/Iv23lifj0i4aV6qYR76i:user@example.com")).toBeNull();
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

  it("returns 404 unsupported-provider shape for an unknown 3-part slug", async () => {
    const env = makeEnv();
    const request = new Request("https://broker.jsmunro.me/api/links/github/unknown-org/xyz", {
      method: "DELETE",
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "Unsupported provider: github/unknown-org/xyz" });
  });

  it("is idempotent: unlinking an already-unlinked provider still returns ok:true", async () => {
    const env = makeEnv();
    const request = new Request("https://broker.jsmunro.me/api/links/github/jsmunro/Iv23lifj0i4aV6qYR76i", {
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
    const request = new Request("https://broker.jsmunro.me/api/links/github/jsmunro/Iv23lifj0i4aV6qYR76i", { method: "DELETE" });
    const res = await worker.fetch(request, env, {} as any);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/apps", () => {
  it("lists every registered app with provider/org/client_id derived from the slug", async () => {
    const env = makeEnv();
    const request = new Request("https://broker.jsmunro.me/api/apps", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];

    const github = body.find((e) => e.slug === "github/jsmunro/Iv23lifj0i4aV6qYR76i");
    expect(github).toEqual({
      slug: "github/jsmunro/Iv23lifj0i4aV6qYR76i",
      provider: "github",
      org: "jsmunro",
      client_id: "Iv23lifj0i4aV6qYR76i",
      display_name: "Brokers repo",
    });

    const cloudflare = body.find((e) => e.slug === "cloudflare/jackm/9f2c965eeb2fcc390fc3843935de35bc");
    expect(cloudflare).toEqual({
      slug: "cloudflare/jackm/9f2c965eeb2fcc390fc3843935de35bc",
      provider: "cloudflare",
      org: "jackm",
      client_id: "9f2c965eeb2fcc390fc3843935de35bc",
      display_name: "central-auth-broker",
    });
  });

  it("includes metadata from the KV cache when present", async () => {
    const env = makeEnv();
    await env.AUTH_TOKENS.put(
      "app:github/jsmunro/Iv23lifj0i4aV6qYR76i",
      JSON.stringify({ name: "Brokers App", fetched_at: "2026-01-01T00:00:00.000Z" })
    );

    const request = new Request("https://broker.jsmunro.me/api/apps", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);
    const body = (await res.json()) as any[];

    const github = body.find((e) => e.slug === "github/jsmunro/Iv23lifj0i4aV6qYR76i");
    expect(github.metadata).toEqual({ name: "Brokers App", fetched_at: "2026-01-01T00:00:00.000Z" });

    const cloudflare = body.find((e) => e.slug === "cloudflare/jackm/9f2c965eeb2fcc390fc3843935de35bc");
    expect(cloudflare.metadata).toBeUndefined();
  });

  it("401 when unauthenticated", async () => {
    const env = makeEnv();
    const request = new Request("https://broker.jsmunro.me/api/apps");
    const res = await worker.fetch(request, env, {} as any);
    expect(res.status).toBe(401);
  });
});

describe("dashboard card rendering (inline client script)", () => {
  // renderLinkCard is defined inside the served page's inline <script>. Extract
  // it the same way extractRenderDeviceSection does, and exercise it directly.
  function extractRenderLinkCard(html: string): (entry: any) => string {
    const start = html.indexOf("function renderLinkCard");
    const end = html.indexOf("\nasync function loadLinks");
    const src = html.slice(start, end);
    const esc = (s: unknown) =>
      String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    // eslint-disable-next-line no-new-func
    return new Function("esc", `${src}\nreturn renderLinkCard;`)(esc);
  }

  async function fetchRenderLinkCard(): Promise<(entry: any) => string> {
    const env = makeEnv();
    const request = new Request("https://broker.jsmunro.me/", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const res = await worker.fetch(request, env, {} as any);
    const html = await res.text();
    return extractRenderLinkCard(html);
  }

  it("titles the card with metadata.name when present, subtitled by the full slug", async () => {
    const render = await fetchRenderLinkCard();
    const out = render({
      slug: "github/jsmunro/Iv23lifj0i4aV6qYR76i",
      linked: true,
      display_name: "Brokers repo",
      metadata: { name: "Brokers App" },
    });

    expect(out).toContain(">Brokers App ");
    expect(out).toContain("github/jsmunro/Iv23lifj0i4aV6qYR76i");
  });

  it("falls back to display_name when no metadata is present", async () => {
    const render = await fetchRenderLinkCard();
    const out = render({
      slug: "cloudflare/jackm/9f2c965eeb2fcc390fc3843935de35bc",
      linked: false,
      display_name: "central-auth-broker",
      auth_url: "https://dash.cloudflare.com/oauth2/auth?...",
    });

    expect(out).toContain(">central-auth-broker ");
    expect(out).toContain("cloudflare/jackm/9f2c965eeb2fcc390fc3843935de35bc");
  });

  it("falls back to the slug itself when neither metadata nor display_name is present", async () => {
    const render = await fetchRenderLinkCard();
    const out = render({ slug: "github/jsmunro/Iv23lifj0i4aV6qYR76i", linked: false, auth_url: "https://x" });

    expect(out).toContain(">github/jsmunro/Iv23lifj0i4aV6qYR76i ");
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

    const request = new Request(
      "https://broker.jsmunro.me/callback/github/jsmunro/Iv23lifj0i4aV6qYR76i?code=abc123",
      {
        headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
      }
    );
    const res = await worker.fetch(request, env, {} as any);
    const text = await res.text();
    expect(text).toContain('<a href="/">Back to dashboard</a>');
  });
});
