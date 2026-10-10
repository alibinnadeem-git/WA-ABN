import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  normalizeMessageContent,
  type WAMessage,
  type WASocket,
} from "baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { config } from "./config.js";
import { audit } from "./audit.js";
import { useEncryptedAuthState } from "./auth-state.js";
import { handleMessage, type Chat, type IncomingMessage } from "./leads.js";
import type { MessageInput } from "./ai.js";
import { ensureSheet } from "./sheets.js";
import { increment, setConnection, setGroupInfo, setPairingState } from "./ops.js";
import { startOpsDashboard } from "./dashboard.js";
import { handlePlatformCommand } from "./commands.js";
import { recordHistory } from "./history.js";
import { startScheduler } from "./scheduler.js";
import { startAutoDigest } from "./digests.js";
import { startAdvancedApi } from "./gateway.js";
import { handleFilterOnlyIntake } from "./filter-intake.js";
import { handleFilterChat } from "./filter-chat.js";
import { filterSourceRegistry, stageFilterLead } from "./filter-runtime.js";
import { passiveLeadFromText } from "./filter-text-intent.js";
import { safeSourceText } from "./filter-sources.js";
import { authorizedRecipient } from "./gateway-policy.js";
import { publishGatewayEvent } from "./gateway-events.js";

const logger = pino({ level: process.env.LOG_LEVEL ?? "warn" });
const seen = new Set<string>();
const announcedGroups = new Set<string>();
const recent = new Map<string, WAMessage>();
const senderWindows = new Map<string, number[]>();
let reconnectTimer: NodeJS.Timeout | null = null;
let activeSocket: WASocket | null = null;

function remember(m: WAMessage): void {
  recent.set(m.key.id!, m);
  if (recent.size > 500) recent.delete(recent.keys().next().value!);
}

function makeChat(sock: WASocket, jid: string): Chat {
  return {
    async reply(text, toMessageId) {
      const quoted = toMessageId ? recent.get(toMessageId) : undefined;
      const sent = await sock.sendMessage(jid, { text }, quoted ? { quoted } : undefined);
      return sent?.key.id ?? undefined;
    },
    async react(messageId, emoji) {
      const target = recent.get(messageId);
      if (!target) return;
      await sock.sendMessage(jid, { react: { text: emoji, key: target.key } }).catch(() => {});
    },
  };
}

function senderAllowed(sender: string): boolean {
  return config.allowedSenderJids.size === 0 || config.allowedSenderJids.has(sender);
}

function rateLimited(sender: string): boolean {
  const now = Date.now();
  const cutoff = now - 60_000;
  const recentTimes = (senderWindows.get(sender) ?? []).filter((t) => t > cutoff);
  if (recentTimes.length >= config.maxMessagesPerMinute) {
    senderWindows.set(sender, recentTimes);
    return true;
  }
  recentTimes.push(now);
  senderWindows.set(sender, recentTimes);
  return false;
}

const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
type ImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

