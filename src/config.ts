import fs from "node:fs";
import path from "node:path";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return value;
}

function loadServiceAccount(): Record<string, string> {
  const raw = required("GOOGLE_SERVICE_ACCOUNT_JSON").trim();
  // Accept inline JSON, base64-encoded JSON, or a path to the key file.
  if (raw.startsWith("{")) return JSON.parse(raw);
  if (fs.existsSync(raw)) return JSON.parse(fs.readFileSync(raw, "utf8"));
  return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
}

const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
fs.mkdirSync(dataDir, { recursive: true });

export const config = {
  dataDir,
  authDir: path.join(dataDir, "wa-auth"),
  statePath: path.join(dataDir, "state.json"),

  // WhatsApp
  groupJid: process.env.WA_GROUP_JID || null,
  pairingNumber: process.env.WA_PAIRING_NUMBER || null,
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
