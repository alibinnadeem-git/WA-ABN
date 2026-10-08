# STRATUM Lead Bot (WhatsApp → Google Sheets)

A bot that sits in the STRATUM leads WhatsApp group. When a teammate posts a lead, it:

1. **Reads it.** Accepts a business-card photo (several cards per photo, handwriting included), a shared WhatsApp contact, or a typed name/number. Claude does the image reading.
2. **Asks for context once.** "Where did you meet, what do they need?" Anyone can swipe-reply to the bot's question. If the caption already had context, the bot doesn't ask. If nobody answers within 2 minutes, or someone says *skip*, it carries on without context.
3. **Enriches it.** Claude searches the web for the company website, LinkedIn, industry, size and HQ, then scores the lead Hot/Warm/Cold against STRATUM's ideal customer and suggests a next step.
4. **Writes it to the company Google Sheet**, then replies in the group with a summary and a link to the row. If the email or phone is already in the sheet, it adds the new note to the existing row instead of creating a duplicate.

```
Ali:   [photo of business card]
Bot:   📇 Got it: *Jane Doe* (Acme Corp)
       Any context? Where you met, what they need, priority, who follows up.
       Reply here, or say *skip*. I'll go ahead in 120s either way.
Sara:  ↪ Met at GITEX booth, wants a pilot in Q1. Ali follows up
Bot:   ✅ *Jane Doe*, CTO @ Acme Corp
       🏢 Fintech · 51-200 staff · Dubai, UAE
       🔥 Hot: mid-size fintech, decision-maker, explicit pilot interest
       ➡️ Email a pilot proposal this week and book a scoping call
       📄 Row 42: https://docs.google.com/…
```

Group commands: `!help`, `!event GITEX Dubai 2026` (tags every new lead with the event until you run `!event off`), `!status`.

## How it connects to WhatsApp (read this first)

