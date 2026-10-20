import { Database } from "bun:sqlite";
import type { ReviewDecision } from "./hub-api";
import type { NotificationReference } from "./gateway";

const MAX_PENDING_REVIEWS = 5;

export interface HubDelivery {
  draft_id: string;
  guild_id: string;
  community_id: number;
  hub_id: number | null;
  state: "queued" | "creating" | "ready" | "closed";
  attempted_hash: string;
  source_url: string;
  synced_hash: string;
  notified_hash: string;
  attempts: number;
  next_at: number;
  reason: string;
  reviewer_display_name: string;
}

export interface HubReviewDecision {
  draft_id: string;
  discord_id: string;
  decision: ReviewDecision;
  attempts: number;
  next_at: number;
  created_at: number;
  display_name: string;
}

export interface HubReviewNotification {
  draft_id: string;
  channel_id: string;
  message_id: string;
  edited: number;
  attempts: number;
  next_at: number;
  closed_reason: string;
}

export interface HubReviewStats {
  count: number;
  oldestAgeSeconds: number;
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
        attempted_hash TEXT NOT NULL DEFAULT '', source_url TEXT NOT NULL DEFAULT '', synced_hash TEXT NOT NULL DEFAULT '',
        notified_hash TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '',
        decision TEXT, discord_id TEXT
      );
      CREATE TABLE IF NOT EXISTS hub_review_decisions (
        draft_id TEXT NOT NULL, discord_id TEXT NOT NULL, decision TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (draft_id, discord_id)
      );
      CREATE TABLE IF NOT EXISTS hub_reviewers (
        guild_id TEXT NOT NULL, community_id INTEGER NOT NULL, discord_id TEXT NOT NULL,
        PRIMARY KEY (guild_id, community_id, discord_id)
      );
      CREATE TABLE IF NOT EXISTS hub_review_notifications (
        draft_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT NOT NULL,
        edited INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
        closed_reason TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (channel_id, message_id)
      );
    `);
    // 旧形式の保留と再送時刻を、取り込み済みの行を上書きせずに移す。
    this.db.transaction(() => {
      const now = Math.floor(Date.now() / 1000);
      if (!this.db.query<{ name: string }, []>("PRAGMA table_info(hub_review_notifications)").all().some(c => c.name === "closed_reason")) {
        this.db.exec("ALTER TABLE hub_review_notifications ADD COLUMN closed_reason TEXT NOT NULL DEFAULT ''");
      }
      for (const [table, column] of [["hub_deliveries", "reviewer_display_name"], ["hub_review_decisions", "display_name"]]) {
        if (!this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
        }
      }
      if (!this.db.query<{ name: string }, []>("PRAGMA table_info(hub_deliveries)").all().some(c => c.name === "source_url")) {
        this.db.exec("ALTER TABLE hub_deliveries ADD COLUMN source_url TEXT NOT NULL DEFAULT ''");
      }
      if (!this.db.query<{ name: string }, []>("PRAGMA table_info(hub_review_decisions)").all().some(c => c.name === "created_at")) {
        this.db.exec("ALTER TABLE hub_review_decisions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0");
        this.db.query("UPDATE hub_review_decisions SET created_at = ?").run(now);
      }
      this.db.query(`INSERT OR IGNORE INTO hub_review_decisions (draft_id, discord_id, decision, attempts, next_at, created_at)
        SELECT draft_id, discord_id, decision, attempts, next_at, ? FROM hub_deliveries
        WHERE state <> 'closed' AND decision IS NOT NULL AND discord_id IS NOT NULL`).run(now);
      this.db.exec(`
        UPDATE hub_deliveries SET decision = NULL, discord_id = NULL, attempts = 0, next_at = 0, reason = ''
          WHERE state <> 'closed' AND decision IS NOT NULL AND discord_id IS NOT NULL;
      `);
    })();
  }
  enqueue(draftId: string, guildId: string, communityId: number): void {
    this.db.query(`INSERT INTO hub_deliveries (draft_id, guild_id, community_id) VALUES (?, ?, ?)
      ON CONFLICT (draft_id) DO UPDATE SET state = CASE
        WHEN hub_id IS NOT NULL THEN 'ready' WHEN attempted_hash <> '' THEN 'creating' ELSE 'queued' END,
        guild_id = excluded.guild_id, community_id = excluded.community_id,
        attempts = 0, next_at = 0, reason = ''
      WHERE state = 'closed' AND reason = 'setting_removed'`)
      .run(draftId, guildId, communityId);
  }
  get(id: string): HubDelivery | undefined {
    return this.db.query<HubDelivery, [string]>("SELECT * FROM hub_deliveries WHERE draft_id = ?").get(id) ?? undefined;
  }
  due(now: number, changed: readonly string[] = []): HubDelivery[] {
    return this.db.query<HubDelivery, [string, number]>(`SELECT * FROM hub_deliveries WHERE (
      state <> 'closed' OR (reason IN ('approved', 'rejected') AND (
        attempts > 0 OR draft_id IN (SELECT value FROM json_each(?))
      ))) AND next_at <= ? ORDER BY rowid`).all(JSON.stringify(changed), now);
  }
  creating(id: string, hash: string, sourceUrl = ""): void {
    this.db.query("UPDATE hub_deliveries SET state = 'creating', attempted_hash = ?, source_url = ? WHERE draft_id = ? AND state <> 'closed'").run(hash, sourceUrl, id);
  }
  requeue(id: string): void {
    this.db.query(`UPDATE hub_deliveries SET state = CASE WHEN state = 'closed' THEN 'closed' ELSE 'queued' END,
      attempted_hash = '', source_url = '' WHERE draft_id = ?`).run(id);
  }
  created(id: string, hubId: number, hash: string): void {
    this.db.query(`UPDATE hub_deliveries SET state = 'ready', hub_id = ?, synced_hash = ?,
      attempts = 0, next_at = 0, reason = '' WHERE draft_id = ? AND state <> 'closed'`).run(hubId, hash, id);
  }
  synced(id: string, hash: string): void {
    this.db.query(`UPDATE hub_deliveries SET synced_hash = ?, attempts = 0, next_at = 0,
      reason = CASE WHEN state = 'closed' THEN reason ELSE '' END
      WHERE draft_id = ? AND (state <> 'closed' OR reason IN ('approved', 'rejected'))`).run(hash, id);
  }
  notified(id: string, hash: string, reference?: NotificationReference): void {
    this.db.transaction(() => {
      if (reference) this.notification(id, reference);
      this.db.query("UPDATE hub_deliveries SET notified_hash = ?, attempts = 0, next_at = 0, reason = '' WHERE draft_id = ? AND state <> 'closed'").run(hash, id);
    })();
  }
  notification(id: string, reference: NotificationReference): void {
    this.db.query(`INSERT OR IGNORE INTO hub_review_notifications (draft_id, channel_id, message_id) VALUES (?, ?, ?)`)
      .run(id, reference.channelId, reference.messageId);
  }
  dueNotifications(now: number, id?: string): HubReviewNotification[] {
    return this.db.query<HubReviewNotification, [number, string | null, string | null]>(`SELECT n.* FROM hub_review_notifications n
      JOIN hub_deliveries d ON d.draft_id = n.draft_id
      WHERE d.state = 'closed' AND d.reason IN ('approved', 'rejected') AND n.edited = 0 AND n.closed_reason = '' AND n.next_at <= ?
        AND (? IS NULL OR n.draft_id = ?) ORDER BY n.rowid`).all(now, id ?? null, id ?? null);
  }
  notificationEdited(row: HubReviewNotification): void {
    this.db.query("UPDATE hub_review_notifications SET edited = 1, attempts = 0, next_at = 0 WHERE channel_id = ? AND message_id = ?")
      .run(row.channel_id, row.message_id);
  }
  notificationClosed(row: HubReviewNotification, reason: "unknown_message" | "unknown_channel" | "not_found"): void {
    this.db.query("UPDATE hub_review_notifications SET closed_reason = ?, attempts = 0, next_at = 0 WHERE channel_id = ? AND message_id = ? AND edited = 0")
      .run(reason, row.channel_id, row.message_id);
  }
  retryNotification(row: HubReviewNotification, now: number, forbidden = false): void {
    const attempts = row.attempts + 1;
    const delay = forbidden ? 21600 : Math.min(300 * 2 ** Math.min(attempts - 1, 7), 21600);
    this.db.query("UPDATE hub_review_notifications SET attempts = ?, next_at = ? WHERE channel_id = ? AND message_id = ? AND edited = 0 AND closed_reason = ''")
      .run(attempts, now + delay, row.channel_id, row.message_id);
  }
  retry(id: string, now: number, reason: string): void {
    const attempts = (this.get(id)?.attempts ?? 0) + 1;
    const delay = Math.min(300 * 2 ** Math.min(attempts - 1, 7), 21600);
    this.db.query(`UPDATE hub_deliveries SET attempts = ?, next_at = ?, reason = CASE WHEN state = 'closed' THEN reason ELSE ? END
      WHERE draft_id = ? AND (state <> 'closed' OR reason IN ('approved', 'rejected'))`)
      .run(attempts, now + delay, reason, id);
  }
  queueDecision(id: string, decision: ReviewDecision, discordId: string, now = Math.floor(Date.now() / 1000), displayName = ""): boolean {
    return this.db.query(`WITH reviewers AS (
        SELECT v.discord_id FROM hub_reviewers v JOIN hub_deliveries d
          ON v.guild_id = d.guild_id AND v.community_id = d.community_id WHERE d.draft_id = ?
      ) INSERT INTO hub_review_decisions (draft_id, discord_id, decision, created_at, display_name)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM hub_review_decisions WHERE draft_id = ? AND discord_id = ?
      ) OR ? IN (SELECT discord_id FROM reviewers) OR (
        SELECT count(*) FROM hub_review_decisions WHERE draft_id = ? AND discord_id NOT IN (SELECT discord_id FROM reviewers)
      ) < ${MAX_PENDING_REVIEWS}
      ON CONFLICT (draft_id, discord_id) DO UPDATE SET decision = excluded.decision, display_name = excluded.display_name`)
      .run(id, id, discordId, decision, now, displayName, id, discordId, discordId, id).changes > 0;
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
    return this.db.query<HubReviewDecision, [number]>(`SELECT draft_id, discord_id, decision, attempts, next_at, created_at, display_name FROM (
      SELECT r.*, r.rowid AS review_order, (v.discord_id IS NOT NULL) AS verified, row_number() OVER (
        PARTITION BY r.draft_id, (v.discord_id IS NOT NULL) ORDER BY r.created_at, r.rowid
      ) AS position FROM hub_review_decisions r
      JOIN hub_deliveries d ON d.draft_id = r.draft_id
      LEFT JOIN hub_reviewers v ON v.guild_id = d.guild_id AND v.community_id = d.community_id AND v.discord_id = r.discord_id
      WHERE d.state <> 'closed' AND r.next_at <= ?
    ) WHERE verified OR position <= ${MAX_PENDING_REVIEWS} ORDER BY verified DESC, created_at, review_order`).all(now);
  }
  recordReviewer(id: string, discordId: string): void {
    this.db.query(`INSERT OR IGNORE INTO hub_reviewers (guild_id, community_id, discord_id)
      SELECT guild_id, community_id, ? FROM hub_deliveries WHERE draft_id = ?`).run(discordId, id);
  }
  pendingReviews(now: number, guildId?: string, communityId?: number): HubReviewStats {
    const row = this.db.query<{ n: number; oldest: number | null }, [string | null, string | null, number | null, number | null]>(`
      SELECT count(*) AS n, min(r.created_at) AS oldest FROM hub_review_decisions r
      JOIN hub_deliveries d ON d.draft_id = r.draft_id
      JOIN hub_settings s ON s.guild_id = d.guild_id AND s.community_id = d.community_id WHERE d.state <> 'closed'
        AND (? IS NULL OR d.guild_id = ?) AND (? IS NULL OR d.community_id = ?)
    `).get(guildId ?? null, guildId ?? null, communityId ?? null, communityId ?? null)!;
    return { count: row.n, oldestAgeSeconds: Math.max(0, Math.floor(now - (row.oldest ?? now))) };
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
  closed(id: string, reason: string, displayName = ""): void {
    this.db.transaction(() => {
      this.db.query("UPDATE hub_deliveries SET state = 'closed', reason = ?, reviewer_display_name = ?, attempts = 0, next_at = 0, decision = NULL, discord_id = NULL WHERE draft_id = ?")
        .run(reason, displayName, id);
      this.db.query("DELETE FROM hub_review_decisions WHERE draft_id = ?").run(id);
    })();
  }
  counts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const row of this.db.query<{ state: string; n: number }, []>(
      `SELECT state, count(*) AS n FROM hub_deliveries d WHERE state = 'closed' OR EXISTS (
        SELECT 1 FROM hub_settings s WHERE s.guild_id = d.guild_id AND s.community_id = d.community_id
      ) GROUP BY state`,
    ).all()) counts[row.state] = row.n;
    counts.retry = this.db.query<{ n: number }, []>(`SELECT count(*) AS n FROM hub_deliveries d
      WHERE EXISTS (
        SELECT 1 FROM hub_settings s WHERE s.guild_id = d.guild_id AND s.community_id = d.community_id
      ) AND (
        (state = 'closed' AND reason IN ('approved', 'rejected') AND (attempts > 0 OR EXISTS (
          SELECT 1 FROM hub_review_notifications n WHERE n.draft_id = d.draft_id AND n.edited = 0 AND n.closed_reason = ''
        ))) OR
        (state <> 'closed' AND (reason <> '' OR EXISTS (
          SELECT 1 FROM hub_review_decisions r WHERE r.draft_id = d.draft_id AND r.attempts > 0
        )))
      )`).get()!.n;
    return counts;
  }
  close(): void { this.db.close(); }
}
