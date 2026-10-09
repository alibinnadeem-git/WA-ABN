# WA-ABN Feature Matrix

| Capability | Module / control | Default | Notes |
|---|---|---:|---|
| Linked-device WhatsApp transport | core | On | Baileys-based |
| AES-256-GCM auth-state encryption | core | On | Required encryption key |
| Multiple authorized groups | core | On | `WA_ALLOWED_GROUP_JIDS` |
| Sender allowlist | core | Optional | `WA_ALLOWED_SENDER_JIDS` |
| Rate limits | core | On | Per sender |
| Media limits | core | On | Pre/post download |
| Scheduler / reminders | scheduler | On | Persisted across restart |
| Poll creation | polls | On | Authorized groups only |
| Contact/group utilities | contacts | On | Self/group metadata commands |
| Delivery/read receipt capture | receipts | On | Stored only if history enabled |
| Message history | history | Off | Privacy-sensitive; opt in |
| Cross-source search | search | On | CRM/history if enabled |
| Operational digest | digests | On | On-demand |
| Ops Dashboard | dashboard | Off | Read-only, localhost default |
| Health endpoint | dashboard | Off | Available with dashboard |
| Prometheus metrics | dashboard | Off | Authenticated |
| Security audit | core | On | JSONL |
| Session backups | backups | On | Encrypted auth files remain encrypted |
| Retry queue | retry | On | Failed work visibility |
| Safe outbound webhooks | integrations | Off | HTTPS + allowlist + SSRF controls |
| Vendor/session namespacing | core | Required | Explicit TENANT_ID and WA_SESSION_ID; separate deployed services |
| AI lead extraction | AI | CRM-dependent | Optional |
| Lead enrichment | AI | CRM-dependent | Optional |
| Google Sheets CRM | CRM | On for legacy compatibility | Can be disabled |
| Duplicate detection | CRM | On | Email/phone |
| Pipeline stage | CRM | On | Generic stage string |
| Owner assignment | CRM | On | `!assign` |
| Follow-up due date | CRM | On | `!followup` |
| Activity timeline | CRM | On | Sheet-backed |
| Pipeline summary | CRM | On | `!pipeline` |
| Sheet/export link | CRM | On | `!sheet` |
| STRATUM lead application | profile | Example | Same repo, not fork |

## Deliberately excluded from the generic remote surface

These capabilities can be added as project modules, but are not enabled as broad Internet-facing APIs in the core because they substantially increase compromise impact:

- unauthenticated/public REST send endpoints;
- bulk blast messaging;
- public Swagger consoles;
- remote shell execution;
- arbitrary group administration;
- arbitrary webhook destinations;
- author-controlled telemetry;
- remote self-update execution.

## Reuse model

A new application should normally add a profile under `profiles/` and enable modules. Only application-specific business logic should require a new code module.

## Vendor confidentiality

Customer deployments are fully white-labeled and isolated from one another. A vendor must never share another vendor's WhatsApp number, data volume, service account, provider keys, group allowlist, dashboard, integrations, backups or monitoring. See [VENDOR_CONFIDENTIALITY.md](VENDOR_CONFIDENTIALITY.md).
