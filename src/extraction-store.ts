import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mergeMaterials, type Material } from "./extraction-fields";
import type { NotificationTarget } from "./hub-store";

export interface PostReference {
  messageId: string;
  channelId: string;
  url: string;
}

export interface TalkDraft {
  id: string;
  meetingId: string;
  presenterId: string;
  presenterName: string;
  eventDate: string;
  title: string;
  materials: Material[];
  sources: PostReference[];
}

export type NewTalkDraft = Omit<TalkDraft, "id" | "sources">;
export type SavedDraft = { status: "candidate"; action: "created" | "updated"; draft: TalkDraft }
  | { status: "duplicate"; draft: TalkDraft };

/** 再試行の記録。本文は持たず、Gateway から取り直すための ID と出典だけ。 */
export interface PendingPost {
  meetingId: string;
  authorId: string;
  source: PostReference;
  reason: string;
  attempts: number;
  nextAt: number;
  state: "retry" | "review";
}

interface PendingRow {
  meeting_id: string;
  author_id: string;
  message_id: string;
  channel_id: string;
  source_url: string;
  reason: string;
  attempts: number;
  next_at: number;
  state: "retry" | "review";
}

const toPending = (row: PendingRow): PendingPost => ({
  meetingId: row.meeting_id, authorId: row.author_id, reason: row.reason, attempts: row.attempts,
  nextAt: row.next_at, state: row.state,
  source: { messageId: row.message_id, channelId: row.channel_id, url: row.source_url },
});

interface DraftRow {
  id: string;
  meeting_id: string;
  presenter_id: string;
  presenter_name: string;
  event_date: string;
  title: string;
  materials: string;
}

export interface PostReviewNotification {
  message_id: string;
  guild_id: string;
  community_id: number;
  notified: number;
  closed: number;
  sending: number;
  notification: string;
  attempted_at: number;
  send_outcome: "unknown" | "rejected" | "sent";
}

