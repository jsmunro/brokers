import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyAccessJwt, __resetJwksCacheForTests } from "../src/access";
import { makeEnv, generateTestKeyPair, signTestJwt } from "./helpers";

describe("verifyAccessJwt", () => {
  beforeEach(() => {
    __resetJwksCacheForTests();
    vi.unstubAllGlobals();
  });

  async function setupJwks() {
    const { publicJwk, privateKey } = await generateTestKeyPair();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://jsmunro.cloudflareaccess.com/cdn-cgi/access/certs") {
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return { privateKey, fetchMock };
  }

  it("verifies a valid RS256 JWT and returns the payload", async () => {
    const env = makeEnv();
    const { privateKey } = await setupJwks();
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signTestJwt(
      {
        email: "user@example.com",
        aud: env.ACCESS_AUD,
        iss: `https://${env.ACCESS_TEAM_DOMAIN}`,
        exp: now + 3600,
        nbf: now - 60,
      },
      privateKey
    );

    const payload = await verifyAccessJwt(jwt, env);
    expect(payload.email).toBe("user@example.com");
  });

  it("rejects a JWT with an invalid signature", async () => {
    const env = makeEnv();
    const { privateKey } = await setupJwks();
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signTestJwt(
      {
        email: "user@example.com",
        aud: env.ACCESS_AUD,
        iss: `https://${env.ACCESS_TEAM_DOMAIN}`,
        exp: now + 3600,
      },
      privateKey
    );
    // Tamper with the payload segment without re-signing.
    const [h, , s] = jwt.split(".");
    const tamperedJson = JSON.stringify({ email: "attacker@example.com" });
    const tamperedBinary = String.fromCharCode(...new TextEncoder().encode(tamperedJson));
    const tamperedPayload = btoa(tamperedBinary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const tampered = `${h}.${tamperedPayload}.${s}`;

    await expect(verifyAccessJwt(tampered, env)).rejects.toThrow();
  });

  it("rejects an expired JWT", async () => {
    const env = makeEnv();
    const { privateKey } = await setupJwks();
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signTestJwt(
      {
        email: "user@example.com",
        aud: env.ACCESS_AUD,
        iss: `https://${env.ACCESS_TEAM_DOMAIN}`,
        exp: now - 10,
      },
      privateKey
    );

    await expect(verifyAccessJwt(jwt, env)).rejects.toThrow(/expired/);
  });

  it("rejects a JWT with the wrong audience", async () => {
    const env = makeEnv();
    const { privateKey } = await setupJwks();
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signTestJwt(
      {
        email: "user@example.com",
        aud: "some-other-aud",
        iss: `https://${env.ACCESS_TEAM_DOMAIN}`,
        exp: now + 3600,
      },
      privateKey
    );

    await expect(verifyAccessJwt(jwt, env)).rejects.toThrow(/aud/);
  });

  it("rejects a JWT with the wrong issuer", async () => {
    const env = makeEnv();
    const { privateKey } = await setupJwks();
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signTestJwt(
      {
        email: "user@example.com",
        aud: env.ACCESS_AUD,
        iss: "https://evil.example.com",
        exp: now + 3600,
      },
      privateKey
    );

    await expect(verifyAccessJwt(jwt, env)).rejects.toThrow(/iss/);
  });

  it("rejects a not-yet-valid (nbf) JWT", async () => {
    const env = makeEnv();
    const { privateKey } = await setupJwks();
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signTestJwt(
      {
        email: "user@example.com",
        aud: env.ACCESS_AUD,
        iss: `https://${env.ACCESS_TEAM_DOMAIN}`,
        exp: now + 3600,
        nbf: now + 300,
      },
      privateKey
    );

    await expect(verifyAccessJwt(jwt, env)).rejects.toThrow(/not yet valid/);
  });

  it("forces a JWKS refetch on kid miss and succeeds once the rotated key is returned", async () => {
    const env = makeEnv();
    const { publicJwk, privateKey } = await generateTestKeyPair("new-kid");
    const { publicJwk: staleJwk } = await generateTestKeyPair("old-kid");

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url !== "https://jsmunro.cloudflareaccess.com/cdn-cgi/access/certs") {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      // First call returns only the stale key (simulating a cache that hasn't
      // seen the rotation yet); subsequent calls return the rotated key too.
      if (fetchMock.mock.calls.length === 1) {
        return new Response(JSON.stringify({ keys: [staleJwk] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ keys: [staleJwk, publicJwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const now = Math.floor(Date.now() / 1000);
    const jwt = await signTestJwt(
      {
        email: "user@example.com",
        aud: env.ACCESS_AUD,
        iss: `https://${env.ACCESS_TEAM_DOMAIN}`,
        exp: now + 3600,
      },
      privateKey,
      "new-kid"
    );

    const payload = await verifyAccessJwt(jwt, env);
    expect(payload.email).toBe("user@example.com");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still rejects a genuinely unknown kid after the forced refetch", async () => {
    const env = makeEnv();
    const { privateKey } = await setupJwks();

    const now = Math.floor(Date.now() / 1000);
    const jwt = await signTestJwt(
      {
        email: "user@example.com",
        aud: env.ACCESS_AUD,
        iss: `https://${env.ACCESS_TEAM_DOMAIN}`,
        exp: now + 3600,
      },
      privateKey,
      "totally-unknown-kid"
    );

    await expect(verifyAccessJwt(jwt, env)).rejects.toThrow(/No matching JWKS key/);
  });
});
