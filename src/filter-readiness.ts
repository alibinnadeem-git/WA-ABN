import { URL } from "node:url";

export interface FilterCheck {
  id: string;
  status: "pass" | "blocker" | "warning";
  detail: string;
}
export interface FilterReadiness {
  readyForPairingAndTest: boolean;
  checks: FilterCheck[];
}
export interface FilterReadinessInput {
  filterCrmEnabled: boolean;
  sheetsCrmEnabled: boolean;
  advancedApiEnabled: boolean;
  groupJids: string[];
  reviewerJids: string[];
  senderJids: string[];
  endpoint: string | null;
  endpointHost: string | null;
  secretPresent: boolean;
  secretLength: number;
  dataWritable: boolean;
  aiEnabled: boolean;
  aiProviderReady: boolean;
  autoDispatch: boolean;
}

/** Never accepts or returns secret values; no network call and no WhatsApp pairing. */
export function assessFilterReadiness(input: FilterReadinessInput): FilterReadiness {
  const checks: FilterCheck[] = [];
  const add = (id: string, condition: boolean, detail: string) =>
    checks.push({ id, status: condition ? "pass" : "blocker", detail });
  add("standalone-filter", input.filterCrmEnabled && !input.sheetsCrmEnabled,
    "Standalone Podium CRM enabled without an additional Google Sheets CRM");
  add("private-reviewer-api", input.advancedApiEnabled,
    "Separate administrator API enabled (loopback-bound credentials validated at startup)");
  add("approved-whatsapp-groups",
    input.groupJids.length > 0 && input.groupJids.every((jid) => /^\d+(?:-\d+)?@g\.us$/.test(jid)),
    "At least one authentic approved WhatsApp group JID is required");
  add("reviewer-jids", input.reviewerJids.length > 0 &&
    input.reviewerJids.every((jid) => jid.includes("@")) &&
    (input.senderJids.length === 0 || input.reviewerJids.every((jid) => input.senderJids.includes(jid))),
    "At least one explicitly authorized reviewer JID must be allowed to participate");
  let endpointValid = false;
  try {
    if (input.endpoint && input.endpointHost) {
      const url = new URL(input.endpoint);
      endpointValid = url.protocol === "https:" && url.hostname === input.endpointHost &&
        url.pathname === "/api/integrations/filter-crm/leads" && !url.username && !url.password &&
        !url.search && !url.hash && !url.port;
    }
  } catch {}
  add("signed-crm-destination", endpointValid,
    "Exact STRATUM CRM HTTPS destination and allowlisted hostname must be configured");
  add("shared-hmac-credential", input.secretPresent && input.secretLength >= 32,
    "Receiver/sender matching private HMAC secret must be provisioned (no value printed)");
  add("persistent-storage", input.dataWritable,
    "Podium CRM state directory must be writable on a dedicated persistent volume");
  if (input.aiEnabled) add("ai-provider", input.aiProviderReady,
    "AI extraction enabled; private provider credential must be available");
  if (input.autoDispatch) checks.push({
    id: "pilot-dispatch-mode", status: "warning",
    detail: "Review-triggered automatic sends enabled. Keep OFF for the first test pilot.",
  });
  return { readyForPairingAndTest: !checks.some((c) => c.status === "blocker"), checks };
}
