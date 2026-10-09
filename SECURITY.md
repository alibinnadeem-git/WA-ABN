# WA-ABN Security Baseline

WA-ABN is a reusable WhatsApp automation platform with a **minimum-necessary attack surface**. Features are modular and should be enabled only when a deployment needs them. The optional Ops Dashboard is read-only and localhost-bound by default; the core still provides no public arbitrary-message send API, remote shell, self-updater, or author telemetry.

## Threat model

Tier-1 secrets:
- WhatsApp linked-device authentication state
- `WA_AUTH_ENCRYPTION_KEY`
- `ANTHROPIC_API_KEY`
- Google service-account credentials
- application data (for example CRM/lead data when that module is enabled)
- dashboard and outbound-integration credentials

Primary threats:
1. Theft of WhatsApp linked-device state from disk or backups.
2. A compromised/unauthorized group participant triggering AI actions.
3. Dependency or CI supply-chain compromise.
4. Excessive inbound media/messages causing cost or resource abuse.
5. Container/host compromise.
6. Accidental outbound data disclosure.

## Controls implemented

- **No phone-home telemetry.** There is no Aikeigroup/author heartbeat or analytics endpoint.
- **Encrypted Baileys auth state.** All Baileys credential/key files are AES-256-GCM encrypted at rest with per-file random nonces and authenticated associated data.
- **Plaintext migration.** Existing Baileys multi-file auth state is read once and rewritten encrypted.
- **Strict group boundary.** Only groups in `WA_ALLOWED_GROUP_JIDS` (or legacy `WA_GROUP_JID`) are processed.
- **Optional participant allowlist.** `WA_ALLOWED_SENDER_JIDS` can restrict processing to named participants.
- **Inbound rate limiting.** Per-sender message processing is capped by `MAX_MESSAGES_PER_MINUTE`.
- **Media limits.** Images larger than `MAX_IMAGE_BYTES` are rejected before AI processing when size is known and again after download.
- **Append-only security audit.** Security-relevant local events are written as JSONL to `DATA_DIR/security-audit.jsonl`.
- **No runtime WhatsApp-version fetch.** The application uses the reviewed Baileys dependency from the lockfile instead of dynamically selecting a version at startup.
- **Non-root container.** Production runs as the official Node image's unprivileged `node` user.
- **No general inbound send API.** The optional Ops Dashboard is disabled by default, binds to `127.0.0.1`, requires a minimum-32-character token, and exposes read-only status/search/audit/metrics functionality.
- **Vendor and session isolation.** Mandatory `TENANT_ID` and `WA_SESSION_ID` scope credentials, state, backups, history, scheduler jobs, retries and audit logs; vendors still require separate services, storage and credentials.
- **Safe outbound integration hook.** Optional webhooks require HTTPS, reject redirects/private addresses, and can require an explicit hostname allowlist.
- **Retry/backup modules.** Persisted failed work and backups remain inside the deployment data boundary; WhatsApp auth files remain encrypted.
- **Spreadsheet formula-injection defense.** Untrusted lead values beginning with formula sigils are escaped before insertion.

## Controls from the WA-AKG audit that are intentionally not present

The following high-risk attack surfaces do not exist in WA-ABN and should remain absent unless a future design explicitly requires them:
- Socket.IO handshake / arbitrary room joins
- CORS policy
- public registration / RBAC
- API-key generation and storage
- arbitrary/unrestricted webhook URL fetching
- shell `exec()`
- database service exposed to the network
- web authentication endpoints

If any of these capabilities are added later, a new threat model and security review are required before merge.

## Network egress policy

The application itself cannot reliably enforce host-level egress because WhatsApp endpoints and Google infrastructure use changing hosts/IPs. Enforce egress at the deployment firewall/container platform.

Default policy: deny outbound traffic, then allow only:
- WhatsApp/Meta endpoints required by Baileys/WhatsApp Web
- Anthropic API endpoints
- Google OAuth/Sheets API endpoints
- DNS and NTP as required by the host

Do **not** allow arbitrary outbound HTTP from the container.

Because provider hostnames/IP ranges change, maintain allow rules through your cloud firewall/service mesh rather than hard-coding stale IP ranges in application code.

## Production container hardening

Recommended runtime flags:

