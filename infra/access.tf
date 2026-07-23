############################################
# Root Access application — the broker itself (dashboard, /api/*, and any
# path not matched by a more specific per-app self_hosted_domains entry
# below, which Cloudflare Access matches on longest-path-prefix).
############################################

resource "cloudflare_zero_trust_access_application" "root" {
  account_id                 = var.account_id
  name                       = "central-auth-broker"
  domain                     = var.domain
  type                       = "self_hosted"
  session_duration           = local.defaults.access.session_duration
  http_only_cookie_attribute = true
  app_launcher_visible       = true
}

import {
  to = cloudflare_zero_trust_access_application.root
  id = "account/${var.account_id}/${var.root_app_id}"
}

# Replaces the previous ad-hoc email-based policy with an org-members
# allow policy. NOTE: the old policy was not Terraform-managed and its id
# is not known to this config (not listed in the import constraints) — the
# runbook (infra/README.md) documents deleting it manually after apply so
# it does not linger alongside this one.
resource "cloudflare_zero_trust_access_policy" "root_allow" {
  application_id = cloudflare_zero_trust_access_application.root.id
  account_id     = var.account_id
  name           = "org-members-allow"
  decision       = "allow"
  precedence     = 1

  include {
    group = [cloudflare_zero_trust_access_group.this["org-members"].id]
  }
}

############################################
# Per-app token + linking applications, compiled from manifest.apps.
#
#   token app:   broker.jsmunro.me/get-token/<slug>[/*]
#                Policy: allow union of access.allow_groups
#                        + non_identity service-token policy when
#                          access.service_token is true.
#   linking app: broker.jsmunro.me/callback/<slug>[/*]
#                Policy: same groups PLUS require rules compiled from
#                        link_policy (require_warp / require_posture) —
#                        the linking flow is stricter than plain token
#                        fetches.
############################################

resource "cloudflare_zero_trust_access_application" "token" {
  for_each = local.apps

  account_id           = var.account_id
  name                 = "broker-token-${each.value.key}"
  domain               = "${var.domain}/get-token/${each.key}"
  type                 = "self_hosted"
  session_duration     = each.value.session_duration
  app_launcher_visible = false

  self_hosted_domains = [
    "${var.domain}/get-token/${each.key}",
    "${var.domain}/get-token/${each.key}/*",
  ]
}

resource "cloudflare_zero_trust_access_policy" "token_allow" {
  for_each = local.apps

  application_id = cloudflare_zero_trust_access_application.token[each.key].id
  account_id     = var.account_id
  name           = "allow-groups"
  decision       = "allow"
  precedence     = 1

  include {
    group = [for g in each.value.allow_groups : cloudflare_zero_trust_access_group.this[g].id]
  }
}

resource "cloudflare_zero_trust_access_policy" "token_service" {
  for_each = { for k, v in local.apps : k => v if v.service_token }

  application_id = cloudflare_zero_trust_access_application.token[each.key].id
  account_id     = var.account_id
  name           = "allow-service-token"
  decision       = "non_identity"
  precedence     = 2

  include {
    service_token = [cloudflare_zero_trust_access_service_token.this[each.key].id]
  }
}

resource "cloudflare_zero_trust_access_application" "link" {
  for_each = local.apps

  account_id           = var.account_id
  name                 = "broker-link-${each.value.key}"
  domain               = "${var.domain}/callback/${each.key}"
  type                 = "self_hosted"
  session_duration     = each.value.session_duration
  app_launcher_visible = false

  self_hosted_domains = [
    "${var.domain}/callback/${each.key}",
    "${var.domain}/callback/${each.key}/*",
  ]
}

resource "cloudflare_zero_trust_access_policy" "link_allow" {
  for_each = local.apps

  application_id = cloudflare_zero_trust_access_application.link[each.key].id
  account_id     = var.account_id
  name           = "allow-groups-link-policy"
  decision       = "allow"
  precedence     = 1

  include {
    group = [for g in each.value.allow_groups : cloudflare_zero_trust_access_group.this[g].id]
  }

  # require_warp -> the id of the account-scoped `warp` device_posture_rule
  # defined below (device_posture entries must be real posture-integration
  # rule ids, not the literal string "warp").
  # require_posture -> device-posture integration ids configured elsewhere
  # (e.g. Crowdstrike, Tanium); empty by default (manifest defaults), passed
  # through verbatim.
  dynamic "require" {
    for_each = length(local.link_require_posture[each.key]) > 0 ? [local.link_require_posture[each.key]] : []
    content {
      device_posture = require.value
    }
  }
}

############################################
# WARP-client device posture check, referenced by link_require_posture
# (infra/main.tf) wherever a manifest app sets link_policy.require_warp.
# One account-scoped rule shared by all apps that require it.
############################################

resource "cloudflare_zero_trust_device_posture_rule" "warp" {
  account_id  = var.account_id
  name        = "broker WARP check"
  description = "Requires the Cloudflare WARP client to be connected."
  type        = "warp"

  match {
    platform = "windows"
  }
  match {
    platform = "mac"
  }
  match {
    platform = "linux"
  }
  match {
    platform = "android"
  }
  match {
    platform = "ios"
  }
  match {
    platform = "chromeos"
  }
}

############################################
# Service tokens — one per app with access.service_token = true.
# Attached to the token app via the non_identity policy above.
############################################

resource "cloudflare_zero_trust_access_service_token" "this" {
  for_each = { for k, v in local.apps : k => v if v.service_token }

  account_id = var.account_id
  name       = "broker-${each.value.key}"
}

############################################
# Bookmark / App Launcher entries — apps with bookmark.app_launcher = true
# in the manifest. None currently declared in phase 1; this for_each is
# empty by construction and exists so adding a bookmark is a manifest edit,
# not a Terraform change (same pattern as the gated Okta IdP below).
############################################

resource "cloudflare_zero_trust_access_application" "bookmark" {
  for_each = { for k, v in local.apps : k => v if v.bookmark_app_launcher }

  account_id           = var.account_id
  name                 = each.value.display_name
  domain               = "${var.domain}/get-token/${each.key}"
  type                 = "bookmark"
  app_launcher_visible = true
}
