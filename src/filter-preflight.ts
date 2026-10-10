import fs from "node:fs";
import { config } from "./config.js";
import { assessFilterReadiness } from "./filter-readiness.js";

/** Safe, offline deployment preflight. Never connects WhatsApp or sends a CRM webhook. */
let writable = false;
try {
  fs.accessSync(config.sessionDir, fs.constants.W_OK);
  writable = true;
} catch {}
const status = assessFilterReadiness({
  filterCrmEnabled: config.features.filterCrm,
  sheetsCrmEnabled: config.features.leadCrm,
  advancedApiEnabled: config.features.advancedApi,
  groupJids: [...config.allowedGroupJids],
  reviewerJids: [...config.filterReviewerJids],
  senderJids: [...config.allowedSenderJids],
  endpoint: config.filterCrmEndpoint,
  endpointHost: config.filterCrmAllowedHost,
  secretPresent: Boolean(config.filterCrmWebhookSecret),
  secretLength: config.filterCrmWebhookSecret?.length ?? 0,
  dataWritable: writable,
  aiEnabled: config.features.aiExtraction,
  aiProviderReady: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
  autoDispatch: config.filterCrmAutoDispatch,
});
console.log(JSON.stringify({
  application: config.appName,
  mode: "offline-preflight-only",
  ...status
}, null, 2));
if (!status.readyForPairingAndTest) process.exitCode = 2;
