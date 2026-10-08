import { appendFileSync, chmodSync, existsSync, writeFileSync } from "node:fs";
import type { JsonValue } from "./types.js";
import { config } from "./config.js";

export function audit(event: string, details: Record<string, JsonValue> = {}): void {
  const record = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...details,
  });
  try {
    if (!existsSync(config.auditPath)) {
      writeFileSync(config.auditPath, "", { mode: 0o600 });
      chmodSync(config.auditPath, 0o600);
    }
    appendFileSync(config.auditPath, record + "\n", { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    console.error("audit log write failed", error);
  }
}