```bash
docker run -d --restart unless-stopped \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --env-file .env \
  -v wa-abn-data:/data \
  wa-abn
```

Do not publish any ports.

## Secret handling

Generate the auth-state key:

```bash
openssl rand -base64 32
```

Store production secrets in the deployment platform's secret manager. Never put them in the repository, Docker image, `DATA_DIR`, screenshots, or support logs.

Rotate Anthropic and Google credentials after suspected disclosure. If `WA_AUTH_ENCRYPTION_KEY` is disclosed, unlink the WhatsApp linked device, delete the auth state, rotate the key, and pair again.

## Automated security checks

The repository includes:
- npm audit
- OSV-Scanner
- Semgrep
- CodeQL
- Dependabot

A dependency/SAST alert is not automatically proof of exploitability, but high/critical findings must be reviewed before production deployment.


## Ops Dashboard threat model

When `OPS_DASHBOARD_ENABLED=true`:
- authentication is HTTP Basic with a timing-safe token comparison;
- username is fixed as `admin`; the secret is the dashboard token;
- dashboard token must be at least 32 characters;
- default bind address is `127.0.0.1`;
- responses use `Cache-Control: no-store`, CSP, frame denial, no-referrer, and MIME-sniffing protections;
- the UI is read-only and has no message-send or credential-management endpoint;
- `/healthz` returns only `ok` and intentionally exposes no operational data;
- `/metrics`, lead search and audit events require authentication.

If binding to `0.0.0.0` for container access, publish the port on host loopback only or put it behind an authenticated private network/reverse proxy. Never expose the dashboard directly to the public Internet.


## Profile and module isolation

Project profiles are configuration, not forks. A profile should not weaken the core trust boundary. Each vendor must deploy independently with unique credentials, WhatsApp identity, CRM, backups, storage and dashboard access. Review any profile that:
- enables message history;
- enables outbound webhooks;
- broadens authorized groups or senders;
- exposes the Ops Dashboard beyond localhost;
- adds a new write-capable HTTP API;
- adds bulk messaging or group-administration capabilities.

Run separate process/container instances with unique `TENANT_ID` and `WA_SESSION_ID` values for unrelated vendors. For strongest isolation, use separate cloud projects/accounts, volumes, backup stores and keys. IDs alone are not an authorization boundary.

## Outbound webhook controls

`FEATURE_WEBHOOKS` is disabled by default. When enabled, WA-ABN:
- requires HTTPS;
- rejects redirects;
- resolves the hostname before use;
- blocks loopback, RFC1918/private and link-local destinations;
- can require an explicit `WEBHOOK_ALLOWED_HOSTS` allowlist;
- never uses the webhook response as executable code.

This module is intended for trusted workflow systems such as an organization's own n8n instance, not arbitrary user-supplied destinations.

## Vendor white-label confidentiality

The dashboard, HTTP authentication realm, bot status and CLI dashboard log use the vendor's own APP_NAME. Do not share the internal GitHub upstream, CI, host logs, encryption keys, support data or information about other vendors with a client unless independently authorized. Similar software may still be recognizable; do not represent shared code as exclusive ownership without contractual grounds. See [docs/VENDOR_CONFIDENTIALITY.md](docs/VENDOR_CONFIDENTIALITY.md).

## Optional advanced API

The vendor-scoped advanced gateway is **disabled by default**. When activated, it:
- Binds to loopback only, requires unique strong role tokens (viewer/operator/admin) and has no open CORS;
- Rejects destinations not in this vendor's explicit group/contact allowlists;
- Applies a shared outbound send quota and per-campaign pacing and size caps;
- Requires operator submission plus administrator confirmation before campaign dispatch;
- Permits group management only under a separate feature flag with an administrator token;
- Requires opt-in for event streams, inbound integration triggers and media endpoints;
- Stores campaign queue files in the existing per-vendor session directory and pauses on uncertain/incomplete sends.

Even when code is merged, enabling advanced functions requires approval by the vendor's operator, legal/policy assessment, runtime verification and testing against a dedicated WhatsApp account. The API is not a public bulk-spam gateway; no spoofed identity or remote shell endpoint has been added. See [docs/ADVANCED_GATEWAY.md](docs/ADVANCED_GATEWAY.md).
