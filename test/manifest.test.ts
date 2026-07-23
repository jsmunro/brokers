import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  validateManifest,
  parseAndValidateManifest,
  ManifestValidationError,
} from "../scripts/validate-manifest.mjs";

const MANIFEST_PATH = path.join(__dirname, "..", "apps", "manifest.json");

function baseManifest(): any {
  return JSON.parse(
    JSON.stringify({
      version: 1,
      defaults: {
        access: { session_duration: "24h", allow_groups: ["org-members"] },
        link_policy: { require_warp: true, require_posture: [] },
      },
      groups: {
        "org-members": { github_team: null, emails: ["jack@jsmunro.me"] },
      },
      apps: [
        {
          slug: "github/jsmunro/Iv23lifj0i4aV6qYR76i",
          display_name: "Brokers repo",
          auth: {
            kind: "oauth2",
            authorize_url: "https://github.com/login/oauth/authorize",
            token_url: "https://github.com/login/oauth/access_token",
            client_id_var: "GITHUB_CLIENT_ID",
            client_secret_var: "GITHUB_CLIENT_SECRET",
            client_auth: "body",
          },
          app_auth: {
            kind: "github-app-jwt",
            app_id_var: "GITHUB_APP_ID",
            private_key_var: "GITHUB_APP_PRIVATE_KEY",
          },
          scopes: { declared: "installation-defined", source: "metadata.permissions" },
          access: { allow_groups: ["org-members"], service_token: true },
        },
      ],
    })
  );
}

describe("apps/manifest.json (real file)", () => {
  it("is a valid manifest with the two expected app entries", () => {
    const text = readFileSync(MANIFEST_PATH, "utf8");
    const manifest = parseAndValidateManifest(text);

    expect(manifest.version).toBe(1);
    const slugs = manifest.apps.map((a: any) => a.slug);
    expect(slugs).toContain("github/jsmunro/Iv23lifj0i4aV6qYR76i");
    expect(slugs).toContain("cloudflare/jackm/9f2c965eeb2fcc390fc3843935de35bc");
  });
});

describe("validateManifest (happy path)", () => {
  it("accepts a well-formed manifest", () => {
    expect(validateManifest(baseManifest())).toEqual([]);
  });

  it("accepts an app with no app_auth and array-valued declared scopes", () => {
    const manifest = baseManifest();
    delete manifest.apps[0].app_auth;
    manifest.apps[0].scopes = { declared: ["a", "b"] };
    expect(validateManifest(manifest)).toEqual([]);
  });

  it("accepts link_policy and bookmark overrides", () => {
    const manifest = baseManifest();
    manifest.apps[0].link_policy = { require_mfa: true };
    manifest.apps[0].bookmark = { app_launcher: true };
    expect(validateManifest(manifest)).toEqual([]);
  });
});

