import fs from "node:fs";
import { enrichLead, extractLeads, type Extraction, type Lead, type MessageInput } from "./ai.js";
import { config } from "./config.js";
import { audit } from "./audit.js";
import { appendLead, appendNoteToRow, findDuplicate, rowLink } from "./sheets.js";
import { increment, setCurrentEvent, setPendingLeads } from "./ops.js";

/** What the WhatsApp layer hands us for each group message. */
export interface IncomingMessage {
  id: string;
  senderId: string;
  senderName: string;
  input: MessageInput;
  /** Id of the message this one replies to (swipe-reply), if any. */
  quotedId: string | null;
}

/** What we need from the WhatsApp layer to talk back. */
export interface Chat {
  reply(text: string, toMessageId?: string): Promise<string | undefined>;
  react(messageId: string, emoji: string): Promise<void>;
}

interface Pending {
  promptId: string;
  sourceMessageId: string;
  senderId: string;
  senderName: string;
  source: string;
  extraction: Extraction;
  notes: string[];
  timer: NodeJS.Timeout;
}

const pendingByPrompt = new Map<string, Pending>();
const pendingBySender = new Map<string, Pending>();

// ---------- tiny persisted state (current event tag) ----------

type State = { event: string | null };
function loadState(): State {
  try {
    return JSON.parse(fs.readFileSync(config.statePath, "utf8"));
  } catch {
    return { event: null };
  }
}
const state = loadState();
setCurrentEvent(state.event);
const saveState = () => fs.writeFileSync(config.statePath, JSON.stringify(state, null, 2));

const SKIP_WORDS = /^(skip|no|none|nope|n\/a|na|nothing|-)$/i;

const HELP = `*STRATUM Lead Bot* 📇
Send any of these to the group and I'll enrich it and add it to the leads sheet:
• a photo of a business card (several cards per photo is fine)
• a shared WhatsApp contact
• a name / company / number typed out

Add a caption with context (where you met, what they need) to skip my follow-up question. Otherwise I'll ask once and wait ${Math.round(config.contextWaitMs / 1000)}s — reply to my question, or say *skip*.

Commands:
• *!event GITEX Dubai 2026* — tag new leads with this event
• *!event off* — stop tagging
• *!status* — show current settings`;

export async function handleMessage(msg: IncomingMessage, chat: Chat): Promise<void> {
  const text = msg.input.text?.trim() ?? "";
  const hasMedia = msg.input.images.length > 0 || msg.input.vcards.length > 0;

  // 1. Commands
  if (!hasMedia && text.startsWith("!")) {
    await handleCommand(text, msg, chat);
    return;
  }

  // 2. Answers to a pending "any context?" question
  if (!hasMedia) {
    const pending =
      (msg.quotedId && pendingByPrompt.get(msg.quotedId)) || pendingBySender.get(msg.senderId);
    if (pending) {
      if (!SKIP_WORDS.test(text)) {
        const by = msg.senderId === pending.senderId ? "" : ` (${msg.senderName})`;
        pending.notes.push(`${text}${by}`);
      }
      await finalize(pending, chat);
      return;
    }
    if (text.length < 3) return;
  }

  // 3. New message: does it contain a lead?
  if (hasMedia) await chat.react(msg.id, "👀");
  let extraction: Extraction;
  try {
    extraction = await extractLeads(msg.input);
  } catch (err) {
    console.error("extract failed", err);
    if (hasMedia) await chat.reply("⚠️ I couldn't read that one. Try a sharper photo or type the details.", msg.id);
    return;
  }
  if (!extraction.is_lead || extraction.leads.length === 0) {
    if (hasMedia) {
      await chat.react(msg.id, "");
      if (msg.input.images.length > 0) {
        await chat.reply("🤔 I didn't find a contact in that image. If it's a lead, add the name or number as a caption.", msg.id);
      }
    }
    return;
  }

  const source = msg.input.images.length ? "Card photo" : msg.input.vcards.length ? "Shared contact" : "Typed";
  const names = extraction.leads.map(describe).join(", ");

  // Caption already carried context → no need to ask.
  if (extraction.context_from_message) {
    await processLeads(extraction, [extraction.context_from_message], msg.senderName, source, msg.id, chat);
    return;
  }

  // If the same person already has a lead waiting, close that one out first.
  const previous = pendingBySender.get(msg.senderId);
  if (previous) await finalize(previous, chat);

  const promptId = await chat.reply(
    `📇 Got it: ${names}\nAny context? Where you met, what they need, priority, who follows up. Reply here, or say *skip* — I'll go ahead in ${Math.round(config.contextWaitMs / 1000)}s either way.`,
    msg.id,
  );
  const pending: Pending = {
    promptId: promptId ?? msg.id,
    sourceMessageId: msg.id,
    senderId: msg.senderId,
    senderName: msg.senderName,
    source,
    extraction,
    notes: [],
    timer: setTimeout(() => void finalize(pending, chat), config.contextWaitMs),
  };
  pendingByPrompt.set(pending.promptId, pending);
  pendingBySender.set(pending.senderId, pending);
  setPendingLeads(pendingByPrompt.size);
}

async function finalize(pending: Pending, chat: Chat): Promise<void> {
  // Guard against double-finalize (timer firing while a reply is being handled).
  if (pendingByPrompt.get(pending.promptId) !== pending) return;
  clearTimeout(pending.timer);
  pendingByPrompt.delete(pending.promptId);
  setPendingLeads(pendingByPrompt.size);
  if (pendingBySender.get(pending.senderId) === pending) pendingBySender.delete(pending.senderId);

  await processLeads(pending.extraction, pending.notes, pending.senderName, pending.source, pending.sourceMessageId, chat);
}