async function start(): Promise<void> {
  const { state, saveCreds } = await useEncryptedAuthState(config.authDir, config.authEncryptionKey);

  const sock = makeWASocket({
    auth: state,
    logger,
    browser: Browsers.macOS("Desktop"),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  const sendText = async (jid: string, message: string) => { await sock.sendMessage(jid, { text: message }); };
  startScheduler(sendText);
  startAutoDigest(sendText);

  if (config.features.receipts) {
    sock.ev.on("messages.update", (updates) => {
      for (const item of updates) {
        const status = item.update.status;
        const id = item.key.id;
        const jid = item.key.remoteJid;
        if (status != null && id && jid && authorizedRecipient(jid, config.allowedGroupJids, config.advancedRecipientJids)) {
          if (config.features.eventStream) publishGatewayEvent("whatsapp.receipt", { jid, id, status: String(status) });
          recordHistory({ ts: new Date().toISOString(), id, jid, sender: "system", type: "receipt", status: String(status) });
        }
      }
    });
  }

  if (config.pairingNumber && !sock.authState.creds.registered) {
    setTimeout(async () => {
      const code = await sock.requestPairingCode(config.pairingNumber!.replace(/\D/g, ""));
      setPairingState("code-issued");
      audit("whatsapp.pairing_code_issued");
      console.log(`\nWhatsApp → Linked devices → Link with phone number → enter code: ${code}\n`);
    }, 3000);
  }

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr && !config.pairingNumber) {
      setPairingState("required");
      audit("whatsapp.qr_issued");
      console.log("Scan this QR with the bot's WhatsApp (Linked devices → Link a device):");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      activeSocket = sock;
      if (config.features.eventStream) publishGatewayEvent("whatsapp.connected", {});
      setConnection("connected");
      setPairingState("idle");
      audit("whatsapp.connected");
      for (const groupJid of config.allowedGroupJids) {
        void sock.groupMetadata(groupJid).then((meta) => {
          setGroupInfo(groupJid, { subject: meta.subject ?? groupJid, participants: meta.participants.length, admins: meta.participants.filter((p) => Boolean(p.admin)).length });
        }).catch(() => {});
      }
      console.log("✅ Connected to WhatsApp.");
      if (config.allowedGroupJids.size === 0) {
        console.log("No WhatsApp groups are authorized yet. Send a message in a candidate group to print its JID, then configure WA_ALLOWED_GROUP_JIDS.");
      }
    }
    if (connection === "close") {
      const status = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      if (config.features.eventStream) publishGatewayEvent("whatsapp.disconnected", { status: status ?? null });
      if (activeSocket === sock) activeSocket = null;
      setConnection("disconnected");
      audit("whatsapp.disconnected", { status: status ?? null });
      if (status === DisconnectReason.loggedOut) {
        console.error(`Logged out. Delete ${config.authDir} and restart to link again.`);
        process.exit(1);
      }
      if (!reconnectTimer) {
        console.warn(`Connection closed (${status ?? "unknown"}), reconnecting…`);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          void start();
        }, 2000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      try {
        await onMessage(sock, m);
      } catch (err) {
        console.error("Failed to handle message", err);
        increment("handlerErrors");
        audit("message.handler_error", { message: err instanceof Error ? err.message : "unknown" });
      }
    }
  });
}

