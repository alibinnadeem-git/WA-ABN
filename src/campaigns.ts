import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { approvedCampaignRecipients, MessageQuota } from "./gateway-policy.js";

export type CampaignStatus = "draft" | "approved" | "running" | "paused" | "completed" | "cancelled";
export interface Campaign {
  id: string;
  name: string;
  purpose: string;
  message: string;
  recipients: string[];
  status: CampaignStatus;
  createdAt: string;
  approvedAt?: string;
  cursor: number;
  sent: string[];
  error?: string;
  nextSendAt?: number;
}
export interface CampaignOptions {
  contacts: ReadonlySet<string>;
  groups: ReadonlySet<string>;
  maxRecipients: number;
  intervalMs: number;
  quota: MessageQuota;
  send: (jid: string, text: string) => Promise<void>;
  audit: (name: string, data: Record<string, string | number>) => void;
}

/** A per-vendor opt-in queue; every customer deployment has its own storage path. */
export class CampaignManager {
  private campaigns: Campaign[] = [];
  private busy = false;
  constructor(private readonly file: string, private readonly options: CampaignOptions) {
    if (existsSync(file)) {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("Invalid campaign queue; refusing to run");
      this.campaigns = parsed as Campaign[];
      // A crash during a send must not replay an uncertain delivery automatically.
      for (const c of this.campaigns) {
        if (c.status === "running") {
          c.status = "paused";
          c.error = "Interrupted send; review delivery before resuming";
        }
      }
      this.persist();
    }
  }
  private persist(): void {
    const temp = this.file + "." + process.pid + ".tmp";
    try {
      writeFileSync(temp, JSON.stringify(this.campaigns, null, 2), { mode: 0o600, flag: "w" });
      renameSync(temp, this.file);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
  list(): Campaign[] { return this.campaigns.map((c) => ({ ...c, recipients: [...c.recipients], sent: [...c.sent] })); }
  get(id: string): Campaign {
    const c = this.campaigns.find((x) => x.id === id);
    if (!c) throw new Error("Campaign not found");
    return c;
  }
  create(input: { name: string; purpose: string; text: string; recipients: unknown; consentAttested: boolean }): Campaign {
    if (!input.consentAttested) throw new Error("Recipient opt-in must be attested");
    if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 120) throw new Error("Invalid campaign name");
    if (typeof input.purpose !== "string" || !input.purpose.trim() || input.purpose.length > 200) throw new Error("Campaign purpose is required");
    if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 4000) throw new Error("Invalid campaign message");
    const recipients = approvedCampaignRecipients(input.recipients, this.options.contacts, this.options.groups, this.options.maxRecipients);
    const item: Campaign = {
      id: randomUUID(), name: input.name.trim(), purpose: input.purpose.trim(), message: input.text,
      recipients, status: "draft", createdAt: new Date().toISOString(), cursor: 0, sent: [],
    };
    this.campaigns.push(item);
    this.persist();
    this.options.audit("campaign.created", { id: item.id, count: recipients.length });
    return item;
  }
  approve(id: string): Campaign {
    const c = this.get(id);
    if (c.status !== "draft") throw new Error("Only draft campaigns can be approved");
    c.status = "approved";
    c.approvedAt = new Date().toISOString();
    this.persist();
    this.options.audit("campaign.approved", { id });
    return c;
  }
  pause(id: string): Campaign {
    const c = this.get(id);
    if (!["approved", "running"].includes(c.status)) throw new Error("Campaign cannot be paused");
    c.status = "paused";
    this.persist();
    this.options.audit("campaign.paused", { id });
    return c;
  }
  resume(id: string): Campaign {
    const c = this.get(id);
    if (c.status !== "paused") throw new Error("Only paused campaigns can be resumed");
    c.status = "approved";
    c.error = undefined;
    c.nextSendAt = undefined;
    this.persist();
    this.options.audit("campaign.resumed", { id });
    return c;
  }
  cancel(id: string): Campaign {
    const c = this.get(id);
    if (c.status === "completed" || c.status === "cancelled") throw new Error("Campaign is already finalized");
    c.status = "cancelled";
    this.persist();
    this.options.audit("campaign.cancelled", { id });
    return c;
  }
  async tick(now = Date.now()): Promise<void> {
    if (this.busy) return;
    const c = this.campaigns.find((item) => ["approved","running"].includes(item.status) && (item.nextSendAt ?? 0) <= now);
    if (!c) return;
    if (c.cursor >= c.recipients.length) {
      c.status = "completed";
      this.persist();
      return;
    }
    const jid = c.recipients[c.cursor];
    if (!this.options.groups.has(jid) && !this.options.contacts.has(jid)) {
      c.status = "paused"; c.error = "Recipient removed from allowlist";
      this.persist();
      return;
    }
    if (!this.options.quota.consume(now)) return;
    this.busy = true;
    try {
      c.status = "running";
      this.persist(); // a process crash here causes pause-on-restart, not automatic retry
      await this.options.send(jid, c.message);
      c.sent.push(jid);
      c.cursor += 1;
      c.nextSendAt = now + this.options.intervalMs;
      c.status = c.cursor === c.recipients.length ? "completed" : "approved";
      this.options.audit("campaign.message_sent", { id: c.id, index: c.cursor });
      this.persist();
    } catch (error) {
      c.status = "paused";
      c.error = error instanceof Error ? error.message.slice(0, 250) : "unknown send failure";
      this.persist();
      this.options.audit("campaign.send_paused", { id: c.id, index: c.cursor });
    } finally {
      this.busy = false;
    }
  }
}
