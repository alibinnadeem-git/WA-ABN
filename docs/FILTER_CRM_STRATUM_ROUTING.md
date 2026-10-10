# Podium CRM → existing STRATUM CRM

**Podium CRM is its own application.** STRATUM CRM (the separate private `alibinnadeem-git/StratumCRM` Next.js/Neon system) remains the **only authoritative STRATUM CRM database**. Do not create another STRATUM database, and do not send all captured leads to STRATUM by default.

## Data flow

WhatsApp → Podium CRM local staging queue → rule-based classification (STRATUM_RELATED, UNRELATED, NEEDS_REVIEW) → human review → secure HMAC-signed webhook → existing STRATUM CRM `CONTACT` record.

- **STRATUM_RELATED** means a qualified *candidate*, not an approved send. The source text must contain demonstrable electrical/power/data-center project evidence. `score` is a rules-confidence indicator, not a prediction of commercial fit.
- **UNRELATED** stays in Podium CRM; no STRATUM data transfer.
- **NEEDS_REVIEW** stays in Podium CRM. No automatic promotion or transfer.
- All related candidates must be **explicitly approved** by an administrator with a reason. Missing email and phone can be staged for review but cannot be approved for transfer.
- After approval, signed single dispatch or reviewed-batch dispatch is allowed. Batch dispatch is blocked if there is any unresolved classification or unapproved relevant candidate.
- The STRATUM CRM receiver either creates a new CONTACT, acknowledges an existing source ID, or marks a potential existing contact as `needs_review_existing` without modifying it.

## Separate systems / credentials

Podium CRM: `TENANT_ID=filter-crm`, private `DATA_DIR`, its own WhatsApp number/auth key, its own admin API tokens, no Google Sheets required, private persistent `filter-leads.json`. It is NOT co-located or database-linked to STRATUM CRM.

STRATUM CRM: keeps its **current Neon production database**; its own deployment and secrets. The only new route is `POST /api/integrations/filter-crm/leads`. Podium CRM never receives Neon credentials.

**This is a single STRATUM destination module, not cross-vendor sharing.** Other vendors must have independent deployments and credentials. Do not publish the Podium CRM approval API on the open Internet; it binds to loopback and should be accessed by private network/SSH tunnel.

## Configure safely

1. Copy `profiles/stratum-filter-crm.env.example` to a **private** deployment configuration. Fill unique `WA_AUTH_ENCRYPTION_KEY`, `ADVANCED_VIEW_TOKEN`, `ADVANCED_OPERATOR_TOKEN`, `ADVANCED_ADMIN_TOKEN`, authorized group/sender JIDs, and storage path.
2. Keep `FEATURE_LEAD_CRM=false` and `FEATURE_FILTER_CRM=true` for standalone staging. You do not need Google Sheets. Set `FEATURE_AI_EXTRACTION=false` initially (manual `!lead`), or enable to capture photos, vCards and explicit `!capture ...` using an **authorized** AI key (possible provider charges).
3. Generate one shared integration secret (minimum 32 characters; e.g. `openssl rand -base64 48`). Store it privately as `FILTER_STRATUM_CRM_SECRET` in Podium CRM and `FILTER_CRM_WEBHOOK_SECRET` in the STRATUM CRM application.
4. Configure `FILTER_STRATUM_CRM_ENDPOINT=https://stratum-electric-crm.vercel.app/api/integrations/filter-crm/leads` and `FILTER_STRATUM_CRM_ALLOWED_HOST=stratum-electric-crm.vercel.app`. The URL uses HTTPS and exact host/path validation.
5. Start with `FILTER_STRATUM_AUTO_DISPATCH=false` and use explicit dispatch after review. If enabled later, **review approval** triggers signed delivery; unapproved records still never send.

Never put secrets or real leads in this repository, issue, PR, build log or support message.

## REST endpoints

The private Podium CRM advanced API uses `Authorization: Bearer <ADVANCED_ADMIN_TOKEN>` for all filter routes:

| Method/path | Action |
|---|---|
| `GET /v1/filter/leads` | Lead list, classification and delivery counts |
| `GET /v1/filter/leads?disposition=NEEDS_REVIEW` | Unresolved list |
| `POST /v1/filter/leads/{uuid}/decision` | Reviewer decision |
| `POST /v1/filter/leads/{uuid}/dispatch` | Transfer a single approved candidate |
| `POST /v1/filter/dispatch-approved` | Batch transfer when **all** leads have completed review; max 25 per request |

Example decision:
```json
{"reviewer":"Authorized reviewer","disposition":"STRATUM_RELATED","note":"Verified request for medium-voltage electrical distribution installation"}
```

Example batch commit:
```json
{"confirm":"DISPATCH_FILTERED_LEADS"}
```

A dispatch returns `delivered`, `needs_crm_review` (matched existing CRM contact, no overwrite), or `failed` with bounded error. A failed delivery may be manually retried; the receiver's unique externalKey prevents replay duplicates. Never interpret `needs_crm_review` as an imported contact.

## WhatsApp ingestion

Manual format (no paid AI): `!lead Full Name | Company | Email | Phone | Notes`. Lead staging happens before any optional Google Sheets processing. With AI enabled, the bot accepts card images/vCards or explicit `!capture Person and company...` and places extracted leads into the same review queue. Ordinary non-capture chatter is not sent to the AI provider.

## Data boundary / release gates

- Staging contains potentially sensitive lead information; it must reside on a dedicated encrypted-at-rest managed volume with restricted operators. Current JSON-file staging is a single-process pilot implementation, not a multi-instance transactional database.
- Add retention/consent/opt-out requirements and real-device tests before production usage. Do not send unsolicited marketing or expose an open bulk-mailing gateway.
- HMAC covers the exact JSON body and millisecond timestamp (5-minute freshness). The receiver alone accesses its existing Neon database.
- Source identity `filter-crm:wa-abn:<uuid>` is unique in the destination CRM. Exact email/phone collision is flagged for human reconciliation; automatic account merge is intentionally excluded.
- Verify end-to-end two-app UAT, secret provisioning, API status, reconnects, signed delivery and duplicate detection before enabling automation.

See matching receiver implementation in the private `StratumCRM` repository.
