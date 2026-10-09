import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "./config.js";
import { audit } from "./audit.js";

export interface RetryItem {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  error: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

const path = config.retryPath;
let queue: RetryItem[] = [];

function load(): void {
  if (!existsSync(path)) return;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    queue = Array.isArray(parsed) ? parsed : [];
  } catch {
    queue = [];
  }
}

function save(): void {
  writeFileSync(path, JSON.stringify(queue, null, 2), { mode: 0o600 });
}

load();

export function enqueueRetry(type: string, payload: Record<string, unknown>, error: unknown): RetryItem {
  const now = new Date().toISOString();
  const item: RetryItem = {
    id: randomUUID().slice(0, 8),
    type,
    payload,
    error: error instanceof Error ? error.message : String(error),
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  queue.push(item);
  save();
  audit("retry.enqueued", { id: item.id, type });
  return item;
}

export function listRetries(): RetryItem[] {
  return [...queue].reverse().slice(0, 100);
}

export function resolveRetry(id: string): boolean {
  const before = queue.length;
  queue = queue.filter((item) => item.id !== id);
  if (queue.length === before) return false;
  save();
  audit("retry.resolved", { id });
  return true;
}
