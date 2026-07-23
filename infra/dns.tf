############################################
# DNS — AAAA record for broker.jsmunro.me (imported, existing resource).
############################################

resource "cloudflare_record" "broker" {
  zone_id = var.zone_id
  name    = "broker"
  type    = "AAAA"
  content = var.dns_record_content
  proxied = true
  ttl     = 1 # auto/managed by Cloudflare when proxied
}

import {
  to = cloudflare_record.broker
  id = "${var.zone_id}/${var.dns_record_id}"
}
