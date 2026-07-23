import { describe, expect, it, vi } from "vitest";
import type { AuthProvider, Env } from "../src/types";

/**
 * Shared behavioral contract for any `AuthProvider` built from the oauth2
 * factory (or a hand-written equivalent). Encodes the byte-compatible
 * request/response shapes the original hand-written GitHub/Cloudflare
 * providers guaranteed, so both factory-built apps (and any future one) are
 * exercised against the same assertions.
 */
export interface ProviderContractOptions {
  env: Env;
  authorizeUrl: string;
  /** Full callback request URL including `?code=...`, 3-part callback path. */
  callbackRequestUrl: string;
  tokenExchangeResponse: Record<string, unknown>;
  expectedRefreshToken: string;
  expectedAccessToken: string;
  refreshResponse: Record<string, unknown>;
  expectedRefreshedToken: string;
}

export function providerContractTests(
  name: string,
  factory: () => AuthProvider,
  opts: ProviderContractOptions
): void {
  describe(`${name} (oauth2 contract)`, () => {
    it("getAuthUrl returns a URL with client_id, redirect_uri, response_type=code, and state", () => {
      const provider = factory();
      const authUrl = provider.getAuthUrl(opts.env, "user@example.com");
      const url = new URL(authUrl);

      expect(url.origin + url.pathname).toBe(opts.authorizeUrl);
      expect(url.searchParams.get("client_id")).toBeTruthy();
      expect(url.searchParams.get("redirect_uri")).toBeTruthy();
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("state")).toBeTruthy();
    });

    it("handleCallback throws when the code parameter is missing", async () => {
      const provider = factory();
      const requestUrl = opts.callbackRequestUrl.split("?")[0]!;
      const request = new Request(requestUrl);
      await expect(provider.handleCallback(request, opts.env)).rejects.toThrow(/code/i);
    });

    it("handleCallback exchanges the code and returns the refresh token", async () => {
      const provider = factory();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          return new Response(JSON.stringify(opts.tokenExchangeResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        })
      );

      const request = new Request(opts.callbackRequestUrl);
      const result = await provider.handleCallback(request, opts.env);

      expect(result.refreshToken).toBe(opts.expectedRefreshToken);
      expect(result.data.access_token).toBe(opts.expectedAccessToken);
      vi.unstubAllGlobals();
    });

    it("handleCallback throws error_description when the provider returns an error", async () => {
      const provider = factory();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          return new Response(
            JSON.stringify({ error: "invalid_grant", error_description: "nope, try again" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        })
      );

      const request = new Request(opts.callbackRequestUrl);
      await expect(provider.handleCallback(request, opts.env)).rejects.toThrow("nope, try again");
      vi.unstubAllGlobals();
    });

    it("handleCallback throws when refresh_token is missing from the response", async () => {
      const provider = factory();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          return new Response(JSON.stringify({ access_token: "tok", expires_in: 10 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        })
      );

      const request = new Request(opts.callbackRequestUrl);
      await expect(provider.handleCallback(request, opts.env)).rejects.toThrow(/refresh_token/);
      vi.unstubAllGlobals();
    });

    it("refreshToken exchanges the refresh token for a new access token", async () => {
      const provider = factory();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          return new Response(JSON.stringify(opts.refreshResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        })
      );

      const result = await provider.refreshToken("old-refresh-token", opts.env);
      expect(result.token).toBe(opts.expectedRefreshedToken);
      vi.unstubAllGlobals();
    });

    it("refreshToken throws error_description on an error response", async () => {
      const provider = factory();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          return new Response(
            JSON.stringify({ error: "invalid_grant", error_description: "refresh rejected" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        })
      );

      await expect(provider.refreshToken("old-refresh-token", opts.env)).rejects.toThrow(
        "refresh rejected"
      );
      vi.unstubAllGlobals();
    });
  });
}
