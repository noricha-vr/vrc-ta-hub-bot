import type { Gateway, GatewayMessage, HistoryQuery } from "./gateway";
import { compareIds } from "./gateway";
import { type Health, writeHealth } from "./health";
import type { MessageStore } from "./store";

interface BotOptions {
  channelIds: string[];
  healthPath: string;
  heartbeatMs?: number;
  now?: () => Date;
  log?: (event: string) => void;
  onFatal?: () => void;
}

export class HubBot {
  private readonly selected: Set<string>;
  private readonly pending: Set<string>;
  private readonly now: () => Date;
  private readonly health: Health;
  private connected = false;
  private hasConnected = false;
  private stopped = false;
  private epoch = 0;
  private active: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly gateway: Gateway, private readonly store: MessageStore, private readonly options: BotOptions) {
    if (options.channelIds.length === 0) throw new Error("At least one channel must be selected");
    this.selected = new Set(options.channelIds);
    this.pending = new Set(this.selected);
    this.now = options.now ?? (() => new Date());
    const startedAt = this.now().toISOString();
    this.health = {
      startedAt, updatedAt: startedAt, lastReceivedAt: null,
      connectionState: "connecting", reconnectCount: 0, recoveredMessageCount: 0,
      pendingChannelCount: this.pending.size, lastSuccessfulSyncAt: null, lastErrorAt: null,
    };
  }

  async start(token: string): Promise<void> {
    if (this.unsubscribe || this.stopped) throw new Error("Bot cannot be started twice");
    this.unsubscribe = this.gateway.subscribe({
      connected: () => {
        if (this.stopped || this.connected) return;
        if (this.hasConnected) this.health.reconnectCount++;
        this.hasConnected = true;
        this.connected = true;
        this.epoch++;
        this.health.connectionState = "connected";
        this.publish();
        void this.reconcile();
      },
      disconnected: () => this.offline("disconnected"),
      reconnecting: () => this.offline("reconnecting"),
      message: message => this.receive(message),
      error: () => this.recordError("gateway_error"),
      fatal: () => {
        this.offline("error");
        this.recordError("gateway_fatal");
        this.options.onFatal?.();
      },
    });
    this.publish();
    this.timer = setInterval(() => {
      this.publish();
      void this.reconcile();
    }, this.options.heartbeatMs ?? 5000);
    try {
      await this.gateway.start(token);
    } catch {
      this.offline("error");
      this.recordError("gateway_start_failed");
      // Do not retry login on the same client: destroy any surviving shard first.
      await this.stop(true);
      throw new Error("Gateway startup failed");
    }
  }

  private offline(state: "disconnected" | "reconnecting" | "error"): void {
    if (this.stopped) return;
    this.connected = false;
    this.epoch++;
    for (const channelId of this.selected) this.pending.add(channelId);
    this.health.connectionState = state;
    this.publish();
  }

  private receive(message: GatewayMessage): void {
    if (this.stopped || !this.selected.has(message.channelId)) return;
    this.health.lastReceivedAt = this.now().toISOString();
    try {
      this.store.save(message, this.connected && !this.pending.has(message.channelId));
    } catch {
      this.pending.add(message.channelId);
      this.recordError("message_store_failed");
    }
    this.publish();
  }

  /** Also used by the periodic retry; overlapping ready/resume events are coalesced. */
  reconcile(): Promise<void> {
    if (this.active) return this.active;
    if (!this.connected || this.stopped || this.pending.size === 0) return Promise.resolve();
    const epoch = this.epoch;
    this.active = this.reconcileChannels(epoch).finally(() => {
      this.active = null;
      if (!this.stopped && this.connected && epoch !== this.epoch) void this.reconcile();
    });
    return this.active;
  }

  private current(epoch: number): boolean {
    return !this.stopped && this.connected && this.epoch === epoch;
  }

  private async reconcileChannels(epoch: number): Promise<void> {
    for (const channelId of [...this.pending]) {
      if (!this.current(epoch)) break;
      try {
        await this.recoverChannel(channelId, epoch);
      } catch {
        this.recordError("history_recovery_failed");
      }
    }
    if (this.current(epoch) && this.pending.size === 0) {
      this.health.lastSuccessfulSyncAt = this.now().toISOString();
    }
    this.publish();
  }

  private async recoverChannel(channelId: string, epoch: number): Promise<void> {
    const baseline = this.store.cursor(channelId);
    let highWater = baseline;
    let before: string | undefined;
    while (this.current(epoch)) {
      // Start with the latest page and walk backwards to the saved cursor.
      // This does not depend on which end of the range an `after` query selects.
      const query: HistoryQuery = before === undefined
        ? { limit: 100 }
        : { before, limit: 100 };
      const page = await this.gateway.fetchMessages(channelId, query);
      if (!this.current(epoch)) return;
      if (page.some(message => message.channelId !== channelId)) {
        throw new Error("History channel mismatch");
      }
      page.sort((a, b) => compareIds(a.id, b.id));
      if (page.length === 0) break;
      const oldest = page[0]!.id;
      if (before !== undefined && compareIds(oldest, before) >= 0) {
        throw new Error("History pagination made no progress");
      }
      for (const message of page) {
        if (compareIds(message.id, baseline) <= 0) continue;
        if (this.store.save(message)) this.health.recoveredMessageCount++;
        if (compareIds(message.id, highWater) > 0) highWater = message.id;
        this.health.lastReceivedAt = this.now().toISOString();
      }
      this.publish();
      if (compareIds(oldest, baseline) <= 0) break;
      before = oldest;
    }
    if (!this.current(epoch)) return;
    // Commit only after the entire gap has been durably saved. Partial scans and
    // live events during recovery cannot acknowledge unseen older messages.
    this.store.advance(channelId, highWater);
    this.pending.delete(channelId);
  }

  private recordError(event: string): void {
    this.health.lastErrorAt = this.now().toISOString();
    this.options.log?.(event);
    this.publish();
  }

  private publish(): void {
    this.health.updatedAt = this.now().toISOString();
    this.health.pendingChannelCount = this.pending.size;
    try {
      writeHealth(this.options.healthPath, this.health);
    } catch {
      // A monitor will see a stale file. Do not halt message ingestion for this.
      this.options.log?.("health_write_failed");
    }
  }

  async stop(failed = false): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.connected = false;
    this.epoch++;
    clearInterval(this.timer);
    this.unsubscribe?.();
    try {
      await this.gateway.stop();
    } finally {
      this.health.connectionState = failed ? "error" : "stopped";
      this.publish();
    }
  }
}
