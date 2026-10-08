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
Fill in `ANTHROPIC_API_KEY`, `GOOGLE_SHEET_ID` and `COMPANY_CONTEXT`. Write `COMPANY_CONTEXT` carefully: it drives the Hot/Warm/Cold scoring and the suggested next steps.

### 3. Run and link WhatsApp
```bash
npm install
npm run build
npm start
```
1. A QR code is printed. On the bot's phone, go to WhatsApp → Settings → Linked devices → Link a device and scan it. On a headless server, set `WA_PAIRING_NUMBER` instead and enter the 8-character code it prints.
2. Send any message in the leads group. The bot logs `Group "STRATUM Leads" → WA_GROUP_JID=1203…@g.us`.
3. Put that value in `.env` as `WA_GROUP_JID` and restart. The bot only listens to that group.

The login is saved in `data/wa-auth/`, so you only scan once. WA-ABN encrypts every Baileys credential/key file at rest with AES-256-GCM. If an older plaintext Baileys auth directory is present, it is migrated file-by-file when read. Losing `WA_AUTH_ENCRYPTION_KEY` means those credentials cannot be recovered; re-link the device instead of weakening this protection.

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


## Security model

WA-ABN deliberately stays small: it has no public dashboard, HTTP API, Socket.IO server, public registration, webhook receiver, updater, or author telemetry/heartbeat. That is intentional; those capabilities are unnecessary for the STRATUM leads-group use case and would increase the attack surface.

Security defaults in this repository:

- **Encrypted WhatsApp linked-device credentials:** Baileys auth state is stored with AES-256-GCM using `WA_AUTH_ENCRYPTION_KEY`; each file has a unique nonce and authenticated associated data.
- **Private filesystem permissions:** data/auth directories are forced toward `0700`; auth files are written `0600`.
- **Non-root container:** the production Docker image runs as the built-in `node` user.
- **One-group allowlist:** only `WA_GROUP_JID` is processed after discovery.
- **Data minimization:** card images and shared contacts are processed automatically, but ordinary text chatter is ignored by the AI by default. Typed leads use `!lead ...`. Set `PROCESS_ALL_TEXT_MESSAGES=true` only if you intentionally want all group text evaluated.
- **Bounded input:** media, text, and vCard sizes have configurable limits to reduce memory/DoS exposure.
- **Command allowlist:** `WA_COMMAND_ADMIN_JIDS` can restrict bot commands to approved team JIDs.
- **Secret hygiene:** keep Anthropic, Google service-account, and WhatsApp encryption secrets outside Git; prefer a platform secret manager.
- **Continuous scanning:** CI performs TypeScript validation, `npm audit`, CodeQL analysis, and Dependabot checks.

### Data-flow disclosure

A lead card/contact is not kept entirely inside WhatsApp. The minimum necessary content is sent to the configured Anthropic API for extraction/enrichment, and lead fields are written to the configured Google Sheet. Treat business cards, captions, and enrichment data as company data and ensure your Anthropic/Google configurations meet STRATUM's privacy requirements. Ordinary group chatter is not sent to Anthropic under the default configuration.

### Why Baileys remains the default engine

For this single internal group, the direct Baileys process has the smallest practical attack surface and the least infrastructure. WAHA and OpenWA are useful gateway products when you need dashboards, REST APIs, multiple sessions, or interchangeable engines, but those features are not required here. Keep OpenWA/WAHA as migration options rather than dependencies of the initial deployment.

The WhatsApp linked-device route remains unofficial. Use a dedicated bot number, keep volume low, do not use WA-ABN for bulk unsolicited messaging, and be prepared to re-link or replace the bot number if WhatsApp changes linked-device requirements.
