############################################
# Workers KV namespace — AUTH_TOKENS binding (imported, existing resource).
############################################

resource "cloudflare_workers_kv_namespace" "auth_tokens" {
  account_id = var.account_id
  title      = var.kv_namespace_title
}

import {
  to = cloudflare_workers_kv_namespace.auth_tokens
  id = "${var.account_id}/${var.kv_namespace_id}"
}
