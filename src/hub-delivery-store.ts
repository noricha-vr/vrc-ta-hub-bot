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
}

export interface HubReviewDecision {
  draft_id: string;
  discord_id: string;
  decision: ReviewDecision;
  attempts: number;
  next_at: number;
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
      CREATE TABLE IF NOT EXISTS hub_review_decisions (
        draft_id TEXT NOT NULL, discord_id TEXT NOT NULL, decision TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (draft_id, discord_id)
      );
    `);
    // 旧形式の保留と再送時刻を、取り込み済みの行を上書きせずに移す。
    this.db.transaction(() => {
      this.db.exec(`
        INSERT OR IGNORE INTO hub_review_decisions (draft_id, discord_id, decision, attempts, next_at)
          SELECT draft_id, discord_id, decision, attempts, next_at FROM hub_deliveries
          WHERE state <> 'closed' AND decision IS NOT NULL AND discord_id IS NOT NULL;
        UPDATE hub_deliveries SET decision = NULL, discord_id = NULL, attempts = 0, next_at = 0, reason = ''
          WHERE state <> 'closed' AND decision IS NOT NULL AND discord_id IS NOT NULL;
      `);
    })();
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
    this.db.query(`INSERT INTO hub_review_decisions (draft_id, discord_id, decision) VALUES (?, ?, ?)
      ON CONFLICT (draft_id, discord_id) DO UPDATE SET decision = excluded.decision`).run(id, discordId, decision);
  }
  decision(id: string, discordId: string): HubReviewDecision | undefined {
    return this.db.query<HubReviewDecision, [string, string]>(
      "SELECT * FROM hub_review_decisions WHERE draft_id = ? AND discord_id = ?",
    ).get(id, discordId) ?? undefined;
  }
  decisions(id: string): HubReviewDecision[] {
    return this.db.query<HubReviewDecision, [string]>(
      "SELECT * FROM hub_review_decisions WHERE draft_id = ? ORDER BY rowid",
    ).all(id);
  }
  dueDecisions(now: number): HubReviewDecision[] {
    return this.db.query<HubReviewDecision, [number]>(`SELECT r.* FROM hub_review_decisions r
      JOIN hub_deliveries d ON d.draft_id = r.draft_id
      WHERE d.state <> 'closed' AND r.next_at <= ? ORDER BY r.rowid`).all(now);
  }
  retryDecision(id: string, discordId: string, now: number): void {
    const attempts = (this.decision(id, discordId)?.attempts ?? 0) + 1;
    const delay = Math.min(300 * 2 ** Math.min(attempts - 1, 7), 21600);
    this.db.query("UPDATE hub_review_decisions SET attempts = ?, next_at = ? WHERE draft_id = ? AND discord_id = ?")
      .run(attempts, now + delay, id, discordId);
  }
  clearDecision(id: string, discordId: string): void {
    this.db.query("DELETE FROM hub_review_decisions WHERE draft_id = ? AND discord_id = ?").run(id, discordId);
  }
  closed(id: string, reason: string): void {
    this.db.transaction(() => {
      this.db.query("UPDATE hub_deliveries SET state = 'closed', reason = ?, decision = NULL, discord_id = NULL WHERE draft_id = ?")
        .run(reason, id);
      this.db.query("DELETE FROM hub_review_decisions WHERE draft_id = ?").run(id);
    })();
  }
  counts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const row of this.db.query<{ state: string; n: number }, []>(
      "SELECT state, count(*) AS n FROM hub_deliveries GROUP BY state",
    ).all()) counts[row.state] = row.n;
    counts.retry = this.db.query<{ n: number }, []>(`SELECT count(*) AS n FROM hub_deliveries d
      WHERE state <> 'closed' AND (reason <> '' OR EXISTS (
        SELECT 1 FROM hub_review_decisions r WHERE r.draft_id = d.draft_id AND r.attempts > 0
      ))`).get()!.n;
    return counts;
  }
  close(): void { this.db.close(); }
}
