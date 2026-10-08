import fs from "node:fs";
import path from "node:path";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return value;
}

function envTrue(name: string): boolean {
  return process.env[name]?.trim().toLowerCase() === "true";
}

function loadServiceAccount(): Record<string, string> {
  const raw = required("GOOGLE_SERVICE_ACCOUNT_JSON").trim();
  if (raw.startsWith("{")) return JSON.parse(raw);
  if (fs.existsSync(raw)) return JSON.parse(fs.readFileSync(raw, "utf8"));
  return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
}

const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
try {
  fs.chmodSync(dataDir, 0o700);
} catch {
  // Some development filesystems do not support POSIX modes.
}

const maxMediaBytes = Number(process.env.WA_MAX_MEDIA_BYTES ?? 10 * 1024 * 1024);
if (!Number.isFinite(maxMediaBytes) || maxMediaBytes <= 0) {
  throw new Error("WA_MAX_MEDIA_BYTES must be a positive number");
}

export const config = {
  dataDir,
  authDir: path.join(dataDir, "wa-auth"),
  statePath: path.join(dataDir, "state.json"),

  // WhatsApp
  groupJid: process.env.WA_GROUP_JID || null,
  pairingNumber: process.env.WA_PAIRING_NUMBER || null,
  allowGroupDiscovery: envTrue("WA_ALLOW_GROUP_DISCOVERY"),
  allowPlaintextAuthMigration: envTrue("WA_ALLOW_PLAINTEXT_AUTH_MIGRATION"),
  authEncryptionKey: required("WA_AUTH_ENCRYPTION_KEY"),
  maxMediaBytes,
  contextWaitMs: Number(process.env.CONTEXT_WAIT_SECONDS ?? 120) * 1000,

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
