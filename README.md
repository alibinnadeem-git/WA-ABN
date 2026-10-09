# WA-ABN Platform

**WA-ABN is a secure, modular WhatsApp automation platform.** It is intended to be the reusable upstream repository for any WhatsApp-based application you build: lead capture, field operations, internal team workflows, notifications, intake, lightweight CRM, event coordination, reminders, polls, contact utilities, dashboards, and integrations.

STRATUM is **not a fork** of WA-ABN. It is one configurable profile stored in this same repository.

**Independent vendors do not share a live service.** Each vendor gets a separate branded deployment, WhatsApp account, data volume, secrets, dashboard and access permissions. See [Vendor Confidentiality](docs/VENDOR_CONFIDENTIALITY.md).

## Architecture

```
WhatsApp / Linked Device
        │
        ▼
Encrypted Baileys session
        │
        ▼
WA-ABN secure transport core
  ├─ group + sender policy
  ├─ rate/media limits
  ├─ encrypted auth state
  ├─ receipts/history
  ├─ commands
  ├─ scheduler
  ├─ audit/retry/backup
  └─ integration event bus
        │
        ├───────────────┬─────────────────┬──────────────────┐
        ▼               ▼                 ▼                  ▼
   Lead CRM        Ops Dashboard       Polls/Contacts    Future modules
   (optional)      (optional)          (optional)        / profiles
        │
        ▼
 Google Sheets + AI
 (optional backend)
```

The core is application-agnostic. Project-specific behavior is selected with environment configuration and feature flags.

## Included modules

- **Secure WhatsApp linked-device transport**
- **AES-256-GCM encrypted Baileys auth state**
- **Multiple authorized groups**
- **Optional sender allowlist**
- **Per-sender rate limiting**
- **Inbound media-size limits**
- **Persistent scheduler/reminders**
- **WhatsApp polls**
- **Contact / participant utilities**
- **Delivery/read receipt capture**
- **Optional local message history + search**
- **Operational digests**
- **Read-only authenticated Ops Dashboard**
- **Prometheus-style metrics + health endpoint**
- **Security audit log**
- **Encrypted-state/session backups**
- **Persistent retry queue**
- **Safe outbound HTTPS workflow hook with hostname allowlisting and private-IP blocking**
- **Session namespacing via `WA_SESSION_ID`**
- **Optional AI lead extraction/enrichment**
- **Optional Google Sheets CRM**
- **CRM pipeline stages**
- **Lead ownership**
- **Follow-up due dates + scheduled reminders**
- **Activity timeline**
- **Duplicate detection**
- **CRM search/export link**
- **CodeQL, Semgrep, OSV, npm audit, Dependabot**

See [docs/FEATURE_MATRIX.md](docs/FEATURE_MATRIX.md) for the module catalogue.

## Profiles: one repo, many applications

Copy a profile and configure it for the project:

```bash
cp profiles/generic.env.example .env
```

For the STRATUM lead workflow:

```bash
cp profiles/stratum-lead-crm.env.example .env
```

You can create additional profiles such as:

```
profiles/
  generic.env.example
  stratum-lead-crm.env.example
  field-service.env
  project-intake.env
  vendor-coordination.env
  event-operations.env
  customer-support.env
```

These are configuration profiles, **not forks**.

## Feature flags

Examples:

```dotenv
FEATURE_LEAD_CRM=false
FEATURE_AI_EXTRACTION=false
FEATURE_SCHEDULER=true
FEATURE_POLLS=true
FEATURE_CONTACTS=true
FEATURE_MESSAGE_HISTORY=false
FEATURE_RECEIPTS=true
FEATURE_SEARCH=true
FEATURE_DIGESTS=true
FEATURE_EXPORTS=true
FEATURE_PIPELINE=true
FEATURE_BACKUPS=true
FEATURE_RETRY_QUEUE=true
FEATURE_WEBHOOKS=false
```

Only enable modules the application needs.

## Generic commands

Enabled commands are shown by `!help`. Depending on feature flags:

- `!status`
- `!remind 2h Follow up with client`
- `!reminders`
- `!cancel <id>`
- `!poll Question | Option A | Option B`
- `!whoami`
- `!participants`
- `!search <query>`
- `!digest`
- `!backup` / `!backups`
- `!retries` / `!retry-resolve <id>`

CRM profile adds:

