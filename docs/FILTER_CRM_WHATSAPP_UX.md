# Podium CRM — WhatsApp is the user interface

## Product boundary

Podium CRM is an independent WhatsApp-native intake and reasoning application. It does **not** replace, recreate or host STRATUM CRM. Human teams work in their familiar WhatsApp group, talk to one another, drop leads, source materials and media, and ask Podium CRM about the evidence. Podium CRM privately tracks classification and reviewers. Approved STRATUM-related leads can be transferred to the existing STRATUM CRM over the signed integration endpoint.

**No separate web UI is needed for normal group participants.** A loopback-only administrator API remains available for operational review/export, troubleshooting and configured integrations.

## Native WhatsApp journey

1. The authorized group member writes a normal lead message (e.g. `Met Jane Smith at the event. Company: Example Electrical; email jane@example.com; need substation quote`), uses `!lead Name | Company | Email | Phone | Notes`, sends a vCard or drops an image of a business card.
2. When the high-precision lead cues and email/phone are present, Podium CRM stages a *candidate* automatically. Normal conversations without lead cues remain untouched. With AI enabled, card photos/vCards and explicit `!capture ...` texts are parsed. AI is optional and paid-provider charges may apply.
3. Podium CRM replies in the **same WhatsApp group, quoting the source message** where practical, with classification, source ID and a conspicuous not-transferred status.
4. Members may ask grounded questions with `Filter: what do we know about Jane?`, `!ask Jane Smith | What is her company?`, or reply to the original captured lead message with a question.
5. Podium CRM answers only from the current authorized group's staged lead details, source notes, classifications and acknowledged STRATUM CRM status. It does not guess missing facts or leak entries from other groups.
6. An explicitly authorized reviewer may approve/reject via WhatsApp `!review ID related|unrelated|review | documented reason`.
7. When all candidates for the group have been reviewed, `!sendapproved` sends up to 10 approved leads via signed HTTPS; or `!dispatch ID` handles one reviewed candidate. No automatic transfer from classification alone.
8. The existing STRATUM CRM confirms `created`, `already_imported` or `needs_review_existing`. Podium CRM responds inside WhatsApp with the result; it does not directly access Neon.

## WhatsApp commands

| Message | Function |
| --- | --- |
| `!help` or `!filter` | Discover the WhatsApp-native assistant |
| `!lead Name | Company | Email | Phone | Notes` | Manual capture without AI |
| `!capture ...` | Explicit AI text extraction when enabled |
| `!leads` | Latest 10 leads from **this group only** |
| `!ask Jane | Why is this relevant?` | Evidence-grounded lead question |
| `Filter: what do we know about Jane?` | Deliberately addressed natural-language question |
| Reply to a source message: `What is their email?` | Quoted-message lead Q&A if a unique group lead can be resolved |
| `!sources` | Recently shared sources from this group |
| `!source <ID>` | Inspect source type, caption, extracted text availability and content hash |
| `!review <ID> related|unrelated|review | reason` | Reviewer-only classification decision |
| `!dispatch <ID>` | Reviewer-only single approved lead transfer |
| `!sendapproved` | Reviewer-only batch; blocked while **any** group candidate is unreviewed |

Review commands require `FILTER_REVIEWER_JIDS` to explicitly contain the reviewer's WhatsApp JID. Group membership, an arbitrary display name or being a contact never grants approval permission. If `FILTER_REVIEWER_JIDS` is empty, WhatsApp approval/dispatch fails closed.

All messages/replies are limited to the authorized `WA_ALLOWED_GROUP_JIDS`, with optional `WA_ALLOWED_SENDER_JIDS` and existing rate limiting. For a real deployment, groups should be informed and approve that shared lead material may be processed.

## What happens to shared sources and media?

| Input | Current processing | WhatsApp response |
| --- | --- | --- |
| Human group conversation unrelated to lead | Not captured as a lead; normal chat unaffected | No bot interruption |
| Explicit lead message with identifiable email/phone | High-precision local rule extraction; candidate staged | Candidate disposition and Podium CRM ID |
| `!lead` structured contact | Stored and classified deterministically | Captured lead status |
| Business-card photo | Bounded JPEG/PNG/WebP/GIF download and source fingerprint; optional AI contact extraction | Candidate summary or manual-input guidance |
| Shared WhatsApp vCard | Text extracted; optional AI parses contact | Candidate status or manual-input guidance |
| Plain text, CSV, vCard or JSON attachment | Bounded text extraction (up to 8,000 characters) and source metadata; optional AI capture | Indexed/needs review notification |
| PDF/Office document | MIME/name/caption and source metadata **only** | Clearly says document parsing is pending, no invented content |
| Audio / video | Source metadata registered, content **not transcribed** | Clearly says transcription is not yet enabled |
| Explicit `source:` note | Indexed as text source in the group | Source recorded; no automatic STRATUM import |

The source registry is group-scoped, stored in the Podium CRM's private volume. Raw large media files are not persisted by this implementation. Media content can be ephemeral in WhatsApp and is not guaranteed recoverable later; a future encrypted source vault, OCR/PDF/Office parser and speech transcription pipeline are needed for fully searchable original documents.

## Data safety and fidelity

- No generic chat bot auto-replies to all group conversation. Only explicit lead cues/media intake, supported commands, deliberately addressed questions and source-note requests trigger replies.
- Captured contacts are *assertions from received sources*, not independently verified business facts. Confidence scores express classifier rule strength, not probability of a sale.
- Missing contact names/identity remain unresolved and are not export eligible.
- A single WhatsApp group may not retrieve Podium CRM records registered to another group even when one service handles multiple authorized groups.
- Unrelated and unresolved leads remain in Podium CRM. The STRATUM CRM webhook sees only reviewer-approved STRATUM-related candidates, signed and reconciled.
- No real WhatsApp device, audio/video transcription, document parser or CRM integration was exercised in this branch's automated tests. Live device and two-service UAT must pass before production.
- The existing upstream WA-ABN repo is currently public; keep personal/vendor credentials, real lead data and customer-only deployment config private.

## Acceptance demo

In an approved pilot WhatsApp group:
1. Send an ordinary social message. **No Podium CRM reply**.
2. Share an explicit electrical contractor lead with contact information. Bot stages candidate and replies quoting the message.
3. Share a non-STRATUM contact. Bot stages unrelated; no STRATUM transfer.
4. Send two leads with the same name. `!ask Jane | ...` must request disambiguation; the full UUID resolves the correct one.
5. Reply to a recorded lead message, `What is their email?` — bot returns recorded value or "not provided."
6. Send a source text attachment and PDF. The former indexes its text, while the latter transparently reports pending parsing.
7. Ask `!leads` and `!sources` in a different authorized group; **no Group A data is returned**.
8. Confirm unlisted reviewer cannot approve, allowed reviewer can approve only with written reason.
9. Check `!sendapproved` blocks until unresolved leads are reviewed; then verify signed transfer to the existing STRATUM CRM.
10. Replay the same source import and confirm duplicate imports are idempotent in STRATUM CRM.

See [FILTER_CRM_STRATUM_ROUTING.md](FILTER_CRM_STRATUM_ROUTING.md) for the signed webhook and underlying integration state.
