import { timingSafeEqual } from "node:crypto";

export type ApiRole = "viewer" | "operator" | "admin";
const ranks: Record<ApiRole, number> = { viewer: 1, operator: 2, admin: 3 };

export function authenticateRole(header: string | undefined, tokens: Record<ApiRole, string>): ApiRole | null {
  if (!header?.startsWith("Bearer ")) return null;
  const supplied = Buffer.from(header.slice(7));
  for (const role of ["admin", "operator", "viewer"] as const) {
    const configured = Buffer.from(tokens[role]);
    if (configured.length > 0 && supplied.length === configured.length && timingSafeEqual(supplied, configured)) return role;
  }
  return null;
}

export function hasRole(actual: ApiRole | null, required: ApiRole): boolean {
  return actual !== null && ranks[actual] >= ranks[required];
}

export function authorizedRecipient(jid: string, groups: ReadonlySet<string>, contacts: ReadonlySet<string>): boolean {
  if (!/^[0-9A-Za-z_.:-]{3,120}@(g\.us|s\.whatsapp\.net|lid)$/.test(jid)) return false;
  return jid.endsWith("@g.us") ? groups.has(jid) : contacts.has(jid);
}

export function approvedCampaignRecipients(recipients: unknown, contacts: ReadonlySet<string>, groups: ReadonlySet<string>, max: number): string[] {
  if (!Array.isArray(recipients) || recipients.length === 0 || recipients.length > max) throw new Error("Campaign recipient count outside permitted bounds");
  const results: string[] = [];
  for (const jid of recipients) {
    if (typeof jid !== "string" || !authorizedRecipient(jid, groups, contacts)) throw new Error("Recipient not explicitly approved for this deployment");
    if (!results.includes(jid)) results.push(jid);
  }
  return results;
}

export class MessageQuota {
  private readonly recent: number[] = [];
  private readonly daily: number[] = [];
  constructor(private readonly perMinute: number, private readonly perDay: number) {}
  consume(now = Date.now()): boolean {
    while (this.recent.length && this.recent[0] <= now - 60_000) this.recent.shift();
    while (this.daily.length && this.daily[0] <= now - 86_400_000) this.daily.shift();
    if (this.recent.length >= this.perMinute || this.daily.length >= this.perDay) return false;
    this.recent.push(now);
    this.daily.push(now);
    return true;
  }
}
