import type { WASocket, WAMessage } from "baileys";
import { config } from "./config.js";
import { audit } from "./audit.js";
import { opsSnapshot } from "./ops.js";
import { cancelReminder, listReminders, parseDuration, scheduleReminder } from "./scheduler.js";
import { leadSummary, rowLink, searchLeads } from "./sheets.js";
import { searchHistory } from "./history.js";

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
        `*${config.appName}*\nWhatsApp: ${s.connection}\nUptime: ${Math.floor(s.uptimeSeconds / 60)} min\nProfile: ${config.profile}\nFeatures: ${Object.entries(config.features).filter(([,v])=>v).map(([k])=>k).join(", ")}`,
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
      const s = opsSnapshot();
      const lines = [`*${config.appName} Digest*`, `Processed: ${s.counters.messagesProcessed}`, `Rejected: ${s.counters.senderRejected}`, `Rate limited: ${s.counters.rateLimited}`];
      if (config.features.leadCrm) {
        const leads = await leadSummary();
        lines.push(`Leads: ${leads.total} · Hot ${leads.hot} · Warm ${leads.warm} · Cold ${leads.cold} · New ${leads.new}`);
      }
      await reply(input.sock, input.jid, input.message, lines.join("\n"));
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
