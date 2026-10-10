# Podium CRM → STRATUM CRM: Private Pilot Deployment Runbook

**Phase:** Deploy a dedicated, persistent Podium CRM worker only after secure credentials and an approved WhatsApp test account are available. The existing STRATUM CRM receiver is deployed separately on Vercel.

## Verified receiving service

- STRATUM CRM project: `stratum-electric-crm` (Vercel).
- Receiving repository: private `alibinnadeem-git/StratumCRM`.
- Receiver is implemented by PR #22; deployment of commit `d8fd34359b133806dc0009a472fe7653903c1c16` was observed `READY` in Vercel production on October 9, 2026.
- Endpoint URL (only to call from authorized sender): `https://stratum-electric-crm.vercel.app/api/integrations/filter-crm/leads`.
- At inspection time `FILTER_CRM_WEBHOOK_SECRET` was **not present** among the receiver project's production environment variable **names**. A route with no configured secret denies all writes. Provisioning the secret is still required.

## Why the Filter worker must not be deployed as a Vercel function

WA-ABN uses Baileys linked-device WebSocket, encrypted on-disk WhatsApp credentials, a durable per-vendor Podium CRM queue and source registry, and a long-lived process. Standard short-lived serverless functions are not a reliable home for that workload. Deploy Podium CRM to an always-on, vendor-private container host with persistent storage instead. No connected Podium CRM container host has yet been selected or deployed.

The Dockerfile and `deploy/vendor.compose.yml` provide a hardened starting point. Vendor storage is mounted at `/data`. The **container environment must say `DATA_DIR=/data`**, not `./data` (which is read-only in the production image).

## Preparation on approved container host

1. Assign a unique virtual machine/container host or isolated project to Podium CRM, with private disk encryption, backup policy and outbound TLS access.
2. Build the repository on a trusted machine/CI runner and tag the private image. Do not give users access to the internal upstream GitHub repository or build metadata.
3. Create an **uncommitted** application environment file readable only by the operator. Base it on `profiles/stratum-filter-crm.env.example`.
4. Generate independent keys for: the 32-byte `WA_AUTH_ENCRYPTION_KEY` (base64/hex), three distinct long advanced-API role tokens, and a **separate shared** 32+ character HMAC integration secret.
5. Provision the same HMAC secret once in STRATUM CRM production as `FILTER_CRM_WEBHOOK_SECRET` and in Podium CRM as `FILTER_STRATUM_CRM_SECRET`; keep values only in provider secret managers. Never paste them into issues, pull requests or application logs.
6. Confirm the Vercel production deployment was rebuilt/redeployed **after** adding the secret. Simply writing a new env var does not retroactively change an already running serverless deployment.
7. Pair a **dedicated authorized** WhatsApp account and approve actual `WA_ALLOWED_GROUP_JIDS`, `WA_ALLOWED_SENDER_JIDS` if used, and exact `FILTER_REVIEWER_JIDS`.
8. For the initial pilot keep `FEATURE_LEAD_CRM=false`, `FEATURE_FILTER_CRM=true`, `FEATURE_ADVANCED_API=true`, `FEATURE_AI_EXTRACTION=false`, and `FILTER_STRATUM_AUTO_DISPATCH=false`.
9. Restrict access to Podium CRM's advanced API and dashboard to loopback/private network, never an unauthenticated public port.
10. Document explicit group participant consent, retention of sensitive lead messages, and WhatsApp automation/account-policy risks.

## Preflight without sending data

From the root of the repository on a host with Node installed:

```bash
npm ci
npm run build
# With the private environment loaded by your process manager:
npm run preflight:filter
```

When running under the included Compose file, use:

```bash
docker compose --env-file /secure/filter-crm/compose.env -p filter-crm \
  -f deploy/vendor.compose.yml build

docker compose --env-file /secure/filter-crm/compose.env -p filter-crm \
  -f deploy/vendor.compose.yml run --rm app node dist/filter-preflight.js

# Only after the offline preflight passes, start the WhatsApp worker:
docker compose --env-file /secure/filter-crm/compose.env -p filter-crm \
  -f deploy/vendor.compose.yml up -d
```

The preflight checks whether the configuration is ready for pairing/test; it does **not** pair WhatsApp, call Anthropic, send messages or write to STRATUM CRM. Its output contains boolean readiness indicators, never key or contact values. A failed preflight exits nonzero.

## End-to-end acceptance gates

| Gate | Expected result |
| --- | --- |
| Vercel receiver deployment | Correct commit `READY`; secret configured for production |
| Podium CRM container | Running continuously with a vendor-private persistent `/data` volume |
| WhatsApp pairing | Dedicated account connected; session survives restart |
| Group control | Non-allowlisted groups/senders ignored; only authorized group data indexed |
| Ordinary conversation | Messages with no lead cues trigger no bot reply |
| Lead capture | One manual, one passive WhatsApp lead and one unrelated lead correctly classified |
| Private questions | Members ask `!ask` and quoted questions; answers cite only known captured fields |
| Reviewer policy | Unlisted JID cannot approve; listed reviewer can approve with rationale |
| Filtering complete | `!sendapproved` blocks while any candidate in group remains unreviewed |
| HMAC webhook | Approved lead receives `201 created` with source ID; forged/stale request receives `401` |
| Idempotency | Repeat same source ID returns `already_imported`, not a second contact |
| Existing CRM collision | Potential same email/phone returns `needs_review_existing`, no destructive change |
| No leakage | Unrelated and unresolved leads remain exclusively in Podium CRM |
| Failure recovery | Failed transfer retained for review/retry, not silently dropped |
| Logs/audit | No secrets, raw media or sensitive auth values printed |

## Current state versus requirements

As of inspection on October 9, 2026:
- **Ready:** the receiving STRATUM CRM Vercel production deployment at merge commit and merged/filter backend code, with automated CI.
- **Unverified:** actual webhook handshake, recipient secret provisioning, two-service live connection, WhatsApp device pairing, signed transfer into a real DB row, and persistent worker deployment.
- **Not fully implemented:** PDF/Office OCR, audio/video transcription and full original-media vault. See WA-ABN Issue #15.

Never claim "production live end-to-end" on code merge or Vercel `READY` alone.
