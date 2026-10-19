import { compareIds, type Gateway, type GatewayEvents, type GatewayMessage, type HistoryQuery } from "../src/gateway";

export function message(id: string | number, channelId = "10"): GatewayMessage {
  return { id: String(id), channelId, authorId: "20", content: `message ${id}`, createdAt: "2026-01-01T00:00:00.000Z" };
}

export class FakeGateway implements Gateway {
  events: GatewayEvents | undefined;
  history: GatewayMessage[] = [];
  queries: Array<{ channelId: string; query: HistoryQuery }> = [];
  stopped = false;
  failStart = false;
  beforeFetch?: (channelId: string, query: HistoryQuery) => Promise<void>;

  subscribe(events: GatewayEvents): () => void {
    this.events = events;
    return () => { this.events = undefined; };
  }

  async start(): Promise<void> {
    if (this.failStart) throw new Error("startup failure with sensitive detail");
    this.events?.connected();
  }

  async stop(): Promise<void> { this.stopped = true; }

  async fetchMessages(channelId: string, query: HistoryQuery): Promise<GatewayMessage[]> {
    this.queries.push({ channelId, query });
    await this.beforeFetch?.(channelId, query);
    if (query.around !== undefined) return this.history.filter(item => item.channelId === channelId && item.id === query.around);
    return this.history.filter(item => item.channelId === channelId
      && (query.after === undefined || compareIds(item.id, query.after) > 0)
      && (query.before === undefined || compareIds(item.id, query.before) < 0))
      .sort((a, b) => compareIds(b.id, a.id)).slice(0, query.limit);
  }
}
