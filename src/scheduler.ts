import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "./config.js";
import { audit } from "./audit.js";

export interface ScheduledJob {
  id: string;
  dueAt: string;
  jid: string;
  createdBy: string;
  message: string;
  createdAt: string;
}

type Sender = (jid: string, message: string) => Promise<void>;

let sender: Sender | null = null;
let timer: NodeJS.Timeout | null = null;
let jobs: ScheduledJob[] = [];

function load(): void {
  if (!existsSync(config.schedulerPath)) return;
  try {
    const parsed = JSON.parse(readFileSync(config.schedulerPath, "utf8"));
    jobs = Array.isArray(parsed) ? parsed : [];
  } catch {
    jobs = [];
  }
}

function save(): void {
  writeFileSync(config.schedulerPath, JSON.stringify(jobs, null, 2), { mode: 0o600 });
}

async function tick(): Promise<void> {
  if (!sender) return;
  const now = Date.now();
  const due = jobs.filter((job) => Date.parse(job.dueAt) <= now);
  if (!due.length) return;
  jobs = jobs.filter((job) => Date.parse(job.dueAt) > now);
  save();
  for (const job of due) {
    try {
      await sender(job.jid, `⏰ Reminder: ${job.message}`);
      audit("scheduler.reminder_sent", { id: job.id, jid: job.jid, createdBy: job.createdBy });
    } catch (error) {
      jobs.push(job);
      save();
      audit("scheduler.reminder_failed", { id: job.id, message: error instanceof Error ? error.message : "unknown" });
    }
  }
}

export function startScheduler(send: Sender): void {
  if (!config.features.scheduler) return;
  sender = send;
  load();
  if (!timer) timer = setInterval(() => void tick(), 15_000);
  void tick();
}

export function scheduleReminder(jid: string, createdBy: string, delayMs: number, message: string): ScheduledJob {
  if (!config.features.scheduler) throw new Error("Scheduler is disabled");
  const job: ScheduledJob = {
    id: randomUUID().slice(0, 8),
    dueAt: new Date(Date.now() + delayMs).toISOString(),
    jid,
    createdBy,
    message: message.slice(0, 4000),
    createdAt: new Date().toISOString(),
  };
  jobs.push(job);
  jobs.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  save();
  audit("scheduler.reminder_created", { id: job.id, jid, createdBy, dueAt: job.dueAt });
  return job;
}

export function listReminders(jid?: string): ScheduledJob[] {
  return jobs.filter((j) => !jid || j.jid === jid).slice(0, 50);
}

export function cancelReminder(id: string, requester: string): boolean {
  const before = jobs.length;
  jobs = jobs.filter((j) => j.id !== id);
  if (jobs.length === before) return false;
  save();
  audit("scheduler.reminder_cancelled", { id, requester });
  return true;
}

export function parseDuration(input: string): number | null {
  const match = input.trim().match(/^(\d+)(s|m|h|d|w)$/i);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  const factor = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 604_800_000;
  return n * factor;
}
