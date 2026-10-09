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
  pairingState: "idle" as "idle" | "required" | "code-issued",
  groups: {} as Record<string, { subject: string; participants: number; admins: number }>,
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

export function setPairingState(state: "idle" | "required" | "code-issued"): void {
  runtime.pairingState = state;
}

export function setGroupInfo(jid: string, info: { subject: string; participants: number; admins: number }): void {
  runtime.groups[jid] = info;
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
    "# HELP messaging_up Whether the WA-ABN process is running.",
    "# TYPE messaging_up gauge",
    "messaging_up 1",
    "# HELP messaging_whatsapp_connected Whether WhatsApp is connected.",
    "# TYPE messaging_whatsapp_connected gauge",
    `messaging_whatsapp_connected ${snap.connection === "connected" ? 1 : 0}`,
    "# HELP messaging_uptime_seconds Process uptime in seconds.",
    "# TYPE messaging_uptime_seconds gauge",
    `messaging_uptime_seconds ${snap.uptimeSeconds}`,
    "# HELP messaging_pending_leads Leads waiting for context.",
    "# TYPE messaging_pending_leads gauge",
    `messaging_pending_leads ${snap.pendingLeads}`,
  ];
  for (const [name, value] of Object.entries(snap.counters)) {
    const metric = name.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    lines.push(`# TYPE messaging_${metric}_total counter`, `messaging_${metric}_total ${value}`);
  }
  return lines.join("\n") + "\n";
}
