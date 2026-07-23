# infra — Terraform for central-auth-broker

Manages Cloudflare Zero Trust Access resources (applications, policies,
groups, service tokens, identity providers) plus the DNS record and Workers
KV namespace the broker Worker uses. `apps/manifest.json` (repo root) is
the single source of truth for apps/groups/access rules — this directory
compiles it into Cloudflare resources.

The Worker itself is deployed with `wrangler deploy` and is **not**
Terraform-managed.

## 0. Prerequisites

- Terraform >= 1.5 (or OpenTofu).
- A Cloudflare API token with Access, DNS, Workers KV, and (for bootstrap
  only) R2 permissions.
- `jq` (used by `sync-auds.sh` and `bootstrap.sh`).

## 1. Bootstrap remote state (one time per account)

```
export CLOUDFLARE_API_TOKEN=...   # Account > Workers R2 Storage:Edit (or broader, for this one-time step)
./infra/bootstrap.sh
```

This creates the `broker-terraform-state` R2 bucket and prints instructions
for creating a separate, R2-scoped API token and `infra/backend.hcl` (copy
from `backend.hcl.example`; gitignored, contains credentials).

## 2. Init

```
terraform -chdir=infra init -backend-config=backend.hcl
```

Set `TF_VAR_cloudflare_api_token` (or a `*.auto.tfvars`, gitignored) with an
Access/DNS/KV-scoped API token for actual resource management — this should
be a different, narrower token than the R2-bootstrap one above.

## 3. Import existing resources

The root Access app, the broker's DNS record, and its KV namespace were
created by hand (or by an earlier wrangler-only setup) before Terraform
existed. Their `import` blocks are already declared in this config
(`access.tf`, `dns.tf`, `kv.tf`) with the ids from the design doc's Global
Constraints, so a plain `plan`/`apply` will adopt them — no separate
`terraform import` invocation is required on Terraform >= 1.5.

**Before applying**, run a plan and confirm the imported resources show
**in-place updates only, never a replace/destroy**:

```
terraform -chdir=infra plan -out=tfplan
terraform -chdir=infra show tfplan | less
```

If any imported resource plans a replace, STOP — do not apply. Investigate
(a likely cause: `dns_record_content` or `kv_namespace_title` defaults in
`variables.tf` don't match the real values; both are just-in-case defaults
documented as "verify against plan" in their variable descriptions, not
guaranteed accurate).

Two things this config does **not** fully reconcile automatically:

- **The pre-existing email-based policy on the root app.** This config adds
  a new `org-members` allow policy but the old ad-hoc policy's id isn't
  known to Terraform (it predates this config and isn't in the import
  list). After apply, check the Access dashboard for the root app and
  delete the old email policy by hand if it's still present, so only the
  Terraform-managed `org-members-allow` policy remains.
- **Okta.** The Okta IdP resource is gated behind `var.okta_enabled`
  (default `false`) and uses `"PLACEHOLDER"` credentials — it creates
  nothing until real Okta credentials are supplied and `okta_enabled` is
  flipped to `true` (phase 5, out of scope for phase 1).

## 4. Apply

The controller reviews the plan; this task does **not** apply.

```
terraform -chdir=infra apply tfplan
```

## 5. Sync AUDs into the Worker config

After apply, before deploying the Worker:

```
./infra/sync-auds.sh
```

This reads the `app_auds` Terraform output and rewrites the
`ACCESS_APP_AUDS` line in `../wrangler.toml` in place (idempotent — safe to
re-run). **Mandatory order:** `terraform apply` → `sync-auds.sh` →
`wrangler deploy`. Deploying the Worker before syncing AUDs means any
newly-added manifest slug fails closed (403) until the sync runs — see
spec §2.

## 6. Retrieving secrets

- Service tokens (client id/secret for apps with `access.service_token:
  true`):

  ```
  terraform -chdir=infra output -json service_tokens
  ```

  Sensitive — do not log or commit. Feed the relevant client id/secret into
  whatever CI/service consumes it (e.g. `CF-Access-Client-Id` /
  `CF-Access-Client-Secret` headers per `scripts/cf-auth.sh`'s machine
  path).

- Access group ids (for cross-referencing in the Cloudflare dashboard):

  ```
  terraform -chdir=infra output -json access_group_ids
  ```

## 7. Adding a new app

Edit `apps/manifest.json` only — add an entry under `apps[]` (and a new
group under `groups{}` if needed). Do not hand-edit `infra/*.tf` for a new
app; the `for_each` over the manifest picks it up automatically. Then:

```
terraform -chdir=infra plan
terraform -chdir=infra apply
./infra/sync-auds.sh
wrangler deploy
```

## Files

| File | Purpose |
| --- | --- |
| `main.tf` | Provider/backend config, manifest `jsondecode`, shared locals, reference-check precondition |
| `variables.tf` | Inputs, including import-target ids/defaults from Global Constraints |
| `groups.tf` | `cloudflare_zero_trust_access_group` compiled from `manifest.groups` |
| `access.tf` | Root app (imported), per-app token/link apps, policies, service tokens, bookmarks |
| `idp.tf` | Gated Okta identity provider (placeholder, `okta_enabled = false` by default) |
| `dns.tf` | Imported AAAA record for `broker.jsmunro.me` |
| `kv.tf` | Imported `AUTH_TOKENS` Workers KV namespace |
| `outputs.tf` | `app_auds`, `service_tokens` (sensitive), `access_group_ids`, `root_app_id` |
| `bootstrap.sh` | One-time R2 state bucket creation + backend setup instructions |
| `sync-auds.sh` | Patches `wrangler.toml`'s `ACCESS_APP_AUDS` from the `app_auds` output |
| `backend.hcl.example` | Template for the gitignored `backend.hcl` |
