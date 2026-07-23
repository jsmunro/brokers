import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeEnv, exportPrivateKeyAsPkcs8Pem, generateTestKeyPair } from "./helpers";
import type { AppConfig } from "../src/types";
import { fetchAppMetadata, getCachedAppMetadata, refreshAppMetadataCache } from "../src/appauth";

function base64UrlDecode(b64url: string): string {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "===".slice((b64.length + 3) % 4);
  return atob(padded);
}

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(base64UrlDecode(part));
}

async function verifyJwtSignature(jwt: string, publicKey: CryptoKey): Promise<boolean> {
  const [headerB64, payloadB64, signatureB64] = jwt.split(".") as [string, string, string];
  const signature = Uint8Array.from(base64UrlDecode(signatureB64), (c) => c.charCodeAt(0));
  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signature, signedData);
}

function githubAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    slug: "github/jsmunro/Iv23lifj0i4aV6qYR76i",
    displayName: "Brokers repo",
    provider: {
      slug: "github/jsmunro/Iv23lifj0i4aV6qYR76i",
      getAuthUrl: () => "",
      handleCallback: async () => ({ refreshToken: "x", data: {} }),
      refreshToken: async () => ({ token: "x" }),
    },
    appAuth: { kind: "github-app-jwt", appIdVar: "GITHUB_APP_ID", privateKeyVar: "GITHUB_APP_PRIVATE_KEY" },
    ...overrides,
  };
}

const GITHUB_APP_RESPONSE = {
  id: 123456,
  slug: "brokers-app",
  name: "Brokers App",
  description: "Central auth broker GitHub App",
  owner: { login: "jsmunro" },
  permissions: { contents: "read", metadata: "read" },
  events: ["push", "pull_request"],
  html_url: "https://github.com/apps/brokers-app",
  extra_raw_field: "should not leak",
};

describe("fetchAppMetadata", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when the app has no appAuth configured", async () => {
    const env = makeEnv();
    const config = githubAppConfig({ appAuth: undefined });
    const result = await fetchAppMetadata(config, env);
    expect(result).toBeNull();
  });

  it("builds a github-app-jwt request with correct header/claims and a verifiable signature", async () => {
    const { privateKey, publicJwk } = await generateTestKeyPair();
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      { ...publicJwk, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const pem = await exportPrivateKeyAsPkcs8Pem(privateKey);

    const env = makeEnv({ GITHUB_APP_ID: "987654", GITHUB_APP_PRIVATE_KEY: pem });
    const config = githubAppConfig();

    let capturedRequest: { url: string; headers: Record<string, string> } | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedRequest = { url: input.toString(), headers: init?.headers as Record<string, string> };
        return new Response(JSON.stringify(GITHUB_APP_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );

    const before = Math.floor(Date.now() / 1000);
    const result = await fetchAppMetadata(config, env);
    const after = Math.floor(Date.now() / 1000);

    expect(capturedRequest?.url).toBe("https://api.github.com/app");
    expect(capturedRequest?.headers.Accept).toBe("application/vnd.github+json");
    expect(capturedRequest?.headers["User-Agent"]).toBeTruthy();

    const authHeader = capturedRequest?.headers.Authorization ?? "";
    expect(authHeader.startsWith("Bearer ")).toBe(true);
    const jwt = authHeader.slice("Bearer ".length);

    const header = decodeJwtPart(jwt.split(".")[0]!);
    expect(header.alg).toBe("RS256");

    const payload = decodeJwtPart(jwt.split(".")[1]!) as { iss: string; iat: number; exp: number };
    expect(payload.iss).toBe("987654");
    // iat backdated ~60s, exp forward ~540s, within the test's execution window.
    expect(payload.iat).toBeLessThanOrEqual(before - 60);
    expect(payload.iat).toBeGreaterThanOrEqual(before - 61);
    expect(payload.exp).toBeGreaterThanOrEqual(before + 539);
    expect(payload.exp).toBeLessThanOrEqual(after + 541);

    const validSignature = await verifyJwtSignature(jwt, publicKey);
    expect(validSignature).toBe(true);

    expect(result).toEqual({
      name: "Brokers App",
      description: "Central auth broker GitHub App",
      owner: "jsmunro",
      permissions: { contents: "read", metadata: "read" },
      events: ["push", "pull_request"],
      html_url: "https://github.com/apps/brokers-app",
      fetched_at: expect.any(String),
    });
    expect((result as any).id).toBeUndefined();
    expect((result as any).slug).toBeUndefined();
    expect((result as any).extra_raw_field).toBeUndefined();
  });

  it("throws when the /app request is not ok", async () => {
    const { privateKey } = await generateTestKeyPair();
    const pem = await exportPrivateKeyAsPkcs8Pem(privateKey);
    const env = makeEnv({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem });
    const config = githubAppConfig();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("forbidden", { status: 403 }))
    );

    await expect(fetchAppMetadata(config, env)).rejects.toThrow(/403/);
  });

  it("throws a clear config error when the appId env var is missing", async () => {
    const env = makeEnv({ GITHUB_APP_ID: "", GITHUB_APP_PRIVATE_KEY: "irrelevant" });
    const config = githubAppConfig();
    await expect(fetchAppMetadata(config, env)).rejects.toThrow(/GITHUB_APP_ID/);
  });
});

