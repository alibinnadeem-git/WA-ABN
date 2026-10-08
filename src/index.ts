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

const logger = pino({ level: process.env.LOG_LEVEL ?? "warn" });
const seen = new Set<string>();
const announcedGroups = new Set<string>();
const recent = new Map<string, WAMessage>();
const senderWindows = new Map<string, number[]>();
let reconnectTimer: NodeJS.Timeout | null = null;

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

  if (config.pairingNumber && !sock.authState.creds.registered) {
    setTimeout(async () => {
      const code = await sock.requestPairingCode(config.pairingNumber!.replace(/\D/g, ""));
      audit("whatsapp.pairing_code_issued");
      console.log(`\nWhatsApp → Linked devices → Link with phone number → enter code: ${code}\n`);
    }, 3000);
  }

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr && !config.pairingNumber) {
      audit("whatsapp.qr_issued");
      console.log("Scan this QR with the bot's WhatsApp (Linked devices → Link a device):");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      audit("whatsapp.connected");
      console.log("✅ Connected to WhatsApp.");
      if (!config.groupJid) {
        console.log("WA_GROUP_JID is not set. Send any message in the leads group and its id will be printed here.");
      }
    }
    if (connection === "close") {
      const status = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
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
        audit("message.handler_error", { message: err instanceof Error ? err.message : "unknown" });
      }
    }
  });
}

async function onMessage(sock: WASocket, m: WAMessage): Promise<void> {
  const jid = m.key.remoteJid;
  const id = m.key.id;
  if (!jid?.endsWith("@g.us") || !id || m.key.fromMe || !m.message) return;

  if (!config.groupJid) {
    if (!announcedGroups.has(jid)) {
      announcedGroups.add(jid);
      const meta = await sock.groupMetadata(jid).catch(() => null);
      console.log(`Group "${meta?.subject ?? "?"}" → WA_GROUP_JID=${jid}`);
    }
    return;
  }
  if (jid !== config.groupJid) return;

  const sender = m.key.participant ?? jid;
  if (!senderAllowed(sender)) {
    audit("message.sender_rejected", { sender, group: jid });
    return;
  }
  if (rateLimited(sender)) {
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
        audit("message.media_rejected_size", { sender, bytes: declaredSize });
        await sock.sendMessage(jid, { text: "⚠️ Image is too large for the secure processing limit." }, { quoted: m });
        return;
      }
      const data = await downloadMediaMessage(m, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
      if (data.length > config.maxImageBytes) {
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

  if (!input.text && !input.images.length && !input.vcards.length) return;

  const incoming: IncomingMessage = {
    id,
    senderId: sender,
    senderName: m.pushName ?? "Teammate",
    input,
    quotedId,
  };
  await handleMessage(incoming, makeChat(sock, jid));
}

audit("process.start", {
  groupConfigured: Boolean(config.groupJid),
  senderAllowlistConfigured: config.allowedSenderJids.size > 0,
});
await ensureSheet();
console.log(`📄 Google Sheet ready (tab "${config.sheetTab}").`);
await start();
