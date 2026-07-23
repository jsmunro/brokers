import type { Env } from "../src/types";

/** Minimal in-memory KV stub implementing the subset of KVNamespace we use. */
export function makeKvStub() {
  const store = new Map<string, string>();

  const kv = {
    async get(key: string, type?: "text" | "json"): Promise<any> {
      const raw = store.has(key) ? store.get(key)! : null;
      if (raw !== null && type === "json") {
        return JSON.parse(raw);
      }
      return raw;
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
    GITHUB_APP_ID: "test-app-id",
    GITHUB_APP_PRIVATE_KEY: "test-app-private-key",
    CLOUDFLARE_OAUTH_CLIENT_ID: "cf-client-id",
    CLOUDFLARE_OAUTH_CLIENT_SECRET: "cf-client-secret",
    CLOUDFLARE_OAUTH_SCOPES: "offline_access d1.read",
    BROKER_URL: "https://broker.jsmunro.me",
    ACCESS_TEAM_DOMAIN: "jsmunro.cloudflareaccess.com",
    ACCESS_AUD: "test-aud",
    ACCESS_APP_AUDS: JSON.stringify({
      "github/jsmunro/Iv23lifj0i4aV6qYR76i": { token: "github-token-aud", link: "github-link-aud" },
      "cloudflare/jackm/9f2c965eeb2fcc390fc3843935de35bc": { token: "cloudflare-token-aud", link: "cloudflare-link-aud" },
    }),
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

function bytesToStandardBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

/** Exports a CryptoKey private key as a PKCS#8 PEM string, for app-auth JWT tests. */
export async function exportPrivateKeyAsPkcs8Pem(privateKey: CryptoKey): Promise<string> {
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", privateKey)) as ArrayBuffer;
  const b64 = bytesToStandardBase64(new Uint8Array(pkcs8));
  const lines = b64.match(/.{1,64}/g) ?? [b64];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
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
