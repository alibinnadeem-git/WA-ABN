import type { WAMessage, WASocket } from "baileys";
import { config } from "./config.js";
import { audit } from "./audit.js";
import { filterCrmQueue, filterSourceRegistry } from "./filter-runtime.js";
import { answerLeadQuestion, conciseLead, findLead, groupLeads, parseConversationalQuestion, splitAskArgument } from "./filter-whatsapp.js";
import { sourceSummary } from "./filter-sources.js";
import type { FilterDisposition } from "./filter-classifier.js";

export interface FilterChatTurn {
  sock: WASocket;
  message: WAMessage;
  groupJid: string;
  senderJid: string;
  text: string;
  quotedMessageId: string | null;
}

function naturalSubject(question: string, names: string[]): string {
  const lowered = question.toLowerCase();
  const namesInQuestion = names.filter((n) => n.length >= 3 && lowered.includes(n.toLowerCase()));
  return namesInQuestion.length === 1 ? namesInQuestion[0] : "";
}

export async function handleFilterChat(turn: FilterChatTurn): Promise<boolean> {
  if (!config.features.filterCrm) return false;
  const queue = filterCrmQueue();
  if (!queue) return false;
  const raw = turn.text.trim();
  const [first, ...parts] = raw.split(/\s+/);
  const cmd = first?.toLowerCase() ?? "";
  const arg = parts.join(" ").trim();
  const addressed = parseConversationalQuestion(raw);
  const supported = ["!filter", "!leads", "!ask", "!review", "!dispatch", "!sendapproved", "!sources", "!source"];
  // A short question replying to a lead-source WhatsApp message is also an explicit request.
  const quotedQuestion = Boolean(turn.quotedMessageId &&
    /^(?:what|who|why|where|when|how|is|was|has|did|can|does|which)\\b/i.test(raw) && raw.endsWith("?"));
  if (!supported.includes(cmd) && addressed === null && !quotedQuestion) return false;
  const respond = async (message: string): Promise<void> => {
    await turn.sock.sendMessage(turn.groupJid, { text: message }, { quoted: turn.message });
  };
  const entries = groupLeads(queue.list(), turn.groupJid);

  if (cmd === "!filter") {
    await respond("*Filter CRM in WhatsApp*\nDrop a business card/contact with context, or use !lead Name | Company | Email | Phone | Notes.\n!leads — leads from this group\n!ask Name | question — ask about a lead\nReply to a lead message with !ask | question\nFilter: what do we know about Jane? — natural question\n!sources — source attachments in this group\n!source <ID> — recorded file/source\nReviewer-only: !review <ID> related|unrelated|review | reason; !dispatch <ID>; !sendapproved\nNo lead is sent to STRATUM CRM without explicit approval.");
    return true;
  }
  if (cmd === "!leads") {
    const latest = entries.slice(-10).reverse();
    await respond(latest.length ? "*Filter CRM — this group*\n" + latest.map(conciseLead).join("\n").slice(0,3500) : "No Filter CRM leads captured in this WhatsApp group yet.");
    return true;
  }
  if (cmd === "!sources") {
    const sources = filterSourceRegistry()?.forGroup(turn.groupJid,10) ?? [];
    await respond(sources.length ? "*Sources shared in this group*\n" + sources.map(sourceSummary).join("\n").slice(0,3500) : "No indexed sources from this WhatsApp group yet.");
    return true;
  }
  if (cmd === "!source") {
    if (!arg) { await respond("Usage: !source <ID>"); return true; }
    const source = filterSourceRegistry()?.getForGroup(arg,turn.groupJid);
    await respond(source
      ? `*Source: ${source.fileName || source.kind}*\nType: ${source.mimeType || source.kind}\nStatus: ${source.processing}\nCaption: ${source.caption || "None"}\nText extract: ${source.excerpt?.slice(0,2000) || "Not available — file may require a parser or manual review."}\nHash: ${source.contentHash || "not available"}`
      : "Source not found in this group.");
    return true;
  }

  if (cmd === "!review" || cmd === "!dispatch" || cmd === "!sendapproved") {
    // No reviewer configured = fail closed. Group membership alone is not admin authority.
    if (!config.filterReviewerJids.has(turn.senderJid)) {
      await respond("Not authorized. Only an explicitly configured Filter CRM reviewer can approve or transfer records.");
      audit("filtercrm.whatsapp_reviewer_denied", { sender: turn.senderJid, group: turn.groupJid });
      return true;
    }
    if (cmd === "!review") {
      const match = arg.match(/^([a-f0-9-]{8,36})\s+(related|unrelated|review)\s*\|\s*(.{3,500})$/i);
      if (!match) { await respond("Usage: !review <lead ID> related|unrelated|review | documented reason"); return true; }
      const target = entries.find((e) => e.id === match[1] || e.id.startsWith(match[1]));
      if (!target) { await respond("Lead not found in this group."); return true; }
      const disposition = ({related:"STRATUM_RELATED",unrelated:"UNRELATED",review:"NEEDS_REVIEW"} as const)[match[2].toLowerCase() as "related"|"unrelated"|"review"] as FilterDisposition;
      try {
        const changed = queue.decide(target.id,turn.senderJid,disposition,match[3].trim());
        audit("filtercrm.whatsapp_reviewed",{ id: changed.id, by: turn.senderJid, disposition });
        await respond(`Review saved: ${changed.lead.name} → ${changed.disposition}.\nDelivery: ${changed.delivery}. ${changed.delivery === "approved" ? "Use !dispatch <ID> or !sendapproved when all filtering is complete." : "No STRATUM transfer."}`);
      } catch (error) {
        await respond("Review rejected: " + (error instanceof Error ? error.message : "invalid request"));
      }
      return true;
    }
    if (cmd === "!dispatch") {
      const target = entries.find((e) => e.id === arg || (arg.length >= 8 && e.id.startsWith(arg)));
      if (!target) { await respond("Lead not found in this group."); return true; }
      try {
        const result = await queue.dispatch(target.id);
        audit("filtercrm.whatsapp_dispatch", { id: result.id, by: turn.senderJid, status: result.delivery });
        await respond(`STRATUM CRM transfer — ${result.lead.name}: ${result.delivery}.${result.remoteRecordId ? "\nCRM record: "+result.remoteRecordId : ""}${result.lastError ? "\nReason: "+result.lastError : ""}`);
      } catch (error) {
        await respond("Transfer not permitted: " + (error instanceof Error ? error.message : "invalid state"));
      }
      return true;
    }
    const unreviewed = entries.filter((entry) => entry.disposition === "NEEDS_REVIEW" ||
      (entry.disposition === "STRATUM_RELATED" && !entry.approvedAt));
    if (unreviewed.length > 0) {
      await respond(`Cannot send batch: ${unreviewed.length} lead(s) in this group still require review. Use !leads and !review first.`);
      return true;
    }
    const ready = entries.filter((e) => ["approved","failed"].includes(e.delivery)).slice(0,10);
    const results: string[] = [];
    for (const entry of ready) {
      const result = await queue.dispatch(entry.id);
      results.push(`${entry.lead.name}: ${result.delivery}`);
    }
    await respond(ready.length ? "Reviewed STRATUM transfers:\n" + results.join("\n") : "No new approved leads to send from this group.");
    return true;
  }

  // Only deliberately addressed questions. Normal human-to-human chat is never intercepted.
  let leadSubject = "";
  let question = "";
  if (cmd === "!ask") {
    const structured = splitAskArgument(arg);
    if (structured) { leadSubject=structured.lead;question=structured.question; }
    else if (turn.quotedMessageId) { question=arg.replace(/^\|/,"").trim(); }
    else { await respond("Usage: !ask Jane Smith | What do we know?\nOr reply to the captured lead message with: !ask | Why is this relevant?"); return true; }
  } else if (addressed !== null) {
    question = addressed;
    leadSubject = naturalSubject(addressed,entries.map((e)=>e.lead.name));
  } else if (quotedQuestion) {
    question = raw;
  }
  if (question.length < 3) { await respond("Ask a specific question about a named lead."); return true; }
  const { match, ambiguous } = findLead(entries,turn.groupJid,leadSubject,turn.quotedMessageId);
  if (!match) {
    await respond(ambiguous
      ? "Multiple leads match. Please use !leads and !ask <full Filter ID> | your question."
      : "I could not identify that lead from this group. Use !leads and !ask <name or ID> | question.");
    return true;
  }
  await respond(answerLeadQuestion(match,question));
  return true;
}
