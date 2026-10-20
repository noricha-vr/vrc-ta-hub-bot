import { Database } from "bun:sqlite";
import type { ReviewDecision } from "./hub-api";

export interface HubDelivery {
  draft_id: string;
  guild_id: string;
  community_id: number;
  hub_id: number | null;
  state: "queued" | "creating" | "ready" | "closed";
  attempted_hash: string;
  synced_hash: string;
  notified_hash: string;
  attempts: number;
  next_at: number;
  reason: string;
  decision: ReviewDecision | null;
  discord_id: string | null;
}

/** 送信前の記録と応答後の確定を分ける。本文や認証キーは保存しない。 */
export class HubDeliveryStore {
  private readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS hub_deliveries (
        draft_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, community_id INTEGER NOT NULL,
        hub_id INTEGER, state TEXT NOT NULL DEFAULT 'queued',
        attempted_hash TEXT NOT NULL DEFAULT '', synced_hash TEXT NOT NULL DEFAULT '',
        notified_hash TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '',
        decision TEXT, discord_id TEXT
      );
    `);
  }
  enqueue(draftId: string, guildId: string, communityId: number): void {
    this.db.query("INSERT OR IGNORE INTO hub_deliveries (draft_id, guild_id, community_id) VALUES (?, ?, ?)")
      .run(draftId, guildId, communityId);
  }
  get(id: string): HubDelivery | undefined {
    return this.db.query<HubDelivery, [string]>("SELECT * FROM hub_deliveries WHERE draft_id = ?").get(id) ?? undefined;
  }
  due(now: number): HubDelivery[] {
    return this.db.query<HubDelivery, [number]>(
      "SELECT * FROM hub_deliveries WHERE state <> 'closed' AND next_at <= ? ORDER BY rowid",
    ).all(now);
  }
  creating(id: string, hash: string): void {
    this.db.query("UPDATE hub_deliveries SET state = 'creating', attempted_hash = ? WHERE draft_id = ?").run(hash, id);
  }
  requeue(id: string): void {
    this.db.query("UPDATE hub_deliveries SET state = 'queued', attempted_hash = '' WHERE draft_id = ?").run(id);
  }
  created(id: string, hubId: number, hash: string): void {
    this.db.query(`UPDATE hub_deliveries SET state = 'ready', hub_id = ?, synced_hash = ?,
      attempts = 0, next_at = 0, reason = '' WHERE draft_id = ?`).run(hubId, hash, id);
  }
  synced(id: string, hash: string): void {
    this.db.query("UPDATE hub_deliveries SET synced_hash = ?, attempts = 0, next_at = 0, reason = '' WHERE draft_id = ?").run(hash, id);
  }
  notified(id: string, hash: string): void {
    this.db.query("UPDATE hub_deliveries SET notified_hash = ?, attempts = 0, next_at = 0, reason = '' WHERE draft_id = ?").run(hash, id);
  }
  retry(id: string, now: number, reason: string): void {
    const attempts = (this.get(id)?.attempts ?? 0) + 1;
    const delay = Math.min(300 * 2 ** Math.min(attempts - 1, 7), 21600);
    this.db.query("UPDATE hub_deliveries SET attempts = ?, next_at = ?, reason = ? WHERE draft_id = ?")
      .run(attempts, now + delay, reason, id);
  }
  queueDecision(id: string, decision: ReviewDecision, discordId: string): void {
    this.db.query("UPDATE hub_deliveries SET decision = ?, discord_id = ?, next_at = 0 WHERE draft_id = ?")
      .run(decision, discordId, id);
  }
  clearDecision(id: string): void {
    this.db.query("UPDATE hub_deliveries SET decision = NULL, discord_id = NULL, next_at = 0 WHERE draft_id = ?").run(id);
  }
  closed(id: string, reason: string): void {
    this.db.query("UPDATE hub_deliveries SET state = 'closed', reason = ?, decision = NULL, discord_id = NULL WHERE draft_id = ?")
      .run(reason, id);
  }
  counts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const row of this.db.query<{ state: string; n: number }, []>(
      "SELECT state, count(*) AS n FROM hub_deliveries GROUP BY state",
    ).all()) counts[row.state] = row.n;
    counts.retry = this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM hub_deliveries WHERE reason <> '' AND state <> 'closed'").get()!.n;
    return counts;
  }
  close(): void { this.db.close(); }
}
