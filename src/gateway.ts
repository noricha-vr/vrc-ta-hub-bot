export interface GatewayAttachment {
  url: string;
  name: string;
  contentType?: string;
}

export interface GatewayMessage {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  createdAt: string;
  authorDisplayName?: string;
  sourceUrl?: string;
  attachments?: GatewayAttachment[];
}

export interface HistoryQuery {
  after?: string;
  before?: string;
  /** 指定 ID の前後を取る（再試行で 1 件を取り直す時に使う）。after / before と併用しない。 */
  around?: string;
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
