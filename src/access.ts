import type { Env } from "./types";

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

interface JwksCacheEntry {
  keys: Jwk[];
  fetchedAt: number;
}

const JWKS_TTL_MS = 5 * 60 * 1000; // ~5 minutes

// Module-level cache of JWKS keyed by the certs URL, so multiple team domains
// (e.g. across tests) don't clobber one another.
let jwksCache: Map<string, JwksCacheEntry> = new Map();

/** Exposed for tests to reset the module-level cache between cases. */
export function __resetJwksCacheForTests(): void {
  jwksCache = new Map();
}

function base64UrlToUint8Array(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "===".slice((b64.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64UrlDecodeToString(b64url: string): string {
  return new TextDecoder().decode(base64UrlToUint8Array(b64url));
}

async function getJwks(env: Env, forceRefetch = false): Promise<Jwk[]> {
  const url = `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
  const cached = jwksCache.get(url);
  const now = Date.now();
  if (!forceRefetch && cached && now - cached.fetchedAt < JWKS_TTL_MS) {
    return cached.keys;
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch Access JWKS: ${res.status}`);
  }
  const body = (await res.json()) as { keys: Jwk[] };
  jwksCache.set(url, { keys: body.keys, fetchedAt: now });
  return body.keys;
}

async function importRsaPublicKey(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: jwk.kty,
      n: jwk.n,
      e: jwk.e,
      alg: "RS256",
      ext: true,
    },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
}

/**
 * Parses `env.ACCESS_APP_AUDS` — the per-slug `{ "<slug>": { "token": "<aud>",
 * "link": "<aud>" } }` map synced from Terraform. Throws (with a clear
 * message) on malformed JSON or a non-object top level so callers can fail
 * closed rather than silently treating a broken config as "no mappings".
 */
export function parseAccessAppAuds(env: Env): Record<string, { token: string; link: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.ACCESS_APP_AUDS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`ACCESS_APP_AUDS is not valid JSON: ${message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("ACCESS_APP_AUDS must be a JSON object");
  }
  return parsed as Record<string, { token: string; link: string }>;
}

/**
 * Verifies a Cloudflare Access JWT: RS256 signature against the team's JWKS,
 * and aud/iss/exp/nbf claim validation. `expectedAuds` is the STRICT list of
 * auds this request may present against (per-slug token/link aud, or the
 * root `ACCESS_AUD` for unregistered slugs and dashboard/`/api/*` routes) —
 * the JWT's `aud` claim must intersect it. Returns the decoded payload on
 * success; the payload may carry `email` (user JWTs) or `common_name`
 * (service-token `non_identity` JWTs) — identity resolution is the caller's
 * job.
 */
export async function verifyAccessJwt(
  jwt: string,
  env: Env,
  expectedAuds: string[]
): Promise<{ email?: string; common_name?: string; [k: string]: any }> {
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed JWT");
  }
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = JSON.parse(base64UrlDecodeToString(headerB64)) as { alg: string; kid: string };
  if (header.alg !== "RS256") {
    throw new Error(`Unsupported JWT alg: ${header.alg}`);
  }

  let keys = await getJwks(env);
  let matching = keys.find((k) => k.kid === header.kid);
  if (!matching) {
    // The key may have rotated since our cached JWKS was fetched; force one
    // fresh refetch and retry before giving up.
    keys = await getJwks(env, true);
    matching = keys.find((k) => k.kid === header.kid);
  }
  if (!matching) {
    throw new Error("No matching JWKS key for kid");
  }

  const cryptoKey = await importRsaPublicKey(matching);
  const signature = base64UrlToUint8Array(signatureB64);
  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    signature,
    signedData
  );
  if (!valid) {
    throw new Error("Invalid JWT signature");
  }

  const payload = JSON.parse(base64UrlDecodeToString(payloadB64)) as {
    email?: string;
    common_name?: string;
    aud?: string | string[];
    iss?: string;
    exp?: number;
    nbf?: number;
    [k: string]: any;
  };

  const aud = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!aud.some((a) => expectedAuds.includes(a))) {
    throw new Error("JWT aud mismatch");
  }

  const expectedIss = `https://${env.ACCESS_TEAM_DOMAIN}`;
  if (payload.iss !== expectedIss) {
    throw new Error("JWT iss mismatch");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || nowSeconds >= payload.exp) {
    throw new Error("JWT expired");
  }
  if (typeof payload.nbf === "number" && nowSeconds < payload.nbf) {
    throw new Error("JWT not yet valid");
  }

  return payload as { email?: string; common_name?: string; [k: string]: any };
}