/** 抽出済みの項目と出典だけを保存する。受信箱とは独立し、本文の列を持たない。 */
export class ExtractionStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS talk_drafts (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL,
        presenter_id TEXT NOT NULL,
        presenter_name TEXT NOT NULL,
        event_date TEXT NOT NULL,
        title TEXT NOT NULL,
        materials TEXT NOT NULL,
        UNIQUE (meeting_id, presenter_id, event_date)
      );
      CREATE TABLE IF NOT EXISTS talk_sources (
        message_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        source_url TEXT NOT NULL,
        draft_id TEXT NOT NULL REFERENCES talk_drafts(id)
      );
      CREATE TABLE IF NOT EXISTS pending_posts (
        message_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        source_url TEXT NOT NULL,
        meeting_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        next_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('retry', 'review'))
      );
      CREATE TABLE IF NOT EXISTS post_review_notifications (
        message_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        community_id INTEGER NOT NULL,
        notified INTEGER NOT NULL DEFAULT 0,
        closed INTEGER NOT NULL DEFAULT 0,
        sending INTEGER NOT NULL DEFAULT 0,
        notification TEXT NOT NULL DEFAULT ''
      );
    `);
    this.db.transaction(() => {
      const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(post_review_notifications)").all();
      if (!columns.some(c => c.name === "sending")) {
        this.db.exec("ALTER TABLE post_review_notifications ADD COLUMN sending INTEGER NOT NULL DEFAULT 0");
      }
      if (!columns.some(c => c.name === "notification")) {
        this.db.exec("ALTER TABLE post_review_notifications ADD COLUMN notification TEXT NOT NULL DEFAULT ''");
      }
      if (!columns.some(c => c.name === "attempted_at")) {
        this.db.exec("ALTER TABLE post_review_notifications ADD COLUMN attempted_at INTEGER NOT NULL DEFAULT 0");
      }
      if (!columns.some(c => c.name === "send_outcome")) {
        this.db.exec("ALTER TABLE post_review_notifications ADD COLUMN send_outcome TEXT NOT NULL DEFAULT 'unknown'");
        this.db.exec("UPDATE post_review_notifications SET send_outcome = 'sent' WHERE notified = 1");
      }
    }).immediate();
  }

  get(id: string): TalkDraft | undefined {
    const row = this.db.query<DraftRow, [string]>("SELECT * FROM talk_drafts WHERE id = ?").get(id);
    if (!row) return undefined;
    const sources = this.db.query<{ message_id: string; channel_id: string; source_url: string }, [string]>(
      "SELECT message_id, channel_id, source_url FROM talk_sources WHERE draft_id = ? ORDER BY rowid",
    ).all(id).map(source => ({ messageId: source.message_id, channelId: source.channel_id, url: source.source_url }));
    return {
      id: row.id, meetingId: row.meeting_id, presenterId: row.presenter_id, presenterName: row.presenter_name,
      eventDate: row.event_date, title: row.title, materials: JSON.parse(row.materials) as Material[], sources,
    };
  }

  allDrafts(): TalkDraft[] {
    return this.db.query<{ id: string }, []>("SELECT id FROM talk_drafts ORDER BY rowid").all().map(row => this.get(row.id)!);
  }

  forPresenter(meetingId: string, presenterId: string): TalkDraft[] {
    return this.db.query<{ id: string }, [string, string]>(
      "SELECT id FROM talk_drafts WHERE meeting_id = ? AND presenter_id = ? ORDER BY event_date, id",
    ).all(meetingId, presenterId).map(row => this.get(row.id)!);
  }

  forMessage(messageId: string): TalkDraft | undefined {
    const row = this.db.query<{ draft_id: string }, [string]>(
      "SELECT draft_id FROM talk_sources WHERE message_id = ?",
    ).get(messageId);
    return row ? this.get(row.draft_id) : undefined;
  }

  create(fields: NewTalkDraft, source: PostReference): SavedDraft {
    return this.db.transaction((): SavedDraft => {
      const prior = this.forMessage(source.messageId);
      if (prior) return { status: "duplicate", draft: prior };
      const sameTalk = this.db.query<{ id: string }, [string, string, string]>(
        "SELECT id FROM talk_drafts WHERE meeting_id = ? AND presenter_id = ? AND event_date = ?",
      ).get(fields.meetingId, fields.presenterId, fields.eventDate);
      if (sameTalk) {
        this.addSource(sameTalk.id, source);
        return { status: "duplicate", draft: this.get(sameTalk.id)! };
      }
      const id = randomUUID();
      this.db.query(`INSERT INTO talk_drafts
        (id, meeting_id, presenter_id, presenter_name, event_date, title, materials) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(id, fields.meetingId, fields.presenterId, fields.presenterName, fields.eventDate, fields.title,
        JSON.stringify(mergeMaterials(fields.materials)));
      this.addSource(id, source);
      return { status: "candidate", action: "created", draft: this.get(id)! };
    }).immediate();
  }

  /** 現在値をトランザクション内で読み直し、並行した続報の資料も失わない。 */
  addFollowUp(id: string, materials: Material[], source: PostReference): SavedDraft {
    return this.db.transaction((): SavedDraft => {
      const prior = this.forMessage(source.messageId);
      if (prior) return { status: "duplicate", draft: prior };
      const draft = this.get(id);
      if (!draft) throw new Error("Draft no longer exists");
      this.db.query("UPDATE talk_drafts SET materials = ? WHERE id = ?")
        .run(JSON.stringify(mergeMaterials(draft.materials, materials)), id);
      this.addSource(id, source);
      return { status: "candidate", action: "updated", draft: this.get(id)! };
    }).immediate();
  }

  private addSource(id: string, source: PostReference): void {
    this.db.query("INSERT INTO talk_sources (message_id, channel_id, source_url, draft_id) VALUES (?, ?, ?, ?)")
      .run(source.messageId, source.channelId, source.url, id);
  }

  /** 再試行を記録し、回数を 1 増やして次の時刻を決める。返り値は記録後の回数。 */
  scheduleRetry(meetingId: string, authorId: string, source: PostReference, reason: string,
    delaySeconds: (attempts: number) => number, nowSeconds: number): number {
    return this.db.transaction((): number => {
      const prior = this.db.query<{ attempts: number }, [string]>(
        "SELECT attempts FROM pending_posts WHERE message_id = ?").get(source.messageId);
      const attempts = (prior?.attempts ?? 0) + 1;
      this.db.query(`INSERT INTO pending_posts
        (message_id, channel_id, source_url, meeting_id, author_id, reason, attempts, next_at, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'retry')
        ON CONFLICT(message_id) DO UPDATE SET reason = excluded.reason, attempts = excluded.attempts,
          next_at = excluded.next_at, state = 'retry'`
      ).run(source.messageId, source.channelId, source.url, meetingId, authorId, reason, attempts,
        nowSeconds + delaySeconds(attempts));
      return attempts;
    }).immediate();
  }

  /** 取り直せない・回数切れの投稿は消さず、確認対象として残す。 */
  /** 確認対象を本文なしで残す。新しい投稿でも、受信箱から消す前に記録しておく。 */
  holdReview(meetingId: string, authorId: string, source: PostReference, reason: string, nowSeconds: number): void {
    this.db.query(`INSERT INTO pending_posts
      (message_id, channel_id, source_url, meeting_id, author_id, reason, attempts, next_at, state)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'review')
      ON CONFLICT(message_id) DO UPDATE SET reason = excluded.reason, state = 'review'`
    ).run(source.messageId, source.channelId, source.url, meetingId, authorId, reason, nowSeconds);
  }

  markReview(messageId: string, reason: string): void {
    this.db.query("UPDATE pending_posts SET state = 'review', reason = ? WHERE message_id = ?").run(reason, messageId);
  }

  clearPending(messageId: string): void {
    this.db.query("DELETE FROM pending_posts WHERE message_id = ?").run(messageId);
  }

  pending(messageId: string): PendingPost | undefined {
    const row = this.db.query<PendingRow, [string]>("SELECT * FROM pending_posts WHERE message_id = ?").get(messageId);
    return row ? toPending(row) : undefined;
  }

  dueRetries(nowSeconds: number, limit = 50): PendingPost[] {
    return this.db.query<PendingRow, [number, number]>(
      "SELECT * FROM pending_posts WHERE state = 'retry' AND next_at <= ? ORDER BY next_at, length(message_id), message_id LIMIT ?",
    ).all(nowSeconds, limit).map(toPending);
  }

  reviewPosts(): PendingPost[] {
    return this.db.query<PendingRow, []>("SELECT * FROM pending_posts WHERE state = 'review' ORDER BY rowid")
      .all().map(toPending);
  }

  reviewNotification(messageId: string): PostReviewNotification | undefined {
    return this.db.query<PostReviewNotification, [string]>("SELECT * FROM post_review_notifications WHERE message_id = ?")
      .get(messageId) ?? undefined;
  }

  /** 外部送信より先に宛先を保存し、成否不明なら次の周期で旧宛先を照合する。 */
  reserveReviewNotification(messageId: string, guildId: string, communityId: number, notification: NotificationTarget): void {
    this.db.query(`INSERT INTO post_review_notifications (message_id, guild_id, community_id, sending, notification, attempted_at, send_outcome)
      VALUES (?, ?, ?, 1, ?, ?, 'unknown')
      ON CONFLICT(message_id) DO UPDATE SET guild_id = excluded.guild_id, community_id = excluded.community_id,
        sending = 1, notification = excluded.notification, attempted_at = excluded.attempted_at, send_outcome = 'unknown'
      WHERE notified = 0 AND closed = 0`)
      .run(messageId, guildId, communityId, JSON.stringify(notification), Date.now());
  }

  markReviewNotified(messageId: string): void {
    this.db.query("UPDATE post_review_notifications SET notified = 1, sending = 0, send_outcome = 'sent' WHERE message_id = ?").run(messageId);
  }

  markReviewNotificationRejected(messageId: string): void {
    this.db.query("UPDATE post_review_notifications SET sending = 0, send_outcome = 'rejected' WHERE message_id = ?").run(messageId);
  }

  unknownReviewNotificationCount(): number {
    return this.db.query<{ n: number }, []>(`SELECT count(*) AS n FROM post_review_notifications
      WHERE sending = 1 AND notified = 0 AND closed = 0`).get()!.n;
  }

  /** 閉じた記録も残し、同じ投稿の再取り込みで通知し直さない。 */
  closeReview(messageId: string): boolean {
    return this.db.query("UPDATE post_review_notifications SET closed = 1 WHERE message_id = ? AND closed = 0")
      .run(messageId).changes > 0;
  }

  /** 同じ発表者の投稿で、まだ再試行待ちのもの（応募の可能性がある）。応募待ちの続報同士は数えない。 */
  hasPendingFrom(meetingId: string, authorId: string, exceptMessageId: string): boolean {
    return this.db.query<{ n: number }, [string, string, string]>(
      "SELECT count(*) AS n FROM pending_posts WHERE state = 'retry' AND reason <> 'awaiting_application' AND meeting_id = ? AND author_id = ? AND message_id <> ?",
    ).get(meetingId, authorId, exceptMessageId)!.n > 0;
  }

  counts(): { drafts: number; sourcePosts: number } {
    return {
      drafts: this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM talk_drafts").get()!.n,
      sourcePosts: this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM talk_sources").get()!.n,
    };
  }

  close(): void { this.db.close(); }
}
