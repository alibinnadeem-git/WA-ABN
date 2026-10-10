import { config } from "./config.js";
import { FilterQueue } from "./filter-queue.js";
import type { FilterLeadInput } from "./filter-classifier.js";

const queue = config.features.filterCrm
  ? new FilterQueue(config.filterQueuePath, {
    endpoint: config.filterCrmEndpoint,
    allowedHost: config.filterCrmAllowedHost,
    secret: config.filterCrmWebhookSecret,
  })
  : null;

export function filterCrmQueue(): FilterQueue | null { return queue; }
export function stageFilterLead(lead: FilterLeadInput, source: string) {
  return queue?.stage(lead, source) ?? null;
}
