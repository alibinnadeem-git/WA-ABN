# Advanced WhatsApp Gateway — Optional vendor modules

These capabilities are implemented **in the WA-ABN upstream repository**, not copied or forked from another gateway. A customer sees only their own app branding and receives no access to other vendors.

## Sources of free feature ideas

- [OpenWA](https://github.com/open-wa/wa-automate-nodejs): local REST interface, API metadata, event/webhook connections, named sessions, integrations
- [WPPConnect Server](https://github.com/wppconnect-team/wppconnect-server): messaging, media, contacts, group management, Swagger/OpenAPI conventions
- [WAHA](https://github.com/devlikeapro/waha): session management, APIs, media, integration ideas
- [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js): poll, reaction, contact, group and message actions
- Waxum: scheduling, monitoring, queues, message/search ideas

**No third-party source code was pasted into this module.** Features are independently implemented using the existing Baileys dependency and Node's built-in HTTP server. Open-source availability does not waive copyright, upstream licenses, WhatsApp platform rules, provider API charges or hosting costs.

## Activating for one vendor

In that vendor's private environment file (never the source repo):

```dotenv
FEATURE_ADVANCED_API=true
ADVANCED_API_HOST=127.0.0.1
ADVANCED_API_PORT=8790
ADVANCED_VIEW_TOKEN=<a unique random secret of at least 32 characters>
ADVANCED_OPERATOR_TOKEN=<a different unique random secret of at least 32 characters>
ADVANCED_ADMIN_TOKEN=<a third unique random secret of at least 32 characters>
ADVANCED_APPROVED_RECIPIENT_JIDS=12025550123@s.whatsapp.net
FEATURE_CAMPAIGNS=true
FEATURE_GROUP_ADMIN=true
FEATURE_API_MEDIA=true
FEATURE_EVENT_STREAM=true
FEATURE_INBOUND_WORKFLOWS=true
ADVANCED_CAMPAIGN_MAX_RECIPIENTS=25
ADVANCED_CAMPAIGN_INTERVAL_SECONDS=20
ADVANCED_SEND_PER_MINUTE=6
ADVANCED_SEND_PER_DAY=100
```

Generate each token independently using `openssl rand -base64 36`. Each vendor has different keys, WhatsApp account, `TENANT_ID`, `WA_SESSION_ID`, approved group list, approved contact list, data volume and deployment.

**Disabled by default.** Advanced API listens only on localhost, even when enabled. Access it from a vendor-private SSH/private-network tunnel; do not publish an unauthenticated Internet port. Dashboard and gateway have **separate** authentication credentials.

### Roles

| Role | Authorized operations |
| --- | --- |
| Viewer | Own-vendor status, group listing, campaign state, OpenAPI and events |
| Operator | Viewer + approved text/media/reaction/location/contact/poll sending; draft campaign; trigger inbound workflows |
| Admin | Operator + approve/pause/resume/cancel campaigns; create/join/manage groups and profile name |

Role tokens are distinct and validated using timing-safe comparison. Failed authentication returns HTTP 401. No open CORS or anonymous registration endpoint is included.

## APIs

All requests require `Authorization: Bearer <role-token>`. The interface offers an authenticated OpenAPI JSON document at `GET /openapi.json` for importing into a private API explorer/Swagger tool. The embedded metadata is a starting API index, not yet a fully generated interactive Swagger UI.

| Path | Use |
| --- | --- |
| `GET /v1/status` | WhatsApp and gateway status |
| `GET /v1/groups` | Authorized groups only |
| `POST /v1/messages/text` | Text to approved group/contact |
| `POST /v1/messages/media` | Image, audio, MP4 video or PDF (base64 up to 5 MiB) |
| `POST /v1/messages/poll` | Poll to approved group |
| `POST /v1/messages/reaction` | Reaction to a message |
| `POST /v1/messages/location` | Share a location |
| `POST /v1/messages/contact` | Share a vCard |
| `POST /v1/profile/name` | Change own linked WhatsApp profile name (admin) |
| `POST /v1/groups/new` | Create a group with approved members |
| `POST /v1/groups/join` | Join by invite code |
| `POST /v1/groups/{jid}/subject` | Edit an approved group's subject |
| `POST /v1/groups/{jid}/description` | Edit description |
| `POST /v1/groups/{jid}/participants` | Add/remove/promote/demote approved participants |
| `GET /v1/campaigns` | Campaign review |
| `POST /v1/campaigns` | Create draft campaign |
| `POST /v1/campaigns/{id}/approve` | Explicit administrator send approval |
| `POST /v1/campaigns/{id}/pause` | Pause |
| `POST /v1/campaigns/{id}/resume` | Resume after review |
| `POST /v1/campaigns/{id}/cancel` | Cancel |
| `GET /v1/events/recent` | Latest metadata-only events (when enabled) |
| `GET /v1/events/stream` | SSE/real-time events over a private authenticated stream |
| `POST /v1/integrations/events` | Publish authenticated inbound workflow event |
| `POST /v1/integrations/notify` | Send approved notification from n8n/automation |

### Example: scoped single message

```bash
curl --request POST http://127.0.0.1:8790/v1/messages/text \
  -H "Authorization: Bearer $ADVANCED_OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jid":"1234@g.us","text":"Team update"}'
```

An unauthorized group/contact is rejected. A direct-contact JID must appear in `ADVANCED_APPROVED_RECIPIENT_JIDS`. Group destinations must appear in `WA_ALLOWED_GROUP_JIDS`.

### Example: reviewed campaign

1. Operator submits `POST /v1/campaigns`:

```json
{
  "name": "Customer service notification",
  "purpose": "Consent-based product service update",
  "text": "Your scheduled maintenance window is tomorrow.",
  "recipients": ["12025550123@s.whatsapp.net"],
  "consentAttested": true
}
```

2. Created campaign is a **draft** and does not send. An administrator reviews the approved recipients and calls `POST /v1/campaigns/{id}/approve` with JSON `{"confirm":"APPROVE_SEND"}`.
3. Deliveries are paced by `ADVANCED_CAMPAIGN_INTERVAL_SECONDS`, the overall per-minute/day quota and campaign-size cap. An admin may pause, resume or cancel.
4. If a send fails, the campaign pauses; it is not silently retried. If the process restarts during an uncertain delivery, the queue pauses for review.

An operator's checkbox asserting opt-in is not automatic proof of legal consent. The deploying organization must verify applicable consent, opt-out and WhatsApp rules. Bulk unsolicited outreach is not an appropriate use of this module.

### Group administration

Group membership modifications require the admin token and `FEATURE_GROUP_ADMIN=true`. Existing groups must already be in the current vendor's allowed JIDs; changes to participants require individual allowlisting. A newly created/joined group is returned as **not yet authorized**, and cannot process/send until the operator explicitly adds its JID to the deployment's allowlist and restarts.

### Integration streams

- `FEATURE_EVENT_STREAM`: read-only SSE events for connection changes, permitted message metadata and approved delivery receipt metadata; no message body by default.
- `FEATURE_INBOUND_WORKFLOWS`: authenticated integration events and approved notification sends.
- Existing `FEATURE_WEBHOOKS`: outbound vendor-specific HTTPS webhook, restricted by host allowlist.

SSE does not implement the Socket.IO wire protocol; clients expecting Socket.IO still need an adapter.

## Vendor confidentiality

No endpoint lists other vendors, reveals the upstream GitHub repository, or accesses another deployment. Session data and campaigns are persisted under that vendor's isolated directory. Real isolation also requires independently configured containers, credentials, volumes, WhatsApp numbers, backup stores, API keys and deployment access controls. See [VENDOR_CONFIDENTIALITY.md](./VENDOR_CONFIDENTIALITY.md).

## Feature harvest — further adapters still to build

Available functionality in other free projects is kept on the backlog **rather than ruled out without consultation**:

- Unified inbox/chat dashboard, Chatwoot helpdesk bridge and conversation assignment UI
- Native Socket.IO gateway, SDK clients and complete interactive Swagger UI
- Official WhatsApp Cloud API transport alongside the unofficial Baileys transport
- Full multi-number central manager with separate per-vendor security domains
- Full contact/CRM synchronization and native label/tag handling
- Message edit/delete, rich interactive lists/buttons, stories/channels/communities where supported
- Product catalog, business profile media, group invite QR workflows
- Controlled workflow/plugin registry, optional MCP agent connector
- Advanced media history and searchable conversation inbox
- Campaign consent/opt-out registry, suppression list and delivery reporting
- Custom per-vendor RBAC user accounts beyond current scoped API tokens

Any transport-specific feature needs provider-capability checks and real-device tests. Nothing above should be represented as implemented until merged with evidence.

## Validation limitations

Automated build, TypeScript, unit tests and SAST/SCA can validate code shape but do not prove the WhatsApp service actually accepts every Baileys operation. Before enabling for a real vendor, test against that vendor's dedicated authorized number and group, including disconnection, WhatsApp account policy and user consent. No live WhatsApp send/group change was executed as part of this PR.
