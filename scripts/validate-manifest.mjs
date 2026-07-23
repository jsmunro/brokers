#!/usr/bin/env node
// Validates apps/manifest.json against the phase-1 manifest schema.
// Plain Node, zero dependencies. Exits 1 with a clear message on any failure.
// Usage: node scripts/validate-manifest.mjs [path-to-manifest.json]

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SLUG_RE = /^[a-z0-9-]+\/[a-z0-9-]+\/[A-Za-z0-9._~-]+$/;
const ENV_VAR_RE = /^[A-Z][A-Z0-9_]*$/;

/** Collects every validation error rather than failing fast, for a single useful report. */
export class ManifestValidationError extends Error {
  constructor(errors) {
    super(`Invalid manifest:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    this.name = "ManifestValidationError";
    this.errors = errors;
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkUnknownKeys(obj, allowed, where, errors) {
  if (!isPlainObject(obj)) return;
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      errors.push(`${where}: unknown field "${key}"`);
    }
  }
}

function checkEnvVar(value, where, errors, required = true) {
  if (value === undefined) {
    if (required) errors.push(`${where}: missing required env-var name`);
    return;
  }
  if (typeof value !== "string" || !ENV_VAR_RE.test(value)) {
    errors.push(`${where}: "${value}" is not a valid env-var name (expected ${ENV_VAR_RE})`);
  }
}

function validateGroups(groups, errors) {
  if (!isPlainObject(groups)) {
    errors.push(`groups: must be an object`);
    return;
  }
  for (const [name, group] of Object.entries(groups)) {
    const where = `groups.${name}`;
    if (!isPlainObject(group)) {
      errors.push(`${where}: must be an object`);
      continue;
    }
    checkUnknownKeys(group, ["emails", "github_team", "okta_group"], where, errors);

    if (group.emails !== undefined) {
      if (!Array.isArray(group.emails) || group.emails.some((e) => typeof e !== "string")) {
        errors.push(`${where}.emails: must be an array of strings`);
      }
    }
    if (group.github_team !== undefined && group.github_team !== null && typeof group.github_team !== "string") {
      errors.push(`${where}.github_team: must be a string or null`);
    }
    if (group.okta_group !== undefined && typeof group.okta_group !== "string") {
      errors.push(`${where}.okta_group: must be a string`);
    }
    if (
      group.emails === undefined &&
      group.github_team === undefined &&
      group.okta_group === undefined
    ) {
      errors.push(`${where}: must declare at least one of emails, github_team, okta_group`);
    }
  }
}

function validateDefaults(defaults, errors) {
  if (!isPlainObject(defaults)) {
    errors.push(`defaults: must be an object`);
    return;
  }
  checkUnknownKeys(defaults, ["access", "link_policy"], "defaults", errors);

  if (!isPlainObject(defaults.access)) {
    errors.push(`defaults.access: must be an object`);
  } else {
    checkUnknownKeys(defaults.access, ["session_duration", "allow_groups"], "defaults.access", errors);
    if (defaults.access.session_duration !== undefined && typeof defaults.access.session_duration !== "string") {
      errors.push(`defaults.access.session_duration: must be a string`);
    }
    if (!Array.isArray(defaults.access.allow_groups)) {
      errors.push(`defaults.access.allow_groups: must be an array of strings`);
    }
  }

  if (!isPlainObject(defaults.link_policy)) {
    errors.push(`defaults.link_policy: must be an object`);
  } else {
    checkUnknownKeys(
      defaults.link_policy,
      ["require_warp", "require_posture", "require_mfa"],
      "defaults.link_policy",
      errors
    );
    if (defaults.link_policy.require_warp !== undefined && typeof defaults.link_policy.require_warp !== "boolean") {
      errors.push(`defaults.link_policy.require_warp: must be a boolean`);
    }
    if (
      defaults.link_policy.require_posture !== undefined &&
      (!Array.isArray(defaults.link_policy.require_posture) ||
        defaults.link_policy.require_posture.some((p) => typeof p !== "string"))
    ) {
      errors.push(`defaults.link_policy.require_posture: must be an array of strings`);
    }
    if (defaults.link_policy.require_mfa !== undefined && typeof defaults.link_policy.require_mfa !== "boolean") {
      errors.push(`defaults.link_policy.require_mfa: must be a boolean`);
    }
  }
}

function validateAuth(auth, where, errors) {
  if (!isPlainObject(auth)) {
    errors.push(`${where}.auth: must be an object`);
    return;
  }
  if (auth.kind !== "oauth2") {
    errors.push(`${where}.auth.kind: must be "oauth2" (got "${auth.kind}")`);
    return;
  }
  checkUnknownKeys(
    auth,
    [
      "kind",
      "authorize_url",
      "token_url",
      "client_id_var",
      "client_secret_var",
      "client_auth",
      "authorize_params_var",
      "require_refresh_token",
    ],
    `${where}.auth`,
    errors
  );

  for (const field of ["authorize_url", "token_url"]) {
    if (typeof auth[field] !== "string" || auth[field].length === 0) {
      errors.push(`${where}.auth.${field}: must be a non-empty string`);
    }
  }

  checkEnvVar(auth.client_id_var, `${where}.auth.client_id_var`, errors);
  checkEnvVar(auth.client_secret_var, `${where}.auth.client_secret_var`, errors);
  checkEnvVar(auth.authorize_params_var, `${where}.auth.authorize_params_var`, errors, false);

  if (auth.client_auth !== undefined && auth.client_auth !== "body" && auth.client_auth !== "basic") {
    errors.push(`${where}.auth.client_auth: must be "body" or "basic"`);
  }
  if (auth.require_refresh_token !== undefined && typeof auth.require_refresh_token !== "boolean") {
    errors.push(`${where}.auth.require_refresh_token: must be a boolean`);
  }
}

function validateAppAuth(appAuth, where, errors) {
  if (appAuth === undefined) return;
  if (!isPlainObject(appAuth)) {
    errors.push(`${where}.app_auth: must be an object`);
    return;
  }
  if (appAuth.kind !== "github-app-jwt") {
    errors.push(`${where}.app_auth.kind: unsupported kind "${appAuth.kind}"`);
    return;
  }
  checkUnknownKeys(appAuth, ["kind", "app_id_var", "private_key_var"], `${where}.app_auth`, errors);
  checkEnvVar(appAuth.app_id_var, `${where}.app_auth.app_id_var`, errors);
  checkEnvVar(appAuth.private_key_var, `${where}.app_auth.private_key_var`, errors);
}

function validateScopes(scopes, where, errors) {
  if (!isPlainObject(scopes)) {
    errors.push(`${where}.scopes: must be an object`);
    return;
  }
  checkUnknownKeys(scopes, ["declared", "source"], `${where}.scopes`, errors);

  const declared = scopes.declared;
  const declaredOk =
    typeof declared === "string" ||
    (Array.isArray(declared) && declared.every((s) => typeof s === "string"));
  if (!declaredOk) {
    errors.push(`${where}.scopes.declared: must be a string or an array of strings`);
  }
  if (scopes.source !== undefined && scopes.source !== "metadata.permissions") {
    errors.push(`${where}.scopes.source: unsupported source "${scopes.source}"`);
  }
}

function validateAccess(access, where, groupNames, errors) {
  if (!isPlainObject(access)) {
    errors.push(`${where}.access: must be an object`);
    return;
  }
  checkUnknownKeys(access, ["allow_groups", "session_duration", "service_token"], `${where}.access`, errors);

  if (access.allow_groups !== undefined) {
    if (!Array.isArray(access.allow_groups)) {
      errors.push(`${where}.access.allow_groups: must be an array of strings`);
    } else {
      for (const group of access.allow_groups) {
        if (typeof group !== "string") {
          errors.push(`${where}.access.allow_groups: entries must be strings`);
        } else if (!groupNames.has(group)) {
          errors.push(`${where}.access.allow_groups: unresolved group reference "${group}"`);
        }
      }
    }
  }
  if (access.session_duration !== undefined && typeof access.session_duration !== "string") {
    errors.push(`${where}.access.session_duration: must be a string`);
  }
  if (access.service_token !== undefined && typeof access.service_token !== "boolean") {
    errors.push(`${where}.access.service_token: must be a boolean`);
  }
}

function validateLinkPolicy(linkPolicy, where, errors) {
  if (linkPolicy === undefined) return;
  if (!isPlainObject(linkPolicy)) {
    errors.push(`${where}.link_policy: must be an object`);
    return;
  }
  checkUnknownKeys(
    linkPolicy,
    ["require_warp", "require_posture", "require_mfa"],
    `${where}.link_policy`,
    errors
  );
  if (linkPolicy.require_warp !== undefined && typeof linkPolicy.require_warp !== "boolean") {
    errors.push(`${where}.link_policy.require_warp: must be a boolean`);
  }
  if (
    linkPolicy.require_posture !== undefined &&
    (!Array.isArray(linkPolicy.require_posture) || linkPolicy.require_posture.some((p) => typeof p !== "string"))
  ) {
    errors.push(`${where}.link_policy.require_posture: must be an array of strings`);
  }
  if (linkPolicy.require_mfa !== undefined && typeof linkPolicy.require_mfa !== "boolean") {
    errors.push(`${where}.link_policy.require_mfa: must be a boolean`);
  }
}

function validateBookmark(bookmark, where, errors) {
  if (bookmark === undefined) return;
  if (!isPlainObject(bookmark)) {
    errors.push(`${where}.bookmark: must be an object`);
    return;
  }
  checkUnknownKeys(bookmark, ["app_launcher"], `${where}.bookmark`, errors);
  if (typeof bookmark.app_launcher !== "boolean") {
    errors.push(`${where}.bookmark.app_launcher: must be a boolean`);
  }
}

function validateApp(app, index, groupNames, errors) {
  const where = `apps[${index}]`;
  if (!isPlainObject(app)) {
    errors.push(`${where}: must be an object`);
    return;
  }
  checkUnknownKeys(
    app,
    ["slug", "display_name", "auth", "app_auth", "scopes", "access", "link_policy", "bookmark"],
    where,
    errors
  );

  if (typeof app.slug !== "string" || !SLUG_RE.test(app.slug)) {
    errors.push(`${where}.slug: "${app.slug}" does not match ${SLUG_RE}`);
  }
  if (typeof app.display_name !== "string" || app.display_name.length === 0) {
    errors.push(`${where}.display_name: must be a non-empty string`);
  }

  validateAuth(app.auth, where, errors);
  validateAppAuth(app.app_auth, where, errors);
  validateScopes(app.scopes, where, errors);
  validateAccess(app.access, where, groupNames, errors);
  validateLinkPolicy(app.link_policy, where, errors);
  validateBookmark(app.bookmark, where, errors);
}

/** Validates a parsed manifest object. Returns an array of error strings (empty = valid). */
export function validateManifest(manifest) {
  const errors = [];

  if (!isPlainObject(manifest)) {
    return [`manifest: must be a JSON object`];
  }

  checkUnknownKeys(manifest, ["version", "defaults", "groups", "apps"], "manifest", errors);

  if (manifest.version !== 1) {
    errors.push(`version: must be 1 (got ${JSON.stringify(manifest.version)})`);
  }

  validateDefaults(manifest.defaults, errors);
  validateGroups(manifest.groups, errors);

  const groupNames = new Set(isPlainObject(manifest.groups) ? Object.keys(manifest.groups) : []);

  // defaults.access.allow_groups references must resolve too.
  if (isPlainObject(manifest.defaults) && isPlainObject(manifest.defaults.access)) {
    const allowGroups = manifest.defaults.access.allow_groups;
    if (Array.isArray(allowGroups)) {
      for (const group of allowGroups) {
        if (typeof group === "string" && !groupNames.has(group)) {
          errors.push(`defaults.access.allow_groups: unresolved group reference "${group}"`);
        }
      }
    }
  }

  if (!Array.isArray(manifest.apps)) {
    errors.push(`apps: must be an array`);
  } else {
    const seenSlugs = new Set();
    manifest.apps.forEach((app, index) => {
      validateApp(app, index, groupNames, errors);
      if (isPlainObject(app) && typeof app.slug === "string") {
        if (seenSlugs.has(app.slug)) {
          errors.push(`apps[${index}].slug: duplicate slug "${app.slug}"`);
        }
        seenSlugs.add(app.slug);
      }
    });
  }

  return errors;
}

/** Parses and validates the manifest JSON text. Throws `ManifestValidationError` on any failure. */
export function parseAndValidateManifest(text) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (err) {
    throw new ManifestValidationError([`JSON parse error: ${err.message}`]);
  }

  const errors = validateManifest(manifest);
  if (errors.length > 0) {
    throw new ManifestValidationError(errors);
  }
  return manifest;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
}

if (isMainModule()) {
  const manifestPath = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "apps", "manifest.json");
  try {
    const text = readFileSync(manifestPath, "utf8");
    parseAndValidateManifest(text);
    console.log(`OK: ${manifestPath} is a valid manifest.`);
  } catch (err) {
    if (err instanceof ManifestValidationError) {
      console.error(err.message);
    } else {
      console.error(`Failed to read/validate ${manifestPath}: ${err.message}`);
    }
    process.exit(1);
  }
}
