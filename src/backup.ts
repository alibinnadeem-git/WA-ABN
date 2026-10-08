import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "./config.js";
import { audit } from "./audit.js";

function backupsDir(): string {
  return join(config.dataDir, "backups", config.sessionId);
}

export function createBackup(): string {
  const root = backupsDir();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = join(root, stamp);
  mkdirSync(target, { recursive: true, mode: 0o700 });

  const candidates = [
    config.authDir,
    config.statePath,
    config.auditPath,
    config.historyPath,
    config.schedulerPath,
  ];
  for (const source of candidates) {
    if (!existsSync(source)) continue;
    cpSync(source, join(target, basename(source)), { recursive: true });
  }
  audit("backup.created", { session: config.sessionId, path: target });
  return target;
}

export function listBackups(): string[] {
  const root = backupsDir();
  if (!existsSync(root)) return [];
  return readdirSync(root).sort().reverse().slice(0, 50);
}
