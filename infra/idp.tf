############################################
# Okta identity provider — gated, placeholder credentials.
#
# count = 0 (var.okta_enabled defaults to false) so the placeholder
# variables never create anything real; the resource shape below is the
# deliverable for phase 1. Flip okta_enabled to true and supply real
# okta_* variables (via *.auto.tfvars, gitignored) once Okta is activated
# (phase 5, out of scope here).
#
# claims requested: amr (auth method reference, for future require_mfa),
# groups, device_trusted, risk_level. Adjust to whatever the real Okta
# authorization server actually mints.
############################################

resource "cloudflare_zero_trust_access_identity_provider" "okta" {
  count = var.okta_enabled ? 1 : 0

  account_id = var.account_id
  name       = "okta"
  type       = "okta"

  config {
    client_id               = var.okta_client_id
    client_secret           = var.okta_client_secret
    okta_account            = var.okta_account
    authorization_server_id = var.okta_authorization_server_id
    claims                  = ["amr", "groups", "device_trusted", "risk_level"]
  }
}