- `!event <name>`
- `!sheet`
- `!pipeline`
- `!assign <row> <owner>`
- `!stage <row> <stage>`
- `!followup <row> <2d> [note]`

## Multi-project / multi-session use

Use the **same repo** for multiple WhatsApp applications. Give each deployment a different:

```dotenv
TENANT_ID=vendor-a
APP_ID=project-a
APP_NAME="Vendor A Operations"
BOT_DISPLAY_NAME="Vendor A Assistant"
WA_SESSION_ID=project-a
```

WA-ABN stores each non-default session beneath:

```
DATA_DIR/tenants/<TENANT_ID>/sessions/<WA_SESSION_ID>/
```

Namespaced paths help prevent accidents, but **do not replace separate deployments, volumes, keys and permissions** for unrelated vendors.

For high reliability, run one process/container per WhatsApp session. This preserves isolation and makes failures, upgrades and secrets easier to manage than putting every account inside one process.

## Lead CRM profile

When `FEATURE_LEAD_CRM=true`, WA-ABN can:

1. read card photos, vCards and typed lead details;
2. ask for team context;
3. enrich the lead using the configured AI provider/tooling;
4. de-duplicate by email/phone;
5. write to Google Sheets;
6. track owner, follow-up, pipeline stage and activity timeline;
7. schedule follow-up reminders;
8. search and summarize the pipeline.

Google Sheets is **not required** for non-CRM applications.

## Ops Dashboard

Enable:

```dotenv
OPS_DASHBOARD_ENABLED=true
OPS_DASHBOARD_TOKEN=<32+ character random secret>
```

Secure defaults:

```dotenv
OPS_DASHBOARD_HOST=127.0.0.1
OPS_DASHBOARD_PORT=8787
```

The dashboard/API is read-only and exposes:

- runtime / connection status;
- enabled modules;
- session/profile identity;
- CRM summary and pipeline counts;
- lead/history search;
- reminders;
- retries;
- backups;
- recent security events;
- health and metrics.

It does **not** expose a general arbitrary-message send API.

## Safe workflow integration

WA-ABN can emit outbound events such as `lead.created` and `lead.duplicate` to n8n or another workflow service.

It is disabled by default:

```dotenv
FEATURE_WEBHOOKS=false
OUTBOUND_WEBHOOK_URL=
WEBHOOK_ALLOWED_HOSTS=
```

When enabled, WA-ABN requires HTTPS, rejects private/link-local/loopback destinations, rejects redirects, and can restrict delivery to an explicit hostname allowlist.

## Security model

Read [SECURITY.md](SECURITY.md).

Core principles:

- no author telemetry / phone-home;
- linked-device credentials encrypted at rest;
- fail closed on configured group/sender boundaries;
- no public dashboard by default;
- no arbitrary remote shell/update mechanism;
- optional modules disabled when unnecessary;
- security checks run on every PR;
- dedicated WhatsApp numbers recommended for automation;
- unofficial linked-device automation remains subject to WhatsApp platform/account risk.

## Run

```bash
cp profiles/generic.env.example .env
# configure unique TENANT_ID, WA_SESSION_ID, APP_ID, APP_NAME, BOT_DISPLAY_NAME
# configure a unique WA_AUTH_ENCRYPTION_KEY and desired modules
npm ci
npm run build
npm start
```

Generate secrets with:

```bash
openssl rand -base64 32
```

## Docker

```bash
docker build -t wa-abn .
docker run -d --restart unless-stopped \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --env-file .env \
  -v wa-abn-data:/data \
  wa-abn
```

Do not publish any port unless the Ops Dashboard is enabled and protected behind localhost, a private network, VPN, or authenticated reverse proxy.

## Repository philosophy

WA-ABN is the **upstream platform**.

Applications should normally be created by:
1. selecting feature modules;
2. creating a project profile;
3. adding a project-specific module only when needed;
4. contributing reusable improvements back into WA-ABN.

Avoid making a separate fork merely to rename the bot or change business context.

## White-label vendor confidentiality

WA-ABN is the internal upstream codebase. Customers see only their own vendor-branded dashboard and bot. Each vendor needs a distinct deployed service, storage volume, secrets, WhatsApp account, CRM, integrations and access controls. The core requires explicit TENANT_ID and WA_SESSION_ID and does not automatically adopt legacy shared storage. See [Vendor Confidentiality](docs/VENDOR_CONFIDENTIALITY.md) for migration and deployment guidance.
