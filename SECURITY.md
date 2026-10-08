# Security Policy

WA-ABN is intentionally designed as a narrow WhatsApp lead-capture bot rather than a general-purpose WhatsApp gateway.

## Security model

- No application telemetry or phone-home heartbeat is permitted.
- Only the configured `WA_GROUP_JID` is processed.
- Group discovery is disabled by default and must be enabled explicitly for setup.
- WhatsApp/Baileys authentication material is encrypted at rest with AES-256-GCM.
- The encryption key must be supplied through `WA_AUTH_ENCRYPTION_KEY` and must not be stored with the data directory.
- The production container runs as the unprivileged `node` user.
- Media inputs are size-limited before and after download.
- Secrets must be supplied via a deployment secret manager or local untracked `.env` file.

## Generating the auth encryption key

```bash
openssl rand -base64 32
```

Store the generated value as `WA_AUTH_ENCRYPTION_KEY`.

Losing or changing this key makes the existing encrypted WhatsApp session state unreadable.

## Migrating an existing plaintext Baileys session

The hardened runtime refuses plaintext auth files by default.

For one controlled migration run only:

```bash
WA_ALLOW_PLAINTEXT_AUTH_MIGRATION=true
```

Start the bot once, verify it connects successfully, then immediately return the value to:

```bash
WA_ALLOW_PLAINTEXT_AUTH_MIGRATION=false
```

The files in the auth directory will have been rewritten as AES-256-GCM envelopes.

## Reporting a vulnerability

Do not include credentials, WhatsApp session material, API keys, service-account JSON, customer data, or message contents in a public issue.

For any suspected credential exposure, rotate the affected secret immediately and relink the WhatsApp session if session material may have been exposed.
