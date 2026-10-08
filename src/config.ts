import fs from "node:fs";
import path from "node:path";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return value;
}

function parseAuthKey(raw: string): Buffer {
  const value = raw.trim();
  const decoded = /^[0-9a-fA-F]{64}$/.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (decoded.length !== 32) {
    throw new Error("WA_AUTH_ENCRYPTION_KEY must be a 32-byte key encoded as base64 or 64 hex characters");
  }
  return decoded;
}

function loadServiceAccount(): Record<string, string> {
  const raw = required("GOOGLE_SERVICE_ACCOUNT_JSON").trim();
  if (raw.startsWith("{")) return JSON.parse(raw);
  if (fs.existsSync(raw)) return JSON.parse(fs.readFileSync(raw, "utf8"));
  return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
}

function bool(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function csv(name: string): Set<string> {
  return new Set(
    (process.env[name] ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  );
}

const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
try { fs.chmodSync(dataDir, 0o700); } catch {}

export const config = {
  dataDir,
  authDir: path.join(dataDir, "wa-auth"),
  statePath: path.join(dataDir, "state.json"),
  auditPath: path.join(dataDir, "security-audit.jsonl"),

  // Optional read-only operations dashboard. Localhost by default.
  opsDashboardEnabled: bool("OPS_DASHBOARD_ENABLED", false),
  opsDashboardHost: process.env.OPS_DASHBOARD_HOST || "127.0.0.1",
  opsDashboardPort: Math.max(1, Math.min(65535, Number(process.env.OPS_DASHBOARD_PORT ?? 8787))),
  opsDashboardToken: process.env.OPS_DASHBOARD_TOKEN || "",

  // WhatsApp trust boundary
  groupJid: process.env.WA_GROUP_JID || null,
  pairingNumber: process.env.WA_PAIRING_NUMBER || null,
  allowedSenderJids: csv("WA_ALLOWED_SENDER_JIDS"),
  contextWaitMs: Number(process.env.CONTEXT_WAIT_SECONDS ?? 120) * 1000,
  maxMessagesPerMinute: Math.max(1, Number(process.env.MAX_MESSAGES_PER_MINUTE ?? 20)),
  maxImageBytes: Math.max(1024 * 1024, Number(process.env.MAX_IMAGE_BYTES ?? 8 * 1024 * 1024)),
  authEncryptionKey: parseAuthKey(required("WA_AUTH_ENCRYPTION_KEY")),

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


if (config.opsDashboardEnabled && config.opsDashboardToken.length < 32) {
  throw new Error("OPS_DASHBOARD_TOKEN must be at least 32 characters when the dashboard is enabled");
}
