import type { AppConfig, AppMetadata, Env } from "./types";

const GITHUB_APP_URL = "https://api.github.com/app";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h staleness window
const APP_META_PREFIX = "app:";

function appMetaKey(slug: string): string {
  return `${APP_META_PREFIX}${slug}`;
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

/** Strips PEM header/footer/whitespace and base64-decodes to raw DER bytes. */
function pemToArrayBuffer(pem: string): ArrayBuffer {
  const stripped = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(stripped);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function importPkcs8PrivateKey(pem: string): Promise<CryptoKey> {
  const keyData = pemToArrayBuffer(pem);
  return crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

/**
 * Builds a GitHub App RS256 JWT: `iat` backdated 60s and `exp` +540s to
 * absorb clock skew, per GitHub's documented tolerance.
 */
async function buildGithubAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId };
  const headerB64 = base64UrlEncodeString(JSON.stringify(header));
  const payloadB64 = base64UrlEncodeString(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const privateKey = await importPkcs8PrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput)
  );
  const signatureB64 = base64UrlEncode(new Uint8Array(signature));
  return `${signingInput}.${signatureB64}`;
}

function envVar(env: Env, name: string): string {
  const value = (env as unknown as Record<string, unknown>)[name];
  if (typeof value !== "string" || !value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function curateGithubAppMetadata(json: Record<string, unknown>): AppMetadata {
  const metadata: AppMetadata = { fetched_at: new Date().toISOString() };

  if (typeof json.name === "string") {
    metadata.name = json.name;
  }
  if (typeof json.description === "string") {
    metadata.description = json.description;
  }
  const owner = json.owner as { login?: unknown } | undefined;
  if (owner && typeof owner.login === "string") {
    metadata.owner = owner.login;
  }
  if (json.permissions && typeof json.permissions === "object") {
    metadata.permissions = json.permissions as Record<string, string>;
  }
  if (Array.isArray(json.events)) {
    metadata.events = json.events as string[];
  }
  if (typeof json.html_url === "string") {
    metadata.html_url = json.html_url;
  }

  return metadata;
}

/**
 * Fetches curated app metadata using the app's configured `appAuth`.
 * Returns `null` when the app has no `appAuth` configured at all (a
 * displayName-only app). Throws on request/auth failure — callers decide
 * fallback behavior (see `refreshAppMetadataCache`).
 */
export async function fetchAppMetadata(config: AppConfig, env: Env): Promise<AppMetadata | null> {
  if (!config.appAuth) {
    return null;
  }

  if (config.appAuth.kind === "github-app-jwt") {
    const appId = envVar(env, config.appAuth.appIdVar);
    const privateKeyPem = envVar(env, config.appAuth.privateKeyVar);
    const jwt = await buildGithubAppJwt(appId, privateKeyPem);

    const res = await fetch(GITHUB_APP_URL, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "central-auth-broker",
      },
    });

    if (!res.ok) {
      throw new Error(`GitHub app metadata fetch failed (${res.status})`);
    }

    const json = (await res.json()) as Record<string, unknown>;
    return curateGithubAppMetadata(json);
  }

  const kind: string = (config.appAuth as { kind: string }).kind;
  throw new Error(`Unsupported appAuth kind: ${kind}`);
}

/** Reads the cached app metadata for a slug from KV, or `null` if none cached. */
export async function getCachedAppMetadata(env: Env, slug: string): Promise<AppMetadata | null> {
  return (await env.AUTH_TOKENS.get(appMetaKey(slug), "json")) as AppMetadata | null;
}

/**
 * Best-effort refresh of the KV-cached app metadata for a single app:
 * - No `appAuth` → nothing to do.
 * - Cached entry younger than 24h → skip the fetch.
 * - Fetch failure → logged; any existing stale cache entry is left in place.
 * Never throws — safe to call from the cron loop without isolating callers.
 */
export async function refreshAppMetadataCache(config: AppConfig, env: Env): Promise<void> {
  if (!config.appAuth) {
    return;
  }

  const key = appMetaKey(config.slug);
  try {
    const cached = (await env.AUTH_TOKENS.get(key, "json")) as AppMetadata | null;
    if (cached) {
      const age = Date.now() - new Date(cached.fetched_at).getTime();
      if (age < CACHE_TTL_MS) {
        return;
      }
    }

    const metadata = await fetchAppMetadata(config, env);
    if (metadata) {
      await env.AUTH_TOKENS.put(key, JSON.stringify(metadata));
    }
  } catch (err) {
    console.error(`refreshAppMetadataCache: failed to refresh metadata for ${config.slug}`, err);
  }
}
