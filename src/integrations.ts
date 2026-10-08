import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { config } from "./config.js";
import { audit } from "./audit.js";

function isPrivateIp(address: string): boolean {
  if (address === "::1" || address.startsWith("fe80:") || address.startsWith("fc") || address.startsWith("fd")) return true;
  if (!isIP(address)) return true;
  if (address.startsWith("127.") || address.startsWith("10.") || address.startsWith("169.254.") || address.startsWith("192.168.")) return true;
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
}

async function validateWebhook(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("Outbound webhook must use HTTPS");
  if (config.webhookAllowedHosts.size > 0 && !config.webhookAllowedHosts.has(url.hostname)) {
    throw new Error("Webhook host is not allowlisted");
  }
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error("Webhook resolves to a private or unsafe address");
  }
  return url;
}

export async function emitIntegrationEvent(type: string, payload: Record<string, unknown>): Promise<void> {
  if (!config.features.webhooks || !config.outboundWebhookUrl) return;
  const url = await validateWebhook(config.outboundWebhookUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(config.outboundWebhookToken ? { authorization: `Bearer ${config.outboundWebhookToken}` } : {}),
      },
      body: JSON.stringify({
        event: type,
        appId: config.appId,
        sessionId: config.sessionId,
        ts: new Date().toISOString(),
        payload,
      }),
    });
    if (!res.ok) throw new Error(`Webhook HTTP ${res.status}`);
    audit("integration.webhook_sent", { event: type, host: url.hostname });
  } finally {
    clearTimeout(timer);
  }
}
