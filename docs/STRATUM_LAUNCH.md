# STRATUM Power — WhatsApp CRM Launch Plan

**Application:** STRATUM Power lead intelligence and follow-up.
**Platform:** WA-ABN main upstream. No fork, no vendor-wide shared data.
**Status:** Pilot configuration prepared; **not deployed, not connected to a live WhatsApp number**.
**Tenant:** `stratum`. Each STRATUM session receives its own deployment, DATA_DIR, WhatsApp account, encryption keys, CRM credentials and dashboard authentication.

## Business objective

Enable authorized STRATUM teammates to capture business leads at conferences or in the field using WhatsApp, deduplicate them into an independent Google Sheet, assign follow-ups and track progress in an operational dashboard. Support both manual (provider-free) and AI-assisted workflows, with clear confidence and provenance.

Focus on electrical/power infrastructure, AI/data centers, high-tech/industrial construction, manufacturing, energy, healthcare, commercial campuses and related EPC&C, service and maintenance opportunities. Do not infer contact identity, title, employer, available budget or commercial interest without evidence.

## Pilots

### Pilot A — manual CRM, no paid AI provider

Config template: `profiles/stratum-manual-pilot.env.example`.

- WhatsApp lead intake: `!lead Full Name | Company | Email | Phone | Notes`
- Event tagging: `!event <name>`
- Duplicate checking on normalized email/phone, updates existing notes instead of adding another person
- Google Sheets CRM with pipeline stage, owner, due date, last activity and timeline fields
- `!assign`, `!stage`, `!followup`, `!search`, `!pipeline`, `!digest`
- Group trust boundary and sender rate limits
- No Anthropic key and no AI extraction calls. Unstructured cards must be manually typed; free OCR is not claimed.
- Optional read-only Ops Dashboard with its own token

The source code is free. Google Sheets API has service quotas; deployment/hosting or external providers may charge.

### Pilot B — AI-enhanced lead capture

Config template: `profiles/stratum-lead-crm.env.example`.

Everything in Pilot A plus:
- Business card images / WhatsApp vCards / free-form contact text
- AI extraction and optional web-enriched company/person details
- Source links, explicit low-confidence warnings, relevance ranking using configured industry profile
- Automated context requests after card capture

**External Anthropic API/web-research usage can incur charges.** It is opt-in by profile; the manual path remains available regardless.

## Launch sequence

| Gate | Action | Completion proof |
| --- | --- | --- |
| 1. Code | Merge STRATUM launch PR with green production build, typecheck, unit tests, Semgrep, OSV, CodeQL | GitHub CI run URLs |
| 2. Configuration | Create a STRATUM-only `.env` outside Git with `TENANT_ID=stratum`, dedicated `DATA_DIR`, random auth encryption key, bot name and feature flags | Configuration validated without displaying secrets |
| 3. WhatsApp | Provision/pair a dedicated STRATUM test number using Baileys; verify account consent and platform restrictions | Connected status from private deployment |
| 4. Group | Obtain pilot WhatsApp group JID and set `WA_ALLOWED_GROUP_JIDS`; optionally lock `WA_ALLOWED_SENDER_JIDS` | Only authorized group messages are accepted |
| 5. CRM | Create a dedicated STRATUM Google Sheet + service account with permission **only to that Sheet**; verify headers and row permissions | Schema automatically created/migrated to 29 columns ending in AC |
| 6. Lead intake | Send two original leads via `!lead`; send repeat email and repeat phone | Two distinct CRM rows, duplicates add notes only |
| 7. Workflow | Run `!event`, `!search`, `!pipeline`, `!assign`, `!stage`, `!followup`, `!digest` | Evidence captured; reminder arrives after due date |
| 8. Dashboard | Enable local-only Ops Dashboard with separate random token via private access path | Authorized metrics/CRM queries; unauthorized access rejected |
| 9. Restart | Disconnect/reconnect, restart process and confirm encrypted WhatsApp auth, single digest timer, notes and scheduled reminders remain | Recorded recovery run |
| 10. AI optional | Enable AI with a **STRATUM-only** key; upload actual card photo, two-card photo and vCard with consent | Extraction accuracy reviewed against originals and matched with sources |
| 11. Advanced optional | Enable only needed campaign/admin/API capabilities; test against permitted recipients and actual account | Human-approved live UAT, no unexpected sends |
| 12. Release | Review retention, event/rate-limit policy, vendor-only backups, opt-outs, costs and access | Signed-off release checklist |

## Production prerequisites

- Dedicated WhatsApp number / linked device and consent to operate automation; unofficial linked-device libraries may incur account-policy risk.
- Dedicated STRATUM-only Google Sheet ID and a Google service-account JSON credential.
- Private deployment host/container/storage and a persistent volume exclusively assigned to `TENANT_ID=stratum`.
- Random 32-byte `WA_AUTH_ENCRYPTION_KEY`, dashboard token when used, and optional AI key in a secret store.
- Approved WhatsApp group JIDs (and sender allowlist if required).
- Opted-in recipients and operator approval before outbound campaigns.

Never commit, paste into public GitHub issues, or send production secrets in documentation. A public upstream repo exposes its templates and business names; vendor-specific code/configuration/credentials and build infrastructure should be kept private. Moving the upstream repository to private visibility is recommended for confidentiality.

## Demo walkthrough

1. Post `!event Client Visit Oct 2026` to the approved test group.
2. Post `!lead Jane Smith | Example Facilities | jane.smith@example.com | +1 415 555 0123 | Need electrical distribution upgrade`.
3. Bot checks duplicates, writes the row with `Pipeline Stage=New` and returns a row link.
4. Post the exact same email/phone again with updated notes; bot appends a repeat-contact note instead of another row.
5. Post `!pipeline`, then `!assign 2 Team Lead` and `!stage 2 Qualified`.
6. Post `!followup 2 1h Call about requirements`; confirm scheduled reminder and tracking.
7. Post `!digest` and inspect CRM dashboard once enabled.
8. Only for the AI pilot: submit a permitted card image, check OCR against the original and manually review AI enrichment.

**Important:** The above is an acceptance script, not a claim that the demo was executed live.

## Release boundaries

WA-ABN issue #11 tracks capabilities still not built (unified inbox, Chatwoot, official Cloud API, consent/opt-out registry, full SDK and further adapters). Those remain **platform backlog**, not blockers for the small manual CRM pilot unless the STRATUM product scope explicitly requires them. The STRATUM pilot itself is not production-approved until the WhatsApp, Google Sheets and dashboard end-to-end tests have been observed.
