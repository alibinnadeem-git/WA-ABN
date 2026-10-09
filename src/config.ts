import fs from "node:fs";
import path from "node:path";
import { claimTenantDataRoot, resolveTenantPaths } from "./tenant.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return value;
}

function optional(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
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

function loadJsonObject(raw: string): Record<string, string> {
  const value = raw.trim();
  if (value.startsWith("{")) return JSON.parse(value);
  if (fs.existsSync(value)) return JSON.parse(fs.readFileSync(value, "utf8"));
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
const tenantPaths = resolveTenantPaths(dataDir, process.env.TENANT_ID, process.env.WA_SESSION_ID);
const { tenantId, sessionId, tenantDir, sessionDir } = tenantPaths;
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
if (fs.lstatSync(dataDir).isSymbolicLink()) throw new Error("Tenant data volume must not be symlinked");
claimTenantDataRoot(dataDir, tenantId);
for (const dir of [dataDir, path.join(dataDir, "tenants"), tenantDir, path.join(tenantDir, "sessions"), sessionDir]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error("Tenant data directories must not be symlinks");
  try { fs.chmodSync(dir, 0o700); } catch {}
}

const featureLeadCrm = bool("FEATURE_LEAD_CRM", false);
const serviceAccountRaw = optional("GOOGLE_SERVICE_ACCOUNT_JSON");

export const config = {
  // Generic application identity. STRATUM is just one possible deployment profile.
  appId: required("APP_ID"),
  appName: required("APP_NAME"),
  appDescription: process.env.APP_DESCRIPTION || "Team messaging operations",
  appContext:
    process.env.APP_CONTEXT ||
    process.env.COMPANY_CONTEXT ||
    "A team using WhatsApp for operational workflows.",
  botDisplayName: required("BOT_DISPLAY_NAME"),
  profile: process.env.APP_PROFILE || "generic",

  dataDir,
  tenantId,
  tenantDir,
  sessionId,
  sessionDir,
  authDir: tenantPaths.authDir,
  statePath: tenantPaths.statePath,
  auditPath: tenantPaths.auditPath,
  historyPath: tenantPaths.historyPath,
  schedulerPath: tenantPaths.schedulerPath,
  retryPath: tenantPaths.retryPath,
  backupDir: tenantPaths.backupDir,

  features: {
    leadCrm: featureLeadCrm,
    aiExtraction: bool("FEATURE_AI_EXTRACTION", featureLeadCrm),
    opsDashboard: bool("OPS_DASHBOARD_ENABLED", false),
    scheduler: bool("FEATURE_SCHEDULER", true),
    polls: bool("FEATURE_POLLS", true),
    contacts: bool("FEATURE_CONTACTS", true),
    messageHistory: bool("FEATURE_MESSAGE_HISTORY", false),
    receipts: bool("FEATURE_RECEIPTS", true),
    search: bool("FEATURE_SEARCH", true),
    digests: bool("FEATURE_DIGESTS", true),
    exports: bool("FEATURE_EXPORTS", true),
    pipeline: bool("FEATURE_PIPELINE", true),
    backups: bool("FEATURE_BACKUPS", true),
    retryQueue: bool("FEATURE_RETRY_QUEUE", true),
    webhooks: bool("FEATURE_WEBHOOKS", false),
  },

  // Optional read-only operations dashboard. Localhost by default.
  opsDashboardEnabled: bool("OPS_DASHBOARD_ENABLED", false),
  opsDashboardHost: process.env.OPS_DASHBOARD_HOST || "127.0.0.1",
  opsDashboardPort: Math.max(1, Math.min(65535, Number(process.env.OPS_DASHBOARD_PORT ?? 8787))),
  opsDashboardToken: process.env.OPS_DASHBOARD_TOKEN || "",

  // WhatsApp trust boundary
  groupJid: optional("WA_GROUP_JID"),
  allowedGroupJids: csv("WA_ALLOWED_GROUP_JIDS"),
  pairingNumber: optional("WA_PAIRING_NUMBER"),
  allowedSenderJids: csv("WA_ALLOWED_SENDER_JIDS"),
  contextWaitMs: Number(process.env.CONTEXT_WAIT_SECONDS ?? 120) * 1000,
  maxMessagesPerMinute: Math.max(1, Number(process.env.MAX_MESSAGES_PER_MINUTE ?? 20)),
  maxImageBytes: Math.max(1024 * 1024, Number(process.env.MAX_IMAGE_BYTES ?? 8 * 1024 * 1024)),
  authEncryptionKey: parseAuthKey(required("WA_AUTH_ENCRYPTION_KEY")),

  // History/privacy
  historyMaxTextChars: Math.max(0, Math.min(20_000, Number(process.env.HISTORY_MAX_TEXT_CHARS ?? 2000))),
  historyRetentionDays: Math.max(1, Number(process.env.HISTORY_RETENTION_DAYS ?? 30)),
  autoDigestEveryHours: Math.max(0, Number(process.env.AUTO_DIGEST_EVERY_HOURS ?? 0)),

  // Optional outbound workflow integration (n8n/automation). Disabled by default.
  outboundWebhookUrl: optional("OUTBOUND_WEBHOOK_URL"),
  outboundWebhookToken: optional("OUTBOUND_WEBHOOK_TOKEN"),
  webhookAllowedHosts: csv("WEBHOOK_ALLOWED_HOSTS"),

  // AI
  model: process.env.CLAUDE_MODEL || "claude-opus-5-5",
  defaultRegion: optional("DEFAULT_PHONE_REGION"),

  // Optional Google Sheets CRM backend. Required only when FEATURE_LEAD_CRM=true.
  sheetId: featureLeadCrm ? required("GOOGLE_SHEET_ID") : optional("GOOGLE_SHEET_ID"),
  sheetTab: process.env.GOOGLE_SHEET_TAB || "Leads",
  serviceAccount:
    featureLeadCrm
      ? loadJsonObject(serviceAccountRaw ?? required("GOOGLE_SERVICE_ACCOUNT_JSON"))
      : serviceAccountRaw
        ? loadJsonObject(serviceAccountRaw)
        : null,
};

if (config.opsDashboardEnabled && config.opsDashboardToken.length < 32) {
  throw new Error("OPS_DASHBOARD_TOKEN must be at least 32 characters when the dashboard is enabled");
}

if (config.allowedGroupJids.size === 0 && config.groupJid) {
  config.allowedGroupJids.add(config.groupJid);
}

for (const [key, value] of Object.entries({
  APP_ID: config.appId,
  APP_NAME: config.appName,
  BOT_DISPLAY_NAME: config.botDisplayName,
})) {
  if (value.length > 100 || /[\r\n<>]/.test(value)) {
    throw new Error(`${key} contains unsafe branding characters`);
  }
}
if (config.features.webhooks && (!config.outboundWebhookUrl || config.webhookAllowedHosts.size === 0)) {
  throw new Error("Enabled webhooks require a vendor-specific URL and explicit WEBHOOK_ALLOWED_HOSTS");
}
