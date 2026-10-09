# WA-ABN — Vendor confidentiality and isolation

## Operating rule

**One internal codebase, many independent vendor services.** A vendor sees its own brand and application only. Do not identify unrelated vendors or reuse another vendor's screenshots, domains, identifiers, reports, bots, leads, conversations, or system credentials.

*Software reuse is not data sharing.* This repo is the internal engineering source and should not be granted to vendors merely because they use a hosted application. Do not make unsupported exclusivity representations: if a customer contract requires source delivery or a code license includes attribution/disclosure obligations, honor those obligations.

## Non-negotiable deployment separation

Each independent vendor must have:
- Its **own deployment/container and private storage volume**, preferably its own isolated cloud project/account for high-assurance customers;
- Its **own TENANT_ID, APP_ID, APP_NAME, BOT_DISPLAY_NAME, domain, dashboard authentication secret**, and separate URL;
- Its **own WhatsApp number, WA_SESSION_ID, WA_AUTH_ENCRYPTION_KEY**, authorized group/sender lists and dedicated encryption key custody;
- Its **own Google account/service account/Sheet**, if the CRM module is enabled;
- Its **own AI provider API key, webhook destination/token, and any integration credentials** when those integrations are enabled;
- Its **own log, monitoring, backup, export, retention, and recovery scope** with vendor-specific access controls;
- Its **own configuration and deployment permissions**; no customer login can reach another vendor's container or secret manager;
- No cross-vendor aggregation into a customer-visible dashboard or application search.

The security boundary is **deployment isolation**, not merely a tenant ID or folder naming convention. When vendors must have no shared trust domain, do not run them in the same OS process or share a Docker volume. Separate cloud projects/accounts and keys offer stronger isolation than separate containers on a shared host.

## Tenant-scoped storage layout

Required at process startup:

```dotenv
TENANT_ID=vendor-alpha
WA_SESSION_ID=primary
APP_ID=vendor-alpha-operations
APP_NAME="Vendor Alpha Operations"
BOT_DISPLAY_NAME="Vendor Alpha Assistant"
APP_DESCRIPTION="Internal team operations"
WA_AUTH_ENCRYPTION_KEY=<unique 32-byte key; never reuse>
OPS_DASHBOARD_TOKEN=<unique secret; required if dashboard on>
```

The runtime stores its sensitive files under:

```text
DATA_DIR/tenants/<TENANT_ID>/sessions/<WA_SESSION_ID>/
  wa-auth/                 # encrypted WhatsApp auth material
  state.json
  scheduled-jobs.json
  message-history.jsonl    # only if enabled
  security-audit.jsonl
  retry-queue.json
  backups/
```

TENANT_ID and WA_SESSION_ID are mandatory strict slugs. Path components such as `..`, slashes, URL-encoded paths, and whitespace are rejected. Startup does not silently read the old shared `DATA_DIR` root. Tests in `tests/tenant.test.ts` cover these boundaries.

## White-label presentation

The dashboard HTML title, heading, description, HTTP Basic authentication realm, CLI dashboard log and WhatsApp status must use the vendor's configured names. The customer-visible status endpoint must **not** disclose internal repo names, upstream brands, git commit IDs, other vendor IDs, or an inventory of unrelated deployments.

Operators must also configure distinct domains, customer support identity, outbound email, any exported file templates, and a vendor-specific image identity. Do not grant vendors source repository/CI access by default. Similar behavior or UI cannot be made mathematically undiscoverable; white labeling does not constitute a guarantee that no one can recognize shared software.

## Example — independent Docker Compose projects

Store each vendor's `application.env` and `compose.env` **outside the repository** and never expose them via GitHub artifacts:

```bash
docker compose -p vendor-alpha -f deploy/vendor.compose.yml \
  --env-file /secure/vendor-alpha/compose.env up -d

docker compose -p vendor-beta -f deploy/vendor.compose.yml \
  --env-file /secure/vendor-beta/compose.env up -d
```

Compose project names allocate independent network and named storage volumes. Different env files supply unique tenant IDs, brand, keys, WhatsApp number, groups and CRM credentials. There are no published ports by default. For the dashboard, expose only through **that vendor's private authenticated gateway**.

The example is an isolation reference, not a proof that two containers on one shared host have independent kernel security. Use separate cloud accounts/projects for the strongest separation.

## Upgrade from v2 / legacy storage

Legacy sessions may have been stored in `DATA_DIR/wa-auth` (the default session) or `DATA_DIR/sessions/<session>`. The new version will **not** automatically import that legacy data, since it cannot reliably attribute it to a vendor. Back up the old volume offline, verify ownership, and deliberately migrate a single vendor's files into its new scoped directory with permissions and secret continuity preserved. Never automatically copy a shared volume to multiple tenants.

If provenance of the existing WhatsApp session cannot be established, unlink the old linked device and pair a new vendor-dedicated account.

## Verification checklist

- Test that Vendor Alpha credentials, volumes, account identity, Sheet, webhooks, dashboard credentials, logs and exports are absent from Vendor Beta's deployment;
- Verify that the same `WA_SESSION_ID` under different `TENANT_ID` values points to completely different files;
- Confirm only authorized WhatsApp group JIDs are processed and external webhooks are vendor-specific;
- Run `npm test`, TypeScript, OSV, Semgrep and CodeQL;
- Carry out an actual two-deployment UAT before certifying vendor-grade confidentiality.

## Important boundary

Current controls protect data only when the operator deploys vendors as separate, locked-down services. There is **no** shared multi-tenant login system or central authorization authority and this repository does not claim independently audited tenant isolation.