The bot runs as a **linked device** on a WhatsApp account, the same way WhatsApp Web does. It uses [Baileys](https://github.com/WhiskeySockets/Baileys) for this. That is the only practical way to put a bot *inside a group*: the official WhatsApp Cloud API is built for 1:1 business messaging, not for joining a team group.

- **Use a dedicated number for the bot** (a cheap SIM or a WhatsApp Business account on a spare number). Do not link it to a teammate's personal WhatsApp. The bot ignores messages "from me", so it would ignore that person's posts.
- Baileys is unofficial. For a private internal group of 10 people with low volume, the risk is small, but WhatsApp can restrict accounts that use unofficial clients. Don't use this number for bulk messaging.
- Add the bot's number to the group like any other member.

## Setup

### 1. Google Sheet + service account (about 5 min)
1. In [Google Cloud Console](https://console.cloud.google.com/), create a project (or use an existing one). Enable the **Google Sheets API**.
2. Go to IAM & Admin → Service Accounts → **Create service account**. Then open Keys → Add key → JSON. Save the file as `service-account.json` in this folder.
3. Open the company leads sheet and **Share** it with the service account's email (`…@….iam.gserviceaccount.com`) as **Editor**.
4. Copy the sheet id from its URL: `docs.google.com/spreadsheets/d/<SHEET_ID>/edit`.

The bot creates the `Leads` tab and header row if they're missing. The columns are: Captured At, Added By, Source, Full Name, Job Title, Company, Email, Phone, Website, Person LinkedIn, Company LinkedIn, Industry, Company Size, HQ / Location, Company Summary, Person Summary, Event / Where Met, Team Notes, Priority, Priority Reason, Suggested Next Step, Enrichment Confidence, Sources, Status.

### 2. Configure
```bash
cp .env.example .env
```
Fill in `ANTHROPIC_API_KEY`, `GOOGLE_SHEET_ID`, `COMPANY_CONTEXT`, and a strong `WA_AUTH_ENCRYPTION_KEY` generated with `openssl rand -base64 32`. Write `COMPANY_CONTEXT` carefully: it drives the Hot/Warm/Cold scoring and the suggested next steps.

### 3. Run and link WhatsApp
```bash
npm install
npm run build
npm start
```
1. A QR code is printed. On the bot's phone, go to WhatsApp → Settings → Linked devices → Link a device and scan it. On a headless server, set `WA_PAIRING_NUMBER` instead and enter the 8-character code it prints.
2. Send any message in the leads group. The bot logs `Group "STRATUM Leads" → WA_GROUP_JID=1203…@g.us`.
3. Put that value in `.env` as `WA_GROUP_JID` and restart. The bot only listens to that group.

The linked-device state is saved in `data/wa-auth/` **encrypted with AES-256-GCM**. Set `WA_AUTH_ENCRYPTION_KEY` before first start and protect it separately from the data volume.

## Deploying (it must run 24/7)

The bot keeps a live WhatsApp connection, so it needs an always-on host with a persistent disk. Serverless hosts (Vercel, Lambda) will not work. Good options are Railway, Fly.io, Render (background worker + disk), or any small VPS.

```bash
docker build -t stratum-leads-bot .
docker run -d --restart unless-stopped --env-file .env \
  -e GOOGLE_SERVICE_ACCOUNT_JSON="$(base64 < service-account.json)" \
  -v stratum-bot-data:/data stratum-leads-bot
docker logs -f <container>   # scan the QR the first time
```

Mount `/data` as a persistent volume. If it is lost, you'll have to re-link WhatsApp.

## Project layout

| File | What it does |
|---|---|
| `src/index.ts` | WhatsApp connection (Baileys): QR/pairing, reconnects, turns group messages into `{images, vcards, text}` |
| `src/leads.ts` | Conversation flow: commands, the "any context?" question and timeout, dedupe, the summary reply |
| `src/ai.ts` | Claude calls: reading cards/contacts/text into structured leads, and web-search enrichment + scoring |
| `src/sheets.ts` | Google Sheets: header setup, duplicate lookup, append row |

## Costs and notes
- Each lead uses two Claude calls (extraction + enrichment with up to ~10 web searches/fetches). Plain-text group chatter also goes through a short extraction call so the bot can tell whether it's a lead. If the group is chatty, consider a dedicated leads-only group.
- If web enrichment fails, the lead is still saved with the card details. The row's Enrichment Confidence is set to "Not enriched".
- A lead waiting for context lives in memory. If the bot restarts within those 2 minutes, re-post that card.


## Security posture

WA-ABN deliberately remains smaller than full WhatsApp gateway products such as WAHA/OpenWA/WPPConnect. It now has an optional, read-only local Ops Dashboard, but still has no general WhatsApp send API, Socket.IO server, registration flow, webhook receiver, application database server, updater, or author telemetry. That keeps the attack surface aligned to the actual STRATUM leads-group use case.

Production hardening includes encrypted Baileys credentials, single-group enforcement, optional participant allowlisting, inbound rate/media limits, a local append-only security audit log, non-root Docker execution, and automated npm/OSV/Semgrep/CodeQL/Dependabot checks.

See [SECURITY.md](./SECURITY.md) before deployment. The safest deployment uses a dedicated WhatsApp number, no published container ports, a persistent encrypted data volume, and host-level default-deny egress that permits only WhatsApp/Meta, Anthropic and Google services required by the bot.


## Optional Ops Dashboard

WA-ABN now includes a deliberately **read-only** operations dashboard inspired by the useful free operational features in OpenWA, WAHA and Waxum, without exposing a general WhatsApp REST-send API.

Enable it with:

```bash
OPS_DASHBOARD_ENABLED=true
OPS_DASHBOARD_TOKEN="$(openssl rand -base64 32)"
```

By default it binds to `127.0.0.1:8787`. Open `http://127.0.0.1:8787` and authenticate with username `admin` and the configured token.

The dashboard provides:
- WhatsApp connection state and uptime
- processed/rejected/rate-limited/media-rejected counts
- leads saved and duplicates detected
- pending-context count and current event tag
- Hot/Warm/Cold/New lead summary
- read-only lead search across the existing Google Sheet
- recent security-audit events
- `/healthz` health probe
- authenticated `/metrics` endpoint in Prometheus text format

It intentionally does **not** provide arbitrary message sending, group administration, credential management, webhook creation, shell access, or remote code/update controls.

### Docker access

Because the secure default binds to container-localhost, either use an SSH tunnel into the host/container environment or explicitly bind the dashboard to all container interfaces and publish it **only on host loopback**:

```bash
OPS_DASHBOARD_HOST=0.0.0.0
docker run ... -p 127.0.0.1:8787:8787 wa-abn
```

Do not publish the dashboard directly to the public Internet. If remote team access is later required, place it behind an authenticated reverse proxy/VPN/Tailscale-style private network.
