import path from "node:path";

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/;

/** Tenant/session IDs are trusted deployment identifiers, never filesystem paths. */
export function validateIsolationId(value: string | undefined, name: string): string {
  if (!value || !ID_PATTERN.test(value)) {
    throw new Error(`${name} must be explicitly set to a lowercase slug (2-64 chars, letters/numbers/-/_; no paths)`);
  }
  if (name === "TENANT_ID" && ["default", "shared", "unknown"].includes(value)) {
    throw new Error("TENANT_ID must identify a specific vendor; generic/shared tenant IDs are prohibited");
  }
  return value;
}

export function resolveTenantPaths(dataRoot: string, tenantInput: string | undefined, sessionInput: string | undefined) {
  const tenantId = validateIsolationId(tenantInput, "TENANT_ID");
  const sessionId = validateIsolationId(sessionInput, "WA_SESSION_ID");
  const root = path.resolve(dataRoot);
  const tenantDir = path.join(root, "tenants", tenantId);
  const sessionDir = path.join(tenantDir, "sessions", sessionId);

  return {
    tenantId,
    sessionId,
    root,
    tenantDir,
    sessionDir,
    authDir: path.join(sessionDir, "wa-auth"),
    statePath: path.join(sessionDir, "state.json"),
    auditPath: path.join(sessionDir, "security-audit.jsonl"),
    historyPath: path.join(sessionDir, "message-history.jsonl"),
    schedulerPath: path.join(sessionDir, "scheduled-jobs.json"),
    retryPath: path.join(sessionDir, "retry-queue.json"),
    backupDir: path.join(sessionDir, "backups"),
  };
}
