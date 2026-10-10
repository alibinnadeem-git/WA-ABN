import { config } from "./config.js";
import { FilterQueue } from "./filter-queue.js";
import { FilterSourceRegistry } from "./filter-sources.js";
import type { FilterLeadInput } from "./filter-classifier.js";

const queue = config.features.filterCrm
  ? new FilterQueue(config.filterQueuePath, {
    endpoint: config.filterCrmEndpoint,
    allowedHost: config.filterCrmAllowedHost,
    secret: config.filterCrmWebhookSecret,
  })
  : null;

export function filterCrmQueue(): FilterQueue | null { return queue; }
const sources = config.features.filterCrm ? new FilterSourceRegistry(config.filterSourcesPath) : null;
export function filterSourceRegistry(): FilterSourceRegistry | null { return sources; }
export function stageFilterLead(lead: FilterLeadInput, source: string) {
  return queue?.stage(lead, source) ?? null;
}
