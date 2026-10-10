import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { classifyStratumLead, type FilterDisposition, type FilterLeadInput } from "./filter-classifier.js";

export interface FilterEntry {
  id: string;
  lead: FilterLeadInput;
  source: string;
  disposition: FilterDisposition;
  reasons: string[];
  score: number;
  classifierVersion: string;
  createdAt: string;
  approvedBy?: string;
  approvedAt?: string;
  reviewNote?: string;
  delivery: "not_eligible" | "awaiting_review" | "approved" | "sending" | "delivered" | "needs_crm_review" | "failed";
  remoteRecordId?: string;
  attempts: number;
  lastError?: string;
}
export interface FilterOptions {
  endpoint: string | null;
  allowedHost: string | null;
  secret: string | null;
  fetchFn?: typeof fetch;
}

/** Filter CRM owns staging. Only reviewer-approved STRATUM leads can leave it. */
export class FilterQueue {
  private entries: FilterEntry[] = [];
  private inFlight = new Set<string>();
  constructor(private readonly store: string, private readonly options: FilterOptions) {
    if (existsSync(store)) {
      const parsed: unknown = JSON.parse(readFileSync(store, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("Invalid Filter CRM queue");
      this.entries = parsed as FilterEntry[];
      for (const item of this.entries) {
        if (item.delivery === "sending") item.delivery = "failed"; // ambiguous ACK: retry safe via externalKey
      }
      this.persist();
    }
  }
  private persist(): void {
    const temp = this.store + "." + process.pid + ".tmp";
    writeFileSync(temp, JSON.stringify(this.entries, null, 2), { mode: 0o600 });
    renameSync(temp, this.store);
  }
  list(): FilterEntry[] { return this.entries.map((e) => ({ ...e, lead: { ...e.lead }, reasons: [...e.reasons] })); }
  get(id: string): FilterEntry {
    const found = this.entries.find((entry) => entry.id === id);
    if (!found) throw new Error("Filter lead not found");
    return found;
  }
  stage(lead: FilterLeadInput, source: string): FilterEntry {
    if (!lead.name?.trim() || !(lead.email || lead.phone)) throw new Error("Filter lead needs name, company and email/phone");
    const sourceMessageId = lead.sourceMessageId;
    if (sourceMessageId) {
      const previous = this.entries.find((e) => e.lead.sourceMessageId === sourceMessageId);
      if (previous) return previous;
    }
    const classification = classifyStratumLead(lead);
    const item: FilterEntry = {
      id: randomUUID(),
      lead: { name: lead.name.trim(), company: (lead.company ?? "").trim(), email: lead.email.trim().toLowerCase(), phone: lead.phone.trim(), notes: lead.notes.slice(0, 3000), sourceMessageId: lead.sourceMessageId, capturedAt: lead.capturedAt ?? new Date().toISOString() },
      source, ...classification,
      createdAt: new Date().toISOString(),
      delivery: classification.disposition === "UNRELATED" ? "not_eligible" : "awaiting_review",
      attempts: 0
    };
    this.entries.push(item);
    this.persist();
    return item;
  }
  decide(id: string, reviewer: string, disposition: FilterDisposition, note: string): FilterEntry {
    const item = this.get(id);
    if (item.delivery === "delivered" || item.delivery === "sending" || item.delivery === "needs_crm_review") throw new Error("Imported/in-flight lead cannot be reclassified here");
    if (!["STRATUM_RELATED", "UNRELATED", "NEEDS_REVIEW"].includes(disposition)) throw new Error("Invalid decision");
    if (!reviewer.trim() || reviewer.length > 150 || !note.trim() || note.length > 500) throw new Error("Reviewer and decision rationale required");
    item.disposition = disposition;
    item.approvedBy = disposition === "STRATUM_RELATED" ? reviewer.trim() : undefined;
    item.approvedAt = disposition === "STRATUM_RELATED" ? new Date().toISOString() : undefined;
    item.reviewNote = note.trim();
    item.reasons = [...item.reasons, "Reviewer decision: " + note.trim().slice(0, 160)];
    item.delivery = disposition === "STRATUM_RELATED" ? "approved" : disposition === "UNRELATED" ? "not_eligible" : "awaiting_review";
    item.lastError = undefined;
    this.persist();
    return item;
  }
  async dispatch(id: string): Promise<FilterEntry> {
    const item = this.get(id);
    if (item.delivery === "delivered" || item.delivery === "needs_crm_review") return item;
    if (item.disposition !== "STRATUM_RELATED" || !item.approvedAt || !item.approvedBy) throw new Error("Only reviewed STRATUM leads may be transferred");
    if (!["approved", "failed"].includes(item.delivery)) throw new Error("Lead is not dispatchable");
    if (this.inFlight.has(id)) throw new Error("Dispatch already in progress");
    const { endpoint, secret, allowedHost } = this.options;
    if (!endpoint || !secret || secret.length < 32 || !allowedHost) throw new Error("STRATUM CRM webhook not configured");
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.hostname !== allowedHost ||
      url.pathname !== "/api/integrations/filter-crm/leads" || url.search || url.hash) throw new Error("Unsafe or unapproved STRATUM CRM endpoint");

    const payload = JSON.stringify({
      version: 1, source: "wa-abn-filter-crm", tenant: "stratum",
      lead: {
        id: item.id,
        name: item.lead.name,
        company: item.lead.company,
        email: item.lead.email,
        phone: item.lead.phone,
        notes: item.lead.notes,
        ...(item.lead.sourceMessageId ? { sourceMessageId: item.lead.sourceMessageId } : {}),
        ...(item.lead.capturedAt ? { capturedAt: item.lead.capturedAt } : {}),
      },
      classification: { disposition: "STRATUM_RELATED", classifierVersion: item.classifierVersion,
        reasons: item.reasons.slice(0, 12), score: item.score, approvedBy: item.approvedBy, approvedAt: item.approvedAt }
    });
    const timestamp = String(Date.now());
    const signature = createHmac("sha256", secret).update(timestamp + "." + payload).digest("hex");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    this.inFlight.add(id);
    item.delivery = "sending";
    item.attempts++;
    this.persist();
    try {
      const response = await (this.options.fetchFn ?? fetch)(url, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { "content-type": "application/json", "x-filter-crm-timestamp": timestamp, "x-filter-crm-signature": signature },
        body: payload,
      });
      if (![200, 201, 202].includes(response.status)) throw new Error("CRM receiver returned HTTP " + response.status);
      const result = await response.json() as { status?: string; recordId?: string };
      if (result.status === "needs_review_existing" && response.status === 202) {
        item.delivery = "needs_crm_review";
      } else if (["created", "already_imported"].includes(result.status ?? "") && (response.status === 200 || response.status === 201)) {
        item.delivery = "delivered";
      } else throw new Error("Unexpected STRATUM CRM acknowledgement");
      item.remoteRecordId = result.recordId;
      item.lastError = undefined;
    } catch (error) {
      item.delivery = "failed";
      item.lastError = error instanceof Error ? error.message.slice(0, 200) : "Transfer failed";
    } finally {
      clearTimeout(timeout);
      this.persist();
      this.inFlight.delete(id);
    }
    return item;
  }
}
