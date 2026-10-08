export type ConnectionState = "starting" | "connected" | "disconnected";

const counters = {
  messagesSeen: 0,
  messagesProcessed: 0,
  senderRejected: 0,
  rateLimited: 0,
  mediaRejected: 0,
  handlerErrors: 0,
  leadsSaved: 0,
  duplicateLeads: 0,
};

const runtime = {
  startedAt: new Date().toISOString(),
  connection: "starting" as ConnectionState,
  connectionChangedAt: new Date().toISOString(),
  currentEvent: null as string | null,
  pendingLeads: 0,
};

export type CounterName = keyof typeof counters;

export function increment(name: CounterName, amount = 1): void {
  counters[name] += amount;
}

export function setConnection(connection: ConnectionState): void {
  runtime.connection = connection;
  runtime.connectionChangedAt = new Date().toISOString();
}

export function setCurrentEvent(event: string | null): void {
  runtime.currentEvent = event;
}

export function setPendingLeads(count: number): void {
  runtime.pendingLeads = Math.max(0, count);
}

export function opsSnapshot() {
  const started = Date.parse(runtime.startedAt);
  return {
    ...runtime,
    uptimeSeconds: Number.isFinite(started) ? Math.floor((Date.now() - started) / 1000) : 0,
    counters: { ...counters },
  };
}

export function prometheusMetrics(): string {
  const snap = opsSnapshot();
  const lines = [
    "# HELP wa_abn_up Whether the WA-ABN process is running.",
    "# TYPE wa_abn_up gauge",
    "wa_abn_up 1",
    "# HELP wa_abn_whatsapp_connected Whether WhatsApp is connected.",
    "# TYPE wa_abn_whatsapp_connected gauge",
    `wa_abn_whatsapp_connected ${snap.connection === "connected" ? 1 : 0}`,
    "# HELP wa_abn_uptime_seconds Process uptime in seconds.",
    "# TYPE wa_abn_uptime_seconds gauge",
    `wa_abn_uptime_seconds ${snap.uptimeSeconds}`,
    "# HELP wa_abn_pending_leads Leads waiting for context.",
    "# TYPE wa_abn_pending_leads gauge",
    `wa_abn_pending_leads ${snap.pendingLeads}`,
  ];
  for (const [name, value] of Object.entries(snap.counters)) {
    const metric = name.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    lines.push(`# TYPE wa_abn_${metric}_total counter`, `wa_abn_${metric}_total ${value}`);
  }
  return lines.join("\n") + "\n";
}
