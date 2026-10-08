import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  normalizeMessageContent,
  type WAMessage,
  type WASocket,
} from "baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { config } from "./config.js";
import { handleMessage, type Chat, type IncomingMessage } from "./leads.js";
import type { MessageInput } from "./ai.js";
import { ensureSheet } from "./sheets.js";
import { useEncryptedMultiFileAuthState } from "./encrypted-auth-state.js";

const logger = pino({ level: process.env.LOG_LEVEL ?? "warn" });
const seen = new Set<string>(); // WhatsApp can redeliver; process each message once
const announcedGroups = new Set<string>();
const recent = new Map<string, WAMessage>(); // recent group messages, for quoting/reacting later

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

const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
type ImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

async function start(): Promise<void> {
  const { state, saveCreds } = await useEncryptedMultiFileAuthState(config.authDir, config.authEncryptionKey);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers.macOS("Desktop"),
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  if (config.pairingNumber && !sock.authState.creds.registered) {
    // Pair by code instead of QR (handy on a headless server).
    setTimeout(async () => {
      const code = await sock.requestPairingCode(config.pairingNumber!.replace(/\D/g, ""));
      console.log(`\nWhatsApp → Linked devices → Link with phone number → enter code: ${code}\n`);
    }, 3000);
  }

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr && !config.pairingNumber) {
      console.log("Scan this QR with the bot's WhatsApp (Linked devices → Link a device):");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      console.log("✅ Connected to WhatsApp.");
      if (!config.groupJid) {
        console.log("WA_GROUP_JID is not set. Send any message in the leads group and its id will be printed here.");
      }
    }
    if (connection === "close") {
      const status = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      if (status === DisconnectReason.loggedOut) {
        console.error(`Logged out. Delete ${config.authDir} and restart to link again.`);
        process.exit(1);
      }
      console.warn(`Connection closed (${status ?? "unknown"}), reconnecting…`);
      setTimeout(() => void start(), 2000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      try {
        await onMessage(sock, m);
      } catch (err) {
        console.error("Failed to handle message", err);
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
  if (seen.has(id)) return;
  seen.add(id);
  remember(m);

  const content = normalizeMessageContent(m.message);
  if (!content) return;

  const input: MessageInput = { images: [], vcards: [], text: null };
  let quotedId: string | null = null;

  if (content.conversation) input.text = content.conversation.slice(0, config.maxTextChars);
  if (content.extendedTextMessage) {
    input.text = content.extendedTextMessage.text?.slice(0, config.maxTextChars) ?? null;
    quotedId = content.extendedTextMessage.contextInfo?.stanzaId ?? null;
  }

  const image = content.imageMessage;
  const docImage = content.documentMessage?.mimetype?.startsWith("image/") ? content.documentMessage : null;
  const media = image ?? docImage;
  if (media) {
    input.text = media.caption?.slice(0, config.maxTextChars) ?? null;
    const mime = (media.mimetype ?? "image/jpeg").split(";")[0] as ImageType;
    if (SUPPORTED_IMAGE_TYPES.includes(mime)) {
      const declaredSize = Number(media.fileLength ?? 0);
      if (Number.isFinite(declaredSize) && declaredSize > config.maxMediaBytes) {
        await sock.sendMessage(jid, { text: `⚠️ Image is too large for lead processing (limit: ${Math.round(config.maxMediaBytes / 1024 / 1024)} MB).` }, { quoted: m });
        return;
      }
      const data = await downloadMediaMessage(m, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
      if (data.length > config.maxMediaBytes) {
        await sock.sendMessage(jid, { text: `⚠️ Image is too large for lead processing (limit: ${Math.round(config.maxMediaBytes / 1024 / 1024)} MB).` }, { quoted: m });
        return;
      }
      input.images.push({ data, mediaType: mime });
    }
  }

  if (content.contactMessage?.vcard) {
    input.vcards.push(content.contactMessage.vcard.slice(0, config.maxVcardChars));
  }
  for (const c of content.contactsArrayMessage?.contacts ?? []) {
    if (c.vcard) input.vcards.push(c.vcard.slice(0, config.maxVcardChars));
  }

  if (!input.text && !input.images.length && !input.vcards.length) return;

  const incoming: IncomingMessage = {
    id,
    senderId: m.key.participant ?? jid,
    senderName: m.pushName ?? "Teammate",
    input,
    quotedId,
  };
  await handleMessage(incoming, makeChat(sock, jid));
}

await ensureSheet();
console.log(`📄 Google Sheet ready (tab "${config.sheetTab}").`);
await start();
