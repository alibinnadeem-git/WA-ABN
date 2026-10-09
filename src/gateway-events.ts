export interface GatewayEvent {
  id: number;
  ts: string;
  type: string;
  data: Record<string, unknown>;
}
let sequence = 0;
const recent: GatewayEvent[] = [];
const listeners = new Set<(event: GatewayEvent) => void>();

/** Volatile, scoped to this vendor's process; no shared cross-tenant event broker. */
export function publishGatewayEvent(type: string, data: Record<string, unknown>): void {
  const event = { id: ++sequence, ts: new Date().toISOString(), type, data };
  recent.push(event);
  if (recent.length > 100) recent.shift();
  for (const listener of listeners) {
    try { listener(event); } catch { listeners.delete(listener); }
  }
}

export function recentGatewayEvents(limit = 50): GatewayEvent[] {
  return recent.slice(-Math.max(1, Math.min(100, limit)));
}

export function subscribeGatewayEvents(listener: (event: GatewayEvent) => void): () => void {
  if (listeners.size >= 50) throw new Error("Too many event subscribers");
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
