import type { HubSetup, HubInteraction } from "./hub-setup";
import type { Gateway, GatewayMessage } from "./gateway";
import { compareIds } from "./gateway";
import { type Health, writeHealth } from "./health";
import type { MessageStore } from "./store";
import type { HubReviewStats } from "./hub-delivery-store";
import type { ReviewNotificationRejections } from "./extraction-store";

const HISTORY_PAGE_SIZE = 100;
const HISTORY_PAGES_PER_CHANNEL = 20;

interface BotOptions {
  channelIds: string[] | (() => string[]);
  baseline?: (channelId: string) => string;
  hub?: HubSetup;
  work?: { run(channelReady: (channelId: string) => boolean): Promise<void>; review: {
    handle(interaction: HubInteraction): Promise<void>;
    pendingReviews?(): HubReviewStats;
    pendingPostReviews?(): number;
    unknownPostReviewNotifications?(): number;
    rejectedPostReviewNotifications?(): ReviewNotificationRejections;
  } };
  healthPath: string;
  envFilePath?: string;
  hubHost?: string;
  heartbeatMs?: number;
  now?: () => Date;
  log?: (event: string) => void;
  onFatal?: () => void;
}

export class HubBot {
  private readonly selected: Set<string>;
  private readonly pending: Set<string>;
  /** チャンネルごとの保存失敗の世代。取り直し中に増えたら、その取り直しでは完了にしない。 */
  private readonly failures = new Map<string, number>();
  private readonly now: () => Date;
  private readonly health: Health;
  private connected = false;
  private hasConnected = false;
  private stopped = false;
  private epoch = 0;
  private active: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private workTask: Promise<void> | undefined;
  private readonly interactions = new Set<Promise<void>>();
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly gateway: Gateway, private readonly store: MessageStore, private readonly options: BotOptions) {
    this.selected = new Set(typeof options.channelIds === "function" ? options.channelIds() : options.channelIds);
    this.pending = new Set(this.selected);
    this.now = options.now ?? (() => new Date());
    const startedAt = this.now().toISOString();
    this.health = {
      envFilePath: options.envFilePath ?? null, hubHost: options.hubHost ?? null,
      startedAt, updatedAt: startedAt, lastReceivedAt: null,
      connectionState: "connecting", reconnectCount: 0, recoveredMessageCount: 0,
      pendingChannelCount: this.pending.size, lastSuccessfulSyncAt: null, lastErrorAt: null,
      pendingReviewCount: 0, pendingPostReviewCount: 0, unknownPostReviewNotificationCount: 0, oldestPendingReviewAgeSeconds: 0,
      rejectedPostReviewNotificationCount: 0, rejectedPostReviewNotificationTargets: [],
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
      interaction: interaction => {
        if (this.stopped) return;
        const handler = interaction.action.startsWith("hub-review:") ? this.options.work?.review : this.options.hub;
        if (!handler) return;
        const task = handler.handle(interaction).catch(() => this.recordError("hub_interaction_failed"));
        this.interactions.add(task);
        void task.finally(() => this.interactions.delete(task));
      },
      guildDelete: guildId => {
        try { this.options.hub?.guildDeleted(guildId); }
        catch { this.recordError("hub_guild_delete_failed"); }
      },
      guildsReady: guildIds => {
        try { this.options.hub?.guildsReady(guildIds); }
        catch { this.recordError("hub_guild_reconcile_failed"); throw new Error("Guild reconciliation failed"); }
      },
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
      this.processWork();
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

  /** Refresh synchronously after a settings transaction, invalidating in-flight history. */
  refreshChannels(): void {
    const next = new Set(typeof this.options.channelIds === "function" ? this.options.channelIds() : this.options.channelIds);
    this.epoch++;
    for (const id of this.selected) if (!next.has(id)) {
      this.selected.delete(id); this.pending.delete(id); this.failures.delete(id);
    }
    // Resuming a setting can lower a shared channel's effective cursor.
    for (const id of next) {
      this.selected.add(id); this.pending.add(id);
    }
    this.publish();
    void this.reconcile();
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
    if (compareIds(message.id, this.options.baseline?.(message.channelId) ?? "0") <= 0) return;
    this.health.lastReceivedAt = this.now().toISOString();
    try {
      this.store.save(message, this.connected && !this.pending.has(message.channelId));
    } catch {
      this.pending.add(message.channelId);
      this.failures.set(message.channelId, this.failureGeneration(message.channelId) + 1);
      this.recordError("message_store_failed");
    }
    this.publish();
    this.processWork();
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
    this.processWork();
  }

  private processWork(): void {
    if (!this.connected || this.stopped || this.workTask || !this.options.work) return;
    this.workTask = this.options.work.run(channelId => this.connected && !this.stopped
      && this.selected.has(channelId) && !this.pending.has(channelId)).catch(() => this.recordError("hub_pipeline_failed"))
      .finally(() => { this.workTask = undefined; });
  }

  private failureGeneration(channelId: string): number {
    return this.failures.get(channelId) ?? 0;
  }

  private async recoverChannel(channelId: string, epoch: number): Promise<void> {
    const failuresAtStart = this.failureGeneration(channelId);
    const cursor = this.store.cursor(channelId);
    const floor = this.options.baseline?.(channelId) ?? "0";
    const baseline = compareIds(cursor, floor) >= 0 ? cursor : floor;
    let highWater = baseline;
    let after = baseline;
    let exhausted = false;
    let pages = 0;
    while (this.current(epoch) && pages < HISTORY_PAGES_PER_CHANNEL) {
      const page: GatewayMessage[] = await this.gateway.fetchMessages(channelId, { after, limit: HISTORY_PAGE_SIZE });
      pages++;
      if (!this.current(epoch)) return;
      if (page.some(message => message.channelId !== channelId)) throw new Error("History page outside requested channel");
      page.sort((a, b) => compareIds(a.id, b.id));
      if (page.length === 0) { exhausted = true; break; }

      // Ignore anything at or before the setup/cursor boundary. Sorting makes
      // page advancement independent of the order returned by the API.
      const fresh = page.filter(message => compareIds(message.id, baseline) > 0 && compareIds(message.id, after) > 0);
      for (const message of fresh) {
        if (this.store.save(message)) this.health.recoveredMessageCount++;
        this.health.lastReceivedAt = this.now().toISOString();
      }
      this.publish();

      const pageHigh = fresh.at(-1)?.id;
      if (pageHigh && compareIds(pageHigh, highWater) > 0) highWater = pageHigh;
      if (page.length < HISTORY_PAGE_SIZE) { exhausted = true; break; }
      if (!pageHigh || compareIds(pageHigh, after) <= 0) throw new Error("History page did not advance");
      after = pageHigh;
    }
    if (!this.current(epoch)) return;
    // A live save failed while scanning; that message may be newer than our scan.
    // Keep the channel pending so the next reconcile re-reads it.
    if (this.failureGeneration(channelId) !== failuresAtStart) return;
    // Each after page is saved before advancing. A full 20-page batch can commit
    // its scanned prefix and leave the channel pending for the next heartbeat.
    this.store.advance(channelId, highWater);
    if (exhausted) this.pending.delete(channelId);
    else this.options.log?.("history_recovery_page_limit");
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
      const reviews = this.options.work?.review.pendingReviews?.();
      this.health.pendingReviewCount = reviews?.count ?? 0;
      this.health.pendingPostReviewCount = this.options.work?.review.pendingPostReviews?.() ?? 0;
      this.health.unknownPostReviewNotificationCount = this.options.work?.review.unknownPostReviewNotifications?.() ?? 0;
      const rejected = this.options.work?.review.rejectedPostReviewNotifications?.();
      this.health.rejectedPostReviewNotificationCount = rejected?.count ?? 0;
      this.health.rejectedPostReviewNotificationTargets = rejected?.targets ?? [];
      this.health.oldestPendingReviewAgeSeconds = reviews?.oldestAgeSeconds ?? 0;
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
      await Promise.allSettled([this.active, this.workTask, ...this.interactions]);
      await this.gateway.stop();
    } finally {
      this.health.connectionState = failed ? "error" : "stopped";
      this.publish();
    }
  }
}
