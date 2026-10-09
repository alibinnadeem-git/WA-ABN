import type { WASocket, WAMessage } from "baileys";
import { config } from "./config.js";
import { audit } from "./audit.js";
import { opsSnapshot } from "./ops.js";
import { cancelReminder, listReminders, parseDuration, scheduleReminder } from "./scheduler.js";
import { appendActivity, leadSummary, pipelineSummary, rowLink, searchLeads, updateLeadFields } from "./sheets.js";
import { searchHistory } from "./history.js";
import { createBackup, listBackups } from "./backup.js";
import { listRetries, resolveRetry } from "./retry.js";
import { buildDigest } from "./digests.js";

export interface CommandInput {
  sock: WASocket;
  message: WAMessage;
  jid: string;
  sender: string;
  senderName: string;
  text: string;
}

function helpText(): string {
  const commands = [
    "*!help* — commands enabled for this deployment",
    "*!status* — connection/runtime status",
  ];
  if (config.features.scheduler) {
    commands.push("*!remind 2h message* — schedule a group reminder", "*!reminders* — list reminders", "*!cancel <id>* — cancel reminder");
  }
  if (config.features.polls) commands.push("*!poll Question | Option A | Option B* — create a poll");
  if (config.features.contacts) commands.push("*!whoami* — show your WhatsApp JID", "*!participants* — group participant/admin counts");
  if (config.features.search) commands.push("*!search <query>* — search enabled data sources");
  if (config.features.digests) commands.push("*!digest* — operational/CRM summary");
  if (config.features.exports && config.features.leadCrm) commands.push("*!sheet* — open the configured CRM sheet");
  if (config.features.pipeline && config.features.leadCrm) commands.push("*!pipeline* — pipeline summary", "*!assign <row> <owner>* — assign lead", "*!stage <row> <stage>* — update pipeline stage", "*!followup <row> <2d> [note]* — set follow-up + reminder");
  if (config.features.backups) commands.push("*!backup* — create encrypted-state/config data backup", "*!backups* — list backups");
  if (config.features.retryQueue) commands.push("*!retries* — list failed work", "*!retry-resolve <id>* — mark retry item resolved");
  if (config.features.leadCrm) commands.push("*!event <name>* / *!event off* — CRM event tagging");
  return `*${config.botDisplayName}*\n${config.appDescription}\n\n${commands.join("\n")}`;
}

async function reply(sock: WASocket, jid: string, message: WAMessage, text: string): Promise<void> {
  await sock.sendMessage(jid, { text }, { quoted: message });
}

