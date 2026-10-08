# WA-ABN Security Baseline

WA-ABN is intentionally a small, single-purpose WhatsApp group lead-capture bot. Its security model is **minimum attack surface**: no dashboard, no public HTTP API, no Socket.IO server, no user registration, no webhook receiver, no updater, and no author telemetry.

## Threat model

Tier-1 secrets:
- WhatsApp linked-device authentication state
- `WA_AUTH_ENCRYPTION_KEY`
- `ANTHROPIC_API_KEY`
- Google service-account credentials
- Google Sheet identifiers and lead data

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
- **Strict group boundary.** Only `WA_GROUP_JID` is processed.
- **Optional participant allowlist.** `WA_ALLOWED_SENDER_JIDS` can restrict processing to named participants.
- **Inbound rate limiting.** Per-sender message processing is capped by `MAX_MESSAGES_PER_MINUTE`.
- **Media limits.** Images larger than `MAX_IMAGE_BYTES` are rejected before AI processing when size is known and again after download.
- **Append-only security audit.** Security-relevant local events are written as JSONL to `DATA_DIR/security-audit.jsonl`.
- **No runtime WhatsApp-version fetch.** The application uses the reviewed Baileys dependency from the lockfile instead of dynamically selecting a version at startup.
- **Non-root container.** Production runs as the official Node image's unprivileged `node` user.
- **No inbound network listener.** WA-ABN does not expose an application port.
- **Spreadsheet formula-injection defense.** Untrusted lead values beginning with formula sigils are escaped before insertion.

## Controls from the WA-AKG audit that are intentionally not present

The following attack surfaces do not exist in WA-ABN and should remain absent unless a future design explicitly requires them:
- Socket.IO handshake / arbitrary room joins
- CORS policy
- public registration / RBAC
- API-key generation and storage
- webhook URL fetching / SSRF surface
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
  -v stratum-bot-data:/data \
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