describe("validateManifest (sad paths)", () => {
  it("rejects a non-object manifest", () => {
    expect(validateManifest(null)).toEqual(["manifest: must be a JSON object"]);
    expect(validateManifest([])).toEqual(["manifest: must be a JSON object"]);
  });

  it("rejects an unknown top-level field", () => {
    const manifest = baseManifest();
    manifest.extra = true;
    const errors = validateManifest(manifest);
    expect(errors).toContain('manifest: unknown field "extra"');
  });

  it("rejects a version other than 1", () => {
    const manifest = baseManifest();
    manifest.version = 2;
    const errors = validateManifest(manifest);
    expect(errors.some((e) => e.startsWith("version:"))).toBe(true);
  });

  it("rejects a bad slug (missing 3-part shape)", () => {
    const manifest = baseManifest();
    manifest.apps[0].slug = "github-only";
    const errors = validateManifest(manifest);
    expect(errors.some((e) => e.includes("apps[0].slug"))).toBe(true);
  });

  it("rejects a bad slug (uppercase provider segment)", () => {
    const manifest = baseManifest();
    manifest.apps[0].slug = "GitHub/jsmunro/Iv23lifj0i4aV6qYR76i";
    const errors = validateManifest(manifest);
    expect(errors.some((e) => e.includes("apps[0].slug"))).toBe(true);
  });

  it("rejects a duplicate slug", () => {
    const manifest = baseManifest();
    manifest.apps.push({ ...manifest.apps[0] });
    const errors = validateManifest(manifest);
    expect(errors.some((e) => e.includes("duplicate slug"))).toBe(true);
  });

  it("rejects an unknown app-level field", () => {
    const manifest = baseManifest();
    manifest.apps[0].unknown_field = true;
    const errors = validateManifest(manifest);
    expect(errors).toContain('apps[0]: unknown field "unknown_field"');
  });

  it("rejects an unknown field nested in auth", () => {
    const manifest = baseManifest();
    manifest.apps[0].auth.unknown = "x";
    const errors = validateManifest(manifest);
    expect(errors).toContain('apps[0].auth: unknown field "unknown"');
  });

  it("rejects an unresolved group reference in app access.allow_groups", () => {
    const manifest = baseManifest();
    manifest.apps[0].access.allow_groups = ["does-not-exist"];
    const errors = validateManifest(manifest);
    expect(errors.some((e) => e.includes('unresolved group reference "does-not-exist"'))).toBe(true);
  });

  it("rejects an unresolved group reference in defaults.access.allow_groups", () => {
    const manifest = baseManifest();
    manifest.defaults.access.allow_groups = ["nope"];
    const errors = validateManifest(manifest);
    expect(errors.some((e) => e.includes('unresolved group reference "nope"'))).toBe(true);
  });

  it("rejects a bad env-var name (lowercase)", () => {
    const manifest = baseManifest();
    manifest.apps[0].auth.client_id_var = "github_client_id";
    const errors = validateManifest(manifest);
    expect(errors.some((e) => e.includes("client_id_var"))).toBe(true);
  });

  it("rejects a bad env-var name (leading digit)", () => {
    const manifest = baseManifest();
    manifest.apps[0].auth.client_secret_var = "1SECRET";
    const errors = validateManifest(manifest);
    expect(errors.some((e) => e.includes("client_secret_var"))).toBe(true);
  });

  it("rejects a bad env-var name on app_auth fields", () => {
    const manifest = baseManifest();
    manifest.apps[0].app_auth.app_id_var = "bad-name";
    const errors = validateManifest(manifest);
    expect(errors.some((e) => e.includes("app_id_var"))).toBe(true);
  });

  it("rejects a bad env-var name on authorize_params_var", () => {
    const manifest = baseManifest();
    manifest.apps[0].auth.authorize_params_var = "bad-scope-var";
    const errors = validateManifest(manifest);
    expect(errors.some((e) => e.includes("authorize_params_var"))).toBe(true);
  });

  it("rejects a group with none of emails/github_team/okta_group", () => {
    const manifest = baseManifest();
    manifest.groups["empty-group"] = {};
    const errors = validateManifest(manifest);
    expect(errors.some((e) => e.includes("groups.empty-group"))).toBe(true);
  });

  it("rejects an unknown field inside a group", () => {
    const manifest = baseManifest();
    manifest.groups["org-members"].unknown = "x";
    const errors = validateManifest(manifest);
    expect(errors).toContain('groups.org-members: unknown field "unknown"');
  });

  it("rejects a bad auth.kind", () => {
    const manifest = baseManifest();
    manifest.apps[0].auth.kind = "saml";
    const errors = validateManifest(manifest);
    expect(errors.some((e) => e.includes("auth.kind"))).toBe(true);
  });

  it("rejects a bad scopes.declared type", () => {
    const manifest = baseManifest();
    manifest.apps[0].scopes.declared = 42;
    const errors = validateManifest(manifest);
    expect(errors.some((e) => e.includes("scopes.declared"))).toBe(true);
  });

  it("rejects an unsupported scopes.source", () => {
    const manifest = baseManifest();
    manifest.apps[0].scopes.source = "something.else";
    const errors = validateManifest(manifest);
    expect(errors.some((e) => e.includes("scopes.source"))).toBe(true);
  });

  it("rejects apps not being an array", () => {
    const manifest = baseManifest();
    manifest.apps = {};
    const errors = validateManifest(manifest);
    expect(errors).toContain("apps: must be an array");
  });

  it("reports every error at once rather than failing fast", () => {
    const manifest = baseManifest();
    manifest.version = 2;
    manifest.apps[0].slug = "bad";
    manifest.apps[0].auth.client_id_var = "lowercase";
    const errors = validateManifest(manifest);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe("parseAndValidateManifest", () => {
  it("throws ManifestValidationError with a clear message on malformed JSON", () => {
    expect(() => parseAndValidateManifest("{not json")).toThrow(ManifestValidationError);
    try {
      parseAndValidateManifest("{not json");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestValidationError);
      expect((err as Error).message).toContain("JSON parse error");
    }
  });

  it("throws ManifestValidationError listing schema violations", () => {
    const manifest = baseManifest();
    manifest.apps[0].slug = "bad-slug";
    expect(() => parseAndValidateManifest(JSON.stringify(manifest))).toThrow(ManifestValidationError);
  });

  it("returns the parsed manifest on success", () => {
    const manifest = parseAndValidateManifest(JSON.stringify(baseManifest()));
    expect(manifest.version).toBe(1);
  });
});
