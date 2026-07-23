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

############################################
# One-Time-PIN IdP — the break-glass login path. The org-members group
# includes an explicit email; without a non-GitHub IdP on the apps'
# allowed_idps lists that email include is unreachable during a GitHub
# IdP outage (final-review Finding 1). OTP restores it: the break-glass
# email can request a login code. Policies still gate WHO gets in.
############################################

resource "cloudflare_zero_trust_access_identity_provider" "otp" {
  account_id = var.account_id
  name       = "One-time PIN (break-glass)"
  type       = "onetimepin"
  config {}
}
