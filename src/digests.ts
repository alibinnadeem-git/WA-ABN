import { config } from "./config.js";
import { opsSnapshot } from "./ops.js";
import { followupAging, leadSummary, pipelineSummary } from "./sheets.js";

export async function buildDigest(): Promise<string> {
  const s = opsSnapshot();
  const lines = [
    `*${config.appName} Digest*`,
    `Session: ${config.sessionId}`,
    `WhatsApp: ${s.connection}`,
    `Processed: ${s.counters.messagesProcessed}`,
    `Rejected: ${s.counters.senderRejected}`,
    `Rate limited: ${s.counters.rateLimited}`,
  ];
  if (config.features.leadCrm) {
    const leads = await leadSummary();
    lines.push(`Leads: ${leads.total} · Hot ${leads.hot} · Warm ${leads.warm} · Cold ${leads.cold} · New ${leads.new}`);
    if (config.features.pipeline) {
      const pipeline = await pipelineSummary();
      const pipelineText = Object.entries(pipeline).map(([stage,count]) => `${stage} ${count}`).join(" · ");
      if (pipelineText) lines.push(`Pipeline: ${pipelineText}`);
      const aging = await followupAging();
      lines.push(`Follow-ups: overdue ${aging.overdue} · today ${aging.today} · upcoming ${aging.upcoming} · none ${aging.noDue}`);
    }
  }
  return lines.join("\n");
}

// Reconnects replace the transport callback without registering duplicate intervals.
let activeSender: ((jid: string, text: string) => Promise<void>) | null = null;
let digestTimer: NodeJS.Timeout | null = null;

export function startAutoDigest(send: (jid: string, text: string) => Promise<void>): void {
  activeSender = send;
  if (!config.features.digests || config.autoDigestEveryHours <= 0 || config.allowedGroupJids.size === 0) return;
  if (digestTimer) return;
  const intervalMs = config.autoDigestEveryHours * 3_600_000;
  digestTimer = setInterval(() => {
    void (async () => {
      try {
        const message = await buildDigest();
        for (const jid of config.allowedGroupJids) {
          await activeSender?.(jid, message).catch((error) => console.error("Automatic digest failed", error));
        }
      } catch (error) {
        console.error("Automatic digest construction failed", error);
      }
    })();
  }, intervalMs);
}
