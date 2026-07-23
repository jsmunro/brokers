############################################
# central-auth-broker — Terraform root
#
# Manages Cloudflare Zero Trust Access resources for the per-app access
# broker. The Cloudflare Worker itself is deployed via wrangler (NOT
# Terraform-managed) — see ../wrangler.toml and infra/sync-auds.sh.
#
# apps/manifest.json is the single source of truth for groups, apps and
# access policy. Nothing app-specific should be hardcoded below; add new
# apps by editing the manifest, not this directory.
############################################

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.44"
    }
  }

  # R2 (S3-compatible) remote state. Configure with:
  #   terraform init -backend-config=backend.hcl
  # backend.hcl is gitignored; see backend.hcl.example and infra/bootstrap.sh.
  backend "s3" {}
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# ------------------------------------------------------------------
# Manifest — single source of truth
# ------------------------------------------------------------------

locals {
  manifest = jsondecode(file("${path.module}/../apps/manifest.json"))

  defaults   = local.manifest.defaults
  groups_raw = local.manifest.groups
  apps_raw   = local.manifest.apps

  # Per-app config, resolved with manifest defaults (mirrors the worker's
  # fallback behavior: per-app access.* falls back to defaults.access.*).
  apps = {
    for a in local.apps_raw : a.slug => merge(a, {
      # Terraform resource-name-safe key: lowercase, "/" and "." -> "-".
      # NOTE: two distinct slugs that differ only by case or by "/"/"." can
      # sanitize to the same key (e.g. "Foo/Bar" and "foo.bar" both ->
      # "foo-bar"), which would collide in this map and in the Cloudflare
      # resource names below. Theoretically possible, not currently
      # validated here or in scripts/validate-manifest.mjs — keep slugs
      # visually distinct until this is enforced.
      key = lower(replace(a.slug, "/[/.]/", "-"))

      allow_groups     = try(a.access.allow_groups, local.defaults.access.allow_groups)
      session_duration = try(a.access.session_duration, local.defaults.access.session_duration)
      service_token    = try(a.access.service_token, false)
      link_policy = merge(
        local.defaults.link_policy,
        try(a.link_policy, {})
      )
      bookmark_app_launcher = try(a.bookmark.app_launcher, false)
    })
  }

  # Per-app compiled `require` device_posture id list for the linking app:
  # the account-scoped cloudflare_device_posture_rule.warp id (if
  # require_warp) plus any explicit posture-integration rule ids
  # (require_posture), passed through verbatim — device_posture entries
  # must be real posture-integration rule ids, not the literal "warp".
  link_require_posture = {
    for k, v in local.apps : k => concat(
      try(v.link_policy.require_warp, false) ? [cloudflare_zero_trust_device_posture_rule.warp.id] : [],
      try(v.link_policy.require_posture, [])
    )
  }
}

# Cheap reference-check precondition (full validation lives in
# scripts/validate-manifest.mjs, run in `npm test`): every allow_groups
# entry referenced by an app must exist in manifest.groups.
resource "terraform_data" "manifest_validation" {
  input = local.manifest

  lifecycle {
    precondition {
      condition = alltrue([
        for a in local.apps_raw : alltrue([
          for g in try(a.access.allow_groups, local.defaults.access.allow_groups) :
          contains(keys(local.groups_raw), g)
        ])
      ])
      error_message = "apps/manifest.json: an app references an access.allow_groups entry that is not defined in manifest.groups."
    }
  }
}
