output "app_auds" {
  description = "Per-slug token/link Access application AUDs. Consumed by infra/sync-auds.sh to populate wrangler.toml's ACCESS_APP_AUDS var."
  value = {
    for k, v in local.apps : k => {
      token = cloudflare_zero_trust_access_application.token[k].aud
      link  = cloudflare_zero_trust_access_application.link[k].aud
    }
  }
}

output "service_tokens" {
  description = "Per-slug Access service tokens for apps with access.service_token = true. Sensitive — retrieve with `terraform output -json service_tokens`."
  value = {
    for k, v in cloudflare_zero_trust_access_service_token.this : k => {
      id            = v.id
      client_id     = v.client_id
      client_secret = v.client_secret
    }
  }
  sensitive = true
}

output "access_group_ids" {
  description = "Access group ids keyed by manifest group name."
  value = {
    for k, v in cloudflare_zero_trust_access_group.this : k => v.id
  }
}

output "root_app_id" {
  description = "Root Access application id (dashboard/API)."
  value       = cloudflare_zero_trust_access_application.root.id
}
