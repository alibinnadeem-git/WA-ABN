import fs from "node:fs";
import path from "node:path";
import { parseAuthEncryptionKey } from "./encrypted-auth-state.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return value;
}

function loadServiceAccount(): Record<string, string> {
  const raw = required("GOOGLE_SERVICE_ACCOUNT_JSON").trim();
  // Accept inline JSON, base64-encoded JSON, or a path to the key file.
  if (raw.startsWith("{")) return JSON.parse(raw);
  if (fs.existsSync(raw)) {
    const stat = fs.statSync(raw);
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      console.warn(`⚠️ Google service-account file is readable by group/others: ${raw}. Recommended: chmod 600 ${raw}`);
    }
    return JSON.parse(fs.readFileSync(raw, "utf8"));
  }
  return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
}

function csv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
try {
  fs.chmodSync(dataDir, 0o700);
} catch {
  // Some mounted filesystems do not support chmod; container/host permissions must enforce isolation.
}

export const config = {
  dataDir,
  authDir: path.join(dataDir, "wa-auth"),
  statePath: path.join(dataDir, "state.json"),
  authEncryptionKey: parseAuthEncryptionKey(required("WA_AUTH_ENCRYPTION_KEY")),

  // WhatsApp
  groupJid: process.env.WA_GROUP_JID || null,
  pairingNumber: process.env.WA_PAIRING_NUMBER || null,
  contextWaitMs: Number(process.env.CONTEXT_WAIT_SECONDS ?? 120) * 1000,
  commandAdminJids: csv("WA_COMMAND_ADMIN_JIDS"),
  processAllTextMessages: process.env.PROCESS_ALL_TEXT_MESSAGES === "true",
  maxMediaBytes: Number(process.env.MAX_MEDIA_MB ?? 8) * 1024 * 1024,
  maxTextChars: Number(process.env.MAX_TEXT_CHARS ?? 4000),
  maxVcardChars: Number(process.env.MAX_VCARD_CHARS ?? 16000),

  // Claude
  model: process.env.CLAUDE_MODEL || "claude-opus-5-5",
  companyContext:
    process.env.COMPANY_CONTEXT ||
    "STRATUM is a company that meets prospective clients and partners at events and in person.",
  defaultRegion: process.env.DEFAULT_PHONE_REGION || null,

  // Google Sheets
  sheetId: required("GOOGLE_SHEET_ID"),
  sheetTab: process.env.GOOGLE_SHEET_TAB || "Leads",
  serviceAccount: loadServiceAccount(),
};
