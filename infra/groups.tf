############################################
# Access Groups — compiled from manifest.groups
#
# A group's rules are OR-ed together (Cloudflare Access `include` semantics):
# a principal matching ANY compiled rule satisfies the group.
#
#   github_team: null   -> GitHub-org rule, org-wide (no team filter).
#                          Phase-1 uses this as a break-glass-adjacent OR
#                          alongside explicit emails (see manifest comment).
#   github_team: "<t>"  -> GitHub-org rule scoped to that team.
#   okta_group: "<g>"   -> Okta group rule, bound to the (placeholder) Okta
#                          IdP. Created but unusable until Okta is activated.
#   emails: [...]        -> one email include with all addresses.
############################################

resource "cloudflare_zero_trust_access_group" "this" {
  for_each = local.groups_raw

  account_id = var.account_id
  name       = "broker-${each.key}"

  dynamic "include" {
    for_each = contains(keys(each.value), "github_team") ? [each.value.github_team] : []
    content {
      github {
        name                 = var.github_org
        identity_provider_id = var.github_idp_id
        teams                = include.value != null ? [include.value] : null
      }
    }
  }

  dynamic "include" {
    for_each = try(each.value.okta_group, null) != null ? [each.value.okta_group] : []
    content {
      okta {
        name                 = [include.value]
        identity_provider_id = try(cloudflare_zero_trust_access_identity_provider.okta[0].id, "PLACEHOLDER")
      }
    }
  }

  dynamic "include" {
    for_each = length(try(each.value.emails, [])) > 0 ? [each.value.emails] : []
    content {
      email = include.value
    }
  }
}
