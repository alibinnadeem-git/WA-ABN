import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { config } from "./config.js";

export interface HistoryRecord {
  ts: string;
  id: string;
  jid: string;
  sender: string;
  senderName?: string;
  type: "message" | "receipt";
  text?: string;
  hasMedia?: boolean;
  status?: string;
}

export function recordHistory(record: HistoryRecord): void {
  if (!config.features.messageHistory) return;
  const safe = {
    ...record,
    text: record.text?.slice(0, config.historyMaxTextChars),
  };
  appendFileSync(config.historyPath, JSON.stringify(safe) + "\n", { encoding: "utf8", mode: 0o600 });
}

export function searchHistory(query: string, limit = 50): HistoryRecord[] {
  if (!config.features.messageHistory || !existsSync(config.historyPath)) return [];
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const lines = readFileSync(config.historyPath, "utf8").trim().split("\n").filter(Boolean);
  const out: HistoryRecord[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < Math.min(Math.max(limit, 1), 100); i--) {
    try {
      const item = JSON.parse(lines[i]) as HistoryRecord;
      if (JSON.stringify(item).toLowerCase().includes(needle)) out.push(item);
    } catch {}
  }
  return out;
}

export function historyStats(): { enabled: boolean; bytes: number } {
  if (!config.features.messageHistory || !existsSync(config.historyPath)) return { enabled: config.features.messageHistory, bytes: 0 };
  return { enabled: true, bytes: statSync(config.historyPath).size };
}