export async function handlePlatformCommand(input: CommandInput): Promise<boolean> {
  const text = input.text.trim();
  if (!text.startsWith("!")) return false;
  const [rawCmd, ...rest] = text.slice(1).split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "help":
      await reply(input.sock, input.jid, input.message, helpText());
      return true;

    case "status": {
      const s = opsSnapshot();
      await reply(
        input.sock,
        input.jid,
        input.message,
        `*${config.appName}*\nWhatsApp: ${s.connection}\nUptime: ${Math.floor(s.uptimeSeconds / 60)} min`,
      );
      return true;
    }

    case "remind": {
      if (!config.features.scheduler) return false;
      const [durationToken, ...messageParts] = arg.split(/\s+/);
      const delayMs = parseDuration(durationToken ?? "");
      const message = messageParts.join(" ").trim();
      if (!delayMs || !message) {
        await reply(input.sock, input.jid, input.message, "Usage: !remind 30m Follow up with the client");
        return true;
      }
      const job = scheduleReminder(input.jid, input.sender, delayMs, message);
      await reply(input.sock, input.jid, input.message, `⏰ Reminder ${job.id} scheduled for ${job.dueAt}.`);
      return true;
    }

    case "reminders": {
      if (!config.features.scheduler) return false;
      const rows = listReminders(input.jid);
      await reply(input.sock, input.jid, input.message, rows.length ? rows.map((j) => `${j.id} · ${j.dueAt} · ${j.message}`).join("\n") : "No scheduled reminders.");
      return true;
    }

    case "cancel": {
      if (!config.features.scheduler) return false;
      const ok = cancelReminder(arg, input.sender);
      await reply(input.sock, input.jid, input.message, ok ? `Cancelled ${arg}.` : `Reminder ${arg} not found.`);
      return true;
    }

    case "poll": {
      if (!config.features.polls) return false;
      const parts = arg.split("|").map((x) => x.trim()).filter(Boolean);
      if (parts.length < 3) {
        await reply(input.sock, input.jid, input.message, "Usage: !poll Question | Option A | Option B");
        return true;
      }
      const [name, ...values] = parts;
      await input.sock.sendMessage(input.jid, { poll: { name, values: values.slice(0, 12), selectableCount: 1 } });
      audit("command.poll_created", { sender: input.sender, group: input.jid, options: values.length });
      return true;
    }

    case "whoami":
      if (!config.features.contacts) return false;
      await reply(input.sock, input.jid, input.message, `${input.senderName}: ${input.sender}`);
      return true;

    case "participants": {
      if (!config.features.contacts) return false;
      const meta = await input.sock.groupMetadata(input.jid);
      const admins = meta.participants.filter((p) => Boolean(p.admin)).length;
      await reply(input.sock, input.jid, input.message, `${meta.subject}: ${meta.participants.length} participant(s), ${admins} admin(s).`);
      return true;
    }

    case "search": {
      if (!config.features.search) return false;
      if (!arg) {
        await reply(input.sock, input.jid, input.message, "Usage: !search <name, company, note, message text…>");
        return true;
      }
      const chunks: string[] = [];
      if (config.features.leadCrm) {
        const rows = await searchLeads(arg, 5);
        if (rows.length) chunks.push("*CRM*\n" + rows.map((r) => `• ${r["Full Name"] || "Unknown"} · ${r.Company || ""} · ${r.Priority || ""}`).join("\n"));
      }
      if (config.features.messageHistory) {
        const rows = searchHistory(arg, 5);
        if (rows.length) chunks.push("*Message history*\n" + rows.map((r) => `• ${r.ts} · ${r.senderName || r.sender} · ${r.text || r.status || ""}`).join("\n"));
      }
      await reply(input.sock, input.jid, input.message, chunks.join("\n\n") || "No matches found.");
      return true;
    }

    case "digest": {
      if (!config.features.digests) return false;
      await reply(input.sock, input.jid, input.message, await buildDigest());
      return true;
    }

    case "pipeline": {
      if (!config.features.pipeline || !config.features.leadCrm) return false;
      const counts = await pipelineSummary();
      const lines = Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([stage,count]) => `• ${stage}: ${count}`);
      await reply(input.sock, input.jid, input.message, lines.length ? `*Pipeline*\n${lines.join("\n")}` : "Pipeline is empty.");
      return true;
    }

    case "assign": {
      if (!config.features.pipeline || !config.features.leadCrm) return false;
      const [rowToken, ...ownerParts] = arg.split(/\s+/);
      const row = Number(rowToken);
      const owner = ownerParts.join(" ").trim();
      if (!Number.isInteger(row) || row < 2 || !owner) {
        await reply(input.sock, input.jid, input.message, "Usage: !assign <row> <owner>");
        return true;
      }
      await updateLeadFields(row, { Owner: owner });
      await appendActivity(row, `Assigned to ${owner} by ${input.senderName}`);
      await reply(input.sock, input.jid, input.message, `Assigned CRM row ${row} to ${owner}.`);
      return true;
    }

    case "stage": {
      if (!config.features.pipeline || !config.features.leadCrm) return false;
      const [rowToken, ...stageParts] = arg.split(/\s+/);
      const row = Number(rowToken);
      const stage = stageParts.join(" ").trim();
      if (!Number.isInteger(row) || row < 2 || !stage) {
        await reply(input.sock, input.jid, input.message, "Usage: !stage <row> <stage>");
        return true;
      }
      await updateLeadFields(row, { "Pipeline Stage": stage });
      await appendActivity(row, `Pipeline stage → ${stage} by ${input.senderName}`);
      await reply(input.sock, input.jid, input.message, `CRM row ${row} moved to ${stage}.`);
      return true;
    }

    case "followup": {
      if (!config.features.pipeline || !config.features.leadCrm || !config.features.scheduler) return false;
      const [rowToken, durationToken, ...noteParts] = arg.split(/\s+/);
      const row = Number(rowToken);
      const delayMs = parseDuration(durationToken ?? "");
      if (!Number.isInteger(row) || row < 2 || !delayMs) {
        await reply(input.sock, input.jid, input.message, "Usage: !followup <row> <30m|2h|3d|1w> [note]");
        return true;
      }
      const dueAt = new Date(Date.now() + delayMs).toISOString();
      const note = noteParts.join(" ").trim();
      await updateLeadFields(row, { "Follow-up Due": dueAt });
      await appendActivity(row, `Follow-up set for ${dueAt}${note ? `: ${note}` : ""}`);
      const job = scheduleReminder(input.jid, input.sender, delayMs, `CRM row ${row} follow-up${note ? `: ${note}` : ""}`);
      await reply(input.sock, input.jid, input.message, `Follow-up set for row ${row} at ${dueAt} (reminder ${job.id}).`);
      return true;
    }

    case "backup": {
      if (!config.features.backups) return false;
      const path = createBackup();
      await reply(input.sock, input.jid, input.message, `Backup created: ${path.split("/").pop()}`);
      return true;
    }

    case "backups": {
      if (!config.features.backups) return false;
      const items = listBackups();
      await reply(input.sock, input.jid, input.message, items.length ? items.join("\n") : "No backups yet.");
      return true;
    }

    case "retries": {
      if (!config.features.retryQueue) return false;
      const items = listRetries();
      await reply(input.sock, input.jid, input.message, items.length ? items.slice(0,10).map((x)=>`${x.id} · ${x.type} · ${x.error}`).join("\n") : "Retry queue is empty.");
      return true;
    }

    case "retry-resolve": {
      if (!config.features.retryQueue) return false;
      const ok = resolveRetry(arg);
      await reply(input.sock, input.jid, input.message, ok ? `Resolved retry ${arg}.` : `Retry ${arg} not found.`);
      return true;
    }

    case "sheet":
      if (!config.features.exports || !config.features.leadCrm) return false;
      await reply(input.sock, input.jid, input.message, rowLink(null));
      return true;

    default:
      return false;
  }
}
