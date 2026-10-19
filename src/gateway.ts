export interface GatewayMessage {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  createdAt: string;
}

export interface HistoryQuery {
  after?: string;
  before?: string;
  limit: number;
}

export interface GatewayEvents {
  connected(): void;
  disconnected(): void;
  reconnecting(): void;
  message(message: GatewayMessage): void;
  error(): void;
  fatal(): void;
}

/** Only this boundary talks to Discord; tests inject a fake implementation. */
export interface Gateway {
  subscribe(events: GatewayEvents): () => void;
  start(token: string): Promise<void>;
  stop(): Promise<void>;
  fetchMessages(channelId: string, query: HistoryQuery): Promise<GatewayMessage[]>;
}

export function compareIds(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}
