import type { Env } from "../src/types";

/** Minimal in-memory KV stub implementing the subset of KVNamespace we use. */
export function makeKvStub() {
  const store = new Map<string, string>();

  const kv = {
    async get(key: string): Promise<string | null> {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(options?: { prefix?: string }): Promise<{ keys: { name: string }[] }> {
      const prefix = options?.prefix ?? "";
      const keys = Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys };
    },
    // Expose the underlying map for test assertions/setup.
    __store: store,
  };

  return kv;
}

export function makeEnv(overrides: Partial<Env> = {}): Env {
  const kv = makeKvStub();
  return {
    AUTH_TOKENS: kv as unknown as Env["AUTH_TOKENS"],
    GITHUB_CLIENT_ID: "Iv23test",
    GITHUB_CLIENT_SECRET: "test-secret",
    BROKER_URL: "https://broker.jsmunro.me",
    ACCESS_TEAM_DOMAIN: "jsmunro.cloudflareaccess.com",
    ACCESS_AUD: "test-aud",
    ENVIRONMENT: "test",
    ...overrides,
  };
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeString(str: string): string {
  return base64UrlEncode(new TextEncoder().encode(str));
}

export interface TestKeyPair {
  publicJwk: JsonWebKey & { kid: string };
  privateKey: CryptoKey;
}

export async function generateTestKeyPair(kid = "test-kid"): Promise<TestKeyPair> {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;

  const publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;

  return {
    publicJwk: { ...publicJwk, kid },
    privateKey: keyPair.privateKey,
  };
}

export async function signTestJwt(
  payload: Record<string, unknown>,
  privateKey: CryptoKey,
  kid = "test-kid"
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid };
  const headerB64 = base64UrlEncodeString(JSON.stringify(header));
  const payloadB64 = base64UrlEncodeString(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput)
  );

  const signatureB64 = base64UrlEncode(new Uint8Array(signature));
  return `${signingInput}.${signatureB64}`;
}
