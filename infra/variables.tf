variable "cloudflare_api_token" {
  description = "Cloudflare API token with Access, DNS, Workers KV and R2 permissions. Provide via CLOUDFLARE_API_TOKEN env var or TF_VAR_cloudflare_api_token."
  type        = string
  sensitive   = true
}

variable "account_id" {
  description = "Cloudflare account id."
  type        = string
  default     = "314e7e015b5f4429c4e2da1e6ec93271"
}

variable "zone_id" {
  description = "Cloudflare zone id for jsmunro.me."
  type        = string
  default     = "0317fdb8f32686c5173f4bcd7c5d1690"
}

variable "domain" {
  description = "Domain the broker Worker is routed on."
  type        = string
  default     = "broker.jsmunro.me"
}

# ------------------------------------------------------------------
# Import targets (Global Constraints — existing, hand-created resources)
# ------------------------------------------------------------------

variable "root_app_id" {
  description = "Existing Access application id for the broker root app (dashboard/API), to be imported."
  type        = string
  default     = "33bb3ebb-7ed0-45e0-9c1f-77acd3e8ad8f"
}

variable "dns_record_id" {
  description = "Existing DNS record id for the AAAA record at broker.jsmunro.me, to be imported."
  type        = string
  default     = "634124b825375f4f95964d6826b4c220"
}

variable "dns_record_content" {
  description = <<-EOT
    Content of the imported AAAA record. Cloudflare-proxied records that only
    exist to have DNS resolve to Cloudflare's edge (actual routing is done by
    the Worker route, not this record) conventionally use the black-hole
    address "100::". Verify against `terraform plan` after import and adjust
    if the real record differs — this must express current reality.
  EOT
  type        = string
  default     = "100::"
}

variable "kv_namespace_id" {
  description = "Existing Workers KV namespace id (AUTH_TOKENS binding), to be imported."
  type        = string
  default     = "ef17d3c055e34a8699a596d47878e44c"
}

variable "kv_namespace_title" {
  description = <<-EOT
    Title of the imported KV namespace. `wrangler kv:namespace create` names
    namespaces "<worker-name>-<BINDING>" by convention. Verify against
    `terraform plan` after import and adjust if the real title differs.
  EOT
  type        = string
  default     = "central-auth-broker-AUTH_TOKENS"
}

variable "github_org" {
  description = "GitHub organization used for github_team group rules."
  type        = string
  default     = "jsmunro"
}

variable "github_idp_id" {
  description = "Access identity provider id for the GitHub org IdP."
  type        = string
  default     = "db8cf4be-fe22-4119-9346-6baf1a6d3f8a"
}

# ------------------------------------------------------------------
# Okta IdP — gated, placeholder until activated (phase 5)
# ------------------------------------------------------------------

variable "okta_enabled" {
  description = "Create the Okta identity provider. Keep false until real Okta credentials exist."
  type        = bool
  default     = false
}

variable "okta_account" {
  description = "Okta account subdomain, e.g. \"example\" for example.okta.com. Placeholder until Okta is activated."
  type        = string
  default     = "PLACEHOLDER"
}

variable "okta_client_id" {
  description = "Okta OIDC application client id. Placeholder until Okta is activated."
  type        = string
  default     = "PLACEHOLDER"
}

variable "okta_client_secret" {
  description = "Okta OIDC application client secret. Placeholder until Okta is activated."
  type        = string
  sensitive   = true
  default     = "PLACEHOLDER"
}

variable "okta_authorization_server_id" {
  description = "Okta custom authorization server id (mints the amr/groups/device_trusted/risk_level claims). Placeholder until Okta is activated."
  type        = string
  default     = "PLACEHOLDER"
}