async function processLeads(
  extraction: Extraction,
  notes: string[],
  addedBy: string,
  source: string,
  sourceMessageId: string,
  chat: Chat,
): Promise<void> {
  const event = extraction.event_from_message ?? state.event;
  const teamNotes = [...notes, extraction.image_notes && `On card: ${extraction.image_notes}`]
    .filter(Boolean)
    .join("\n") || null;

  await chat.react(sourceMessageId, "⏳");
  const results = await Promise.all(
    extraction.leads.map((lead) => saveLead(lead, teamNotes, event, addedBy, source).catch((err: unknown) => {
      console.error("saveLead failed", err);
      return `⚠️ ${describe(lead)}: saved nothing — ${err instanceof Error ? err.message : "unknown error"}`;
    })),
  );
  await chat.reply(results.join("\n\n"), sourceMessageId);
  await chat.react(sourceMessageId, results.some((r) => r.startsWith("⚠️")) ? "⚠️" : "✅");
}

async function saveLead(
  lead: Lead,
  teamNotes: string | null,
  event: string | null,
  addedBy: string,
  source: string,
): Promise<string> {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");

  const dupRow = await findDuplicate(lead.emails, lead.phones);
  if (dupRow) {
    increment("duplicateLeads");
    await appendNoteToRow(dupRow, `[${stamp}] ${addedBy}${event ? ` @ ${event}` : ""}: ${teamNotes ?? "met again"}`);
    return `♻️ ${describe(lead)} is already in the sheet (row ${dupRow}) — I added your note there.\n${rowLink(dupRow)}`;
  }

  // Enrichment failing shouldn't lose the lead: save what we have from the card.
  let e: Awaited<ReturnType<typeof enrichLead>> | null = null;
  try {
    e = await enrichLead(lead, teamNotes, event);
  } catch (err) {
    console.error("enrich failed", err);
  }

  const row = await appendLead({
    "Captured At": stamp,
    "Added By": addedBy,
    Source: source,
    "Full Name": e?.full_name ?? lead.full_name ?? "",
    "Job Title": e?.job_title ?? lead.job_title ?? "",
    Company: e?.company ?? lead.company ?? "",
    Email: lead.emails.join(", "),
    Phone: lead.phones.join(", "),
    Website: e?.company_website ?? lead.website ?? "",
    "Person LinkedIn": e?.person_linkedin ?? lead.linkedin ?? "",
    "Company LinkedIn": e?.company_linkedin ?? "",
    Industry: e?.industry ?? "",
    "Company Size": e?.company_size ?? "",
    "HQ / Location": e?.hq_location ?? lead.address ?? "",
    "Company Summary": e?.company_summary ?? "",
    "Person Summary": e?.person_summary ?? "",
    "Event / Where Met": event ?? "",
    "Team Notes": [teamNotes, lead.other_details].filter(Boolean).join("\n"),
    Priority: e?.priority ?? "",
    "Priority Reason": e?.priority_reason ?? "",
    "Suggested Next Step": e?.suggested_next_step ?? "",
    "Enrichment Confidence": e?.confidence ?? "Not enriched",
    Sources: e?.sources.join("\n") ?? "",
    Status: "New",
  });

  increment("leadsSaved");
  const name = e?.full_name ?? lead.full_name ?? "Unknown";
  const role = [e?.job_title ?? lead.job_title, e?.company ?? lead.company].filter(Boolean).join(" @ ");
  const firmo = [e?.industry, e?.company_size && `${e.company_size} staff`, e?.hq_location].filter(Boolean).join(" · ");
  const icon = { Hot: "🔥", Warm: "🌤️", Cold: "❄️" }[e?.priority ?? "Cold"];
  return [
    `✅ *${name}*${role ? ` — ${role}` : ""}`,
    firmo && `🏢 ${firmo}`,
    e && `${icon} ${e.priority}: ${e.priority_reason}`,
    e && `➡️ ${e.suggested_next_step}`,
    !e && "(Saved from the card only — web enrichment failed.)",
    e?.confidence === "Low" && "⚠️ Low confidence in the web match — please double-check.",
    `📄 Row ${row ?? "?"}: ${rowLink(row)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function handleCommand(text: string, msg: IncomingMessage, chat: Chat): Promise<void> {
  const [cmd, ...rest] = text.slice(1).trim().split(/\s+/);
  const arg = rest.join(" ").trim();
  switch (cmd.toLowerCase()) {
    case "help":
      await chat.reply(HELP, msg.id);
      break;
    case "event":
      if (!arg) {
        await chat.reply(`Current event: ${state.event ?? "none"}. Set one with *!event <name>*.`, msg.id);
        break;
      }
      state.event = /^(off|clear|none)$/i.test(arg) ? null : arg;
      saveState();
      setCurrentEvent(state.event);
      audit("command.event_changed", { sender: msg.senderId, event: state.event });
      await chat.reply(state.event ? `📍 New leads will be tagged *${state.event}*.` : "📍 Event tag cleared.", msg.id);
      break;
    case "status":
      await chat.reply(
        `Event: ${state.event ?? "none"}\nWaiting for context on: ${pendingByPrompt.size} lead message(s)\nSheet: ${rowLink(null)}`,
        msg.id,
      );
      break;
  }
}

function describe(lead: Lead): string {
  const who = lead.full_name ?? lead.phones[0] ?? lead.emails[0] ?? "someone";
  return lead.company ? `*${who}* (${lead.company})` : `*${who}*`;
}