describe("KV app metadata cache", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getCachedAppMetadata returns null when nothing is cached", async () => {
    const env = makeEnv();
    const result = await getCachedAppMetadata(env, "github/jsmunro/Iv23lifj0i4aV6qYR76i");
    expect(result).toBeNull();
  });

  it("refreshAppMetadataCache is a no-op for apps with no appAuth", async () => {
    const env = makeEnv();
    const config = githubAppConfig({ appAuth: undefined });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await refreshAppMetadataCache(config, env);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getCachedAppMetadata(env, config.slug)).toBeNull();
  });

  it("fetches and caches metadata when nothing is cached yet", async () => {
    const { privateKey } = await generateTestKeyPair();
    const pem = await exportPrivateKeyAsPkcs8Pem(privateKey);
    const env = makeEnv({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem });
    const config = githubAppConfig();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(GITHUB_APP_RESPONSE), { status: 200 }))
    );

    await refreshAppMetadataCache(config, env);

    const cached = await getCachedAppMetadata(env, config.slug);
    expect(cached?.name).toBe("Brokers App");
  });

  it("skips refetching when the cached entry is younger than 24h", async () => {
    const env = makeEnv();
    const config = githubAppConfig();
    await env.AUTH_TOKENS.put(
      `app:${config.slug}`,
      JSON.stringify({ name: "Cached Name", fetched_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
    );

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await refreshAppMetadataCache(config, env);

    expect(fetchMock).not.toHaveBeenCalled();
    const cached = await getCachedAppMetadata(env, config.slug);
    expect(cached?.name).toBe("Cached Name");
  });

  it("refetches when the cached entry is older than 24h", async () => {
    const { privateKey } = await generateTestKeyPair();
    const pem = await exportPrivateKeyAsPkcs8Pem(privateKey);
    const env = makeEnv({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem });
    const config = githubAppConfig();
    await env.AUTH_TOKENS.put(
      `app:${config.slug}`,
      JSON.stringify({ name: "Stale Name", fetched_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() })
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(GITHUB_APP_RESPONSE), { status: 200 }))
    );

    await refreshAppMetadataCache(config, env);

    const cached = await getCachedAppMetadata(env, config.slug);
    expect(cached?.name).toBe("Brokers App");
  });

  it("keeps the stale cache entry and logs when the refetch fails", async () => {
    const env = makeEnv();
    const config = githubAppConfig();
    await env.AUTH_TOKENS.put(
      `app:${config.slug}`,
      JSON.stringify({ name: "Stale Name", fetched_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() })
    );

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 }))
    );

    await refreshAppMetadataCache(config, env);

    const cached = await getCachedAppMetadata(env, config.slug);
    expect(cached?.name).toBe("Stale Name");
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("never throws even when the underlying fetch throws", async () => {
    const env = makeEnv();
    const config = githubAppConfig();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );

    await expect(refreshAppMetadataCache(config, env)).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
