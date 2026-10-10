import type { FilterEntry } from "./filter-queue.js";

/** The bot never answers with another WhatsApp group's lead information. */
export function groupLeads(entries: FilterEntry[], groupJid: string): FilterEntry[] {
  return entries.filter((e) => e.lead.sourceGroupJid === groupJid);
}

export function findLead(
  entries: FilterEntry[],
  groupJid: string,
  subject: string,
  quotedMessageId?: string | null,
): { match: FilterEntry | null; ambiguous: boolean } {
  const scoped = groupLeads(entries, groupJid);
  const needle = subject.trim().toLowerCase();
  if (needle) {
    const byId = scoped.find((e) => e.id.toLowerCase() === needle || e.id.toLowerCase().startsWith(needle));
    if (byId) return { match: byId, ambiguous: false };
  }
  if (needle) {
    const matches = scoped.filter((e) => [e.lead.name,e.lead.company].some((v) => v.toLowerCase().includes(needle)));
    if (matches.length) return { match: matches.length === 1 ? matches[0] : null, ambiguous: matches.length > 1 };
  }
  if (quotedMessageId) {
    const matches = scoped.filter((e) => e.lead.sourceMessageId?.split(":")[0] === quotedMessageId);
    if (matches.length === 1) return { match: matches[0], ambiguous: false };
    if (matches.length > 1) return { match: null, ambiguous: true };
  }
  return { match: null, ambiguous: false };
}

export function conciseLead(entry: FilterEntry): string {
  return `• ${entry.lead.name} (${entry.lead.company || "company unknown"}) — ${entry.disposition}; ${entry.delivery}; ID ${entry.id}`;
}

function known(value: string | undefined): string {
  return value?.trim() ? value : "Not provided in captured evidence";
}

/** Grounded, deterministic lead Q&A. Never fabricates enrichment or claims of verified facts. */
export function answerLeadQuestion(entry: FilterEntry, question: string): string {
  const q = question.trim().toLowerCase();
  const heading = `*Filter CRM — ${entry.lead.name}*`;
  if (/\b(phone|number|call|email|contact info|reach)\b/.test(q)) {
    return `${heading}\nEmail: ${known(entry.lead.email)}\nPhone: ${known(entry.lead.phone)}\nSource: ${entry.source}`;
  }
  if (/\b(why|reason|related|relevant|match|qualif|score|classification)\b/.test(q)) {
    return `${heading}\nClassification: ${entry.disposition}\nRule score (not a verified sales probability): ${entry.score}\nEvidence: ${entry.reasons.join("; ")}\nApproval: ${entry.approvedBy ? "Reviewed by " + entry.approvedBy : "Not approved"}`;
  }
  if (/\b(sent|transfer|sync|seed|import|crm|approved|review|status|pending)\b/.test(q)) {
    return `${heading}\nFilter status: ${entry.disposition}\nSTRATUM delivery: ${entry.delivery}\nApproved: ${entry.approvedBy ? "Yes (" + entry.approvedBy + ")" : "No"}\n${entry.remoteRecordId ? "STRATUM record: " + entry.remoteRecordId : "No confirmed STRATUM CRM record ID."}`;
  }
  if (/\b(source|document|photo|file|where|evidence|provenance)\b/.test(q)) {
    return `${heading}\nCaptured via: ${entry.source}\nSource message: ${known(entry.lead.sourceMessageId)}\nCaptured: ${known(entry.lead.capturedAt)}\nNotes: ${known(entry.lead.notes)}`;
  }
  if (/\b(company|business|employer|work|industry)\b/.test(q)) {
    return `${heading}\nCompany: ${known(entry.lead.company)}\nContext: ${known(entry.lead.notes)}\nNo employer/industry verification beyond the supplied source.`;
  }
  return `${heading}\nCompany: ${known(entry.lead.company)}\nEmail: ${known(entry.lead.email)}\nPhone: ${known(entry.lead.phone)}\nContext: ${known(entry.lead.notes)}\nClassification: ${entry.disposition}\nDelivery: ${entry.delivery}\nEvidence: ${entry.reasons.join("; ")}\n\nI can answer about the contact, company, source, relevance, or STRATUM CRM transfer based on recorded evidence. External facts require verified enrichment.`;
}

/** Only explicit bot addressing or quotation may trigger Q&A; normal team chat stays untouched. */
export function parseConversationalQuestion(text: string): string | null {
  const input = text.trim();
  const prefixed = input.match(/^(?:@?filter[ -]?crm|@?filter|@?leadbot)\s*[:,?]\s*(.{3,500})$/i);
  if (prefixed) return prefixed[1].trim();
  return null;
}

export function splitAskArgument(raw: string): { lead: string; question: string } | null {
  const index = raw.indexOf("|");
  if (index === -1) return null;
  const lead = raw.slice(0, index).trim();
  const question = raw.slice(index + 1).trim();
  if (!lead || question.length < 3 || question.length > 500) return null;
  return { lead, question };
}

/** Only a grammatical question quoting an actual scoped lead source may trigger a bot reply. */
export function isQuotedLeadQuestion(text: string, hasQuotedLead: boolean): boolean {
  const raw = text.trim();
  return hasQuotedLead && raw.length <= 500 &&
    /^(?:what|who|why|where|when|how|is|was|has|did|can|does|which)\b/i.test(raw) && raw.endsWith("?");
}