async function onMessage(sock: WASocket, m: WAMessage): Promise<void> {
  increment("messagesSeen");
  const jid = m.key.remoteJid;
  const id = m.key.id;
  if (!jid?.endsWith("@g.us") || !id || m.key.fromMe || !m.message) return;

  if (config.allowedGroupJids.size === 0) {
    if (!announcedGroups.has(jid)) {
      announcedGroups.add(jid);
      const meta = await sock.groupMetadata(jid).catch(() => null);
      if (meta) setGroupInfo(jid, { subject: meta.subject ?? jid, participants: meta.participants.length, admins: meta.participants.filter((p) => Boolean(p.admin)).length });
      console.log(`Group "${meta?.subject ?? "?"}" → add ${jid} to WA_ALLOWED_GROUP_JIDS`);
    }
    return;
  }
  if (!config.allowedGroupJids.has(jid)) return;

  const sender = m.key.participant ?? jid;
  if (!senderAllowed(sender)) {
    increment("senderRejected");
    audit("message.sender_rejected", { sender, group: jid });
    return;
  }
  if (rateLimited(sender)) {
    increment("rateLimited");
    audit("message.rate_limited", { sender, group: jid });
    return;
  }

  if (seen.has(id)) return;
  seen.add(id);
  if (seen.size > 10_000) seen.clear();
  remember(m);

  const content = normalizeMessageContent(m.message);
  if (!content) return;

  const input: MessageInput = { images: [], vcards: [], text: null };
  let quotedId: string | null = null;

  if (content.conversation) input.text = content.conversation;
  if (content.extendedTextMessage) {
    input.text = content.extendedTextMessage.text ?? null;
    quotedId = content.extendedTextMessage.contextInfo?.stanzaId ?? null;
  }

  const image = content.imageMessage;
  const docImage = content.documentMessage?.mimetype?.startsWith("image/") ? content.documentMessage : null;
  const media = image ?? docImage;
  if (media) {
    input.text = media.caption ?? null;
    const mime = (media.mimetype ?? "image/jpeg").split(";")[0] as ImageType;
    if (SUPPORTED_IMAGE_TYPES.includes(mime)) {
      const declaredSize = Number(media.fileLength ?? 0);
      if (declaredSize > config.maxImageBytes) {
        increment("mediaRejected");
        audit("message.media_rejected_size", { sender, bytes: declaredSize });
        await sock.sendMessage(jid, { text: "⚠️ Image is too large for the secure processing limit." }, { quoted: m });
        return;
      }
      const data = await downloadMediaMessage(m, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
      if (data.length > config.maxImageBytes) {
        increment("mediaRejected");
        audit("message.media_rejected_size", { sender, bytes: data.length });
        await sock.sendMessage(jid, { text: "⚠️ Image is too large for the secure processing limit." }, { quoted: m });
        return;
      }
      input.images.push({ data, mediaType: mime });
    }
  }

  if (content.contactMessage?.vcard) input.vcards.push(content.contactMessage.vcard);
  for (const c of content.contactsArrayMessage?.contacts ?? []) {
    if (c.vcard) input.vcards.push(c.vcard);
  }

  // Filter CRM observes approved group media without mistaking all chat/media for a lead.
  // Unsupported binary formats get honest metadata-only status, not fake extracted facts.
  let sourceNotice: string | null = null;
  let sourceRecorded = false;
  let textFromDocument: string | null = null;
  if (config.features.filterCrm) {
    const registry = filterSourceRegistry();
    if (registry) {
      if (media && input.images.length > 0) {
        registry.record({
          groupJid: jid, messageId: id, senderJid: sender, kind: "image",
          mimeType: media.mimetype ?? "image/jpeg", fileName: null,
          caption: media.caption ?? "", processing: config.features.aiExtraction ? "needs_extraction" : "metadata_indexed",
          body: input.images[0].data,
        });
        sourceRecorded = true;
      }
      if (input.vcards.length) {
        registry.record({
          groupJid: jid, messageId: id, senderJid: sender, kind: "vcard",
          mimeType: "text/vcard", fileName: null, caption: input.text ?? "",
          processing: "text_indexed", extractedText: input.vcards.join("\n").slice(0,8000),
        });
        sourceRecorded = true;
      }
      const document = content.documentMessage;
      if (document && !docImage) {
        const mime = (document.mimetype ?? "application/octet-stream").split(";")[0].toLowerCase();
        const declaredSize = Number(document.fileLength ?? 0);
        let fileData: Buffer | null = null;
        let extractedText: string | null = null;
        if (["text/plain", "text/csv", "text/vcard", "application/json"].includes(mime)
          && declaredSize <= Math.min(config.maxImageBytes, 1024 * 1024)) {
          try {
            const downloaded = await downloadMediaMessage(m, "buffer", {},
              { logger, reuploadRequest: sock.updateMediaMessage });
            if (downloaded.length <= 1024 * 1024) {
              fileData = downloaded;
              extractedText = safeSourceText(downloaded, mime);
              textFromDocument = extractedText;
            }
          } catch (error) {
            console.error("Filter CRM document text extraction unavailable",
              error instanceof Error ? error.name : "unknown");
          }
        }
        registry.record({
          groupJid: jid, messageId: id, senderJid: sender, kind: "document",
          mimeType: mime, fileName: document.fileName ?? null, caption: document.caption ?? "",
          processing: extractedText ? "text_indexed" : "needs_extraction",
          body: fileData, extractedText,
        });
        sourceRecorded = true;
        if (extractedText && config.features.aiExtraction) {
          input.text = "!capture " + extractedText;
        } else {
          sourceNotice = extractedText
            ? "Filter CRM indexed text from this document. To capture a contact, use !lead Name | Company | Email | Phone | Notes."
            : "Filter CRM recorded this file's metadata, but its contents need a supported document parser or manual review. Nothing was invented or sent to STRATUM CRM.";
        }
      }
      const video = content.videoMessage;
      const audio = content.audioMessage;
      if (video || audio) {
        const part = video ?? audio!;
        registry.record({
          groupJid: jid, messageId: id, senderJid: sender, kind: video ? "video" : "audio",
          mimeType: part.mimetype ?? null, fileName: null, caption: video?.caption ?? "",
          processing: "needs_extraction",
        });
        sourceRecorded = true;
        sourceNotice = "Filter CRM registered this media source. Audio/video transcription or content extraction has not been enabled; it will not be treated as a verified lead.";
      }
      if (input.text && /^(?:source:|!sourceadd\s)/i.test(input.text.trim())) {
        registry.record({
          groupJid: jid, messageId: id, senderJid: sender, kind: "text",
          mimeType: "text/plain", fileName: null, caption: input.text.trim(),
          processing: "text_indexed", extractedText: input.text.trim(),
        });
        sourceRecorded = true;
        sourceNotice = "Filter CRM recorded this source note. Ask about a lead with !ask Name | question, or capture one with !lead.";
      }
    }
  }

  if (!input.text && !input.images.length && !input.vcards.length && !sourceRecorded) return;

  if (config.features.eventStream) publishGatewayEvent("whatsapp.message_received", { jid, id, sender, hasMedia: input.images.length > 0 || input.vcards.length > 0 });
  recordHistory({
    ts: new Date().toISOString(),
    id,
    jid,
    sender,
    senderName: m.pushName ?? "Teammate",
    type: "message",
    text: input.text ?? undefined,
    hasMedia: input.images.length > 0 || input.vcards.length > 0,
  });

  if (input.text) {
    const handled = await handlePlatformCommand({
      sock,
      message: m,
      jid,
      sender,
      senderName: m.pushName ?? "Teammate",
      text: input.text,
    });
    if (handled) return;
  }

  if (config.features.filterCrm) {
    const consumed = await handleFilterChat({
      sock, message: m, groupJid: jid, senderJid: sender, text: input.text ?? "",
      quotedMessageId: quotedId,
    });
    if (consumed) return;
    // Human group discussions are left intact. Only explicit contact/lead cues
    // plus a usable email/phone may initiate passive, review-only capture.
    const candidate = passiveLeadFromText(textFromDocument ?? input.text ?? "");
    if (candidate) {
      const created = stageFilterLead({
        ...candidate, sourceMessageId: id, sourceGroupJid: jid, sourceSenderJid: sender,
      }, textFromDocument ? "WhatsApp text attachment" : "WhatsApp group lead mention");
      if (created) {
        await sock.sendMessage(jid, {
          text: `Filter CRM captured a possible lead: ${created.lead.name}.\\nClassification: ${created.disposition}; ID: ${created.id}\\nPending review. Nothing has been sent to STRATUM CRM.\\nAsk: !ask ${created.id} | Why is this relevant?`,
        }, { quoted: m });
        return;
      }
    }
  }

  if (!config.features.leadCrm) {
    if (config.features.filterCrm && sourceNotice && !input.images.length && !input.vcards.length
      && !input.text?.startsWith("!capture ")) {
      await sock.sendMessage(jid, { text: sourceNotice }, { quoted: m });
      return;
    }
    await handleFilterOnlyIntake(input, id, jid, sender, async (message) => {
      await sock.sendMessage(jid, { text: message }, { quoted: m });
    });
    return;
  }

  const incoming: IncomingMessage = {
    id,
    senderId: sender,
    senderName: m.pushName ?? "Teammate",
    input,
    quotedId,
  };
  increment("messagesProcessed");
  await handleMessage(incoming, makeChat(sock, jid));
}

audit("process.start", {
  groupConfigured: config.allowedGroupJids.size > 0,
  senderAllowlistConfigured: config.allowedSenderJids.size > 0,
});
startOpsDashboard();
startAdvancedApi(() => activeSocket);
if (config.features.leadCrm) {
  await ensureSheet();
  console.log(`📄 CRM backend ready (Google Sheet tab "${config.sheetTab}").`);
}
await start();
