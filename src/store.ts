import { Database } from "bun:sqlite";
import { compareIds, type GatewayMessage } from "./gateway";

/** Durable inbox. A cursor only acknowledges messages already stored here. */
export class MessageStore {
  protected readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS channel_cursors (
        channel_id TEXT PRIMARY KEY,
        last_message_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inbox (
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        received_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (channel_id, message_id)
      );
    `);
    // secure_delete は過去の削除に遡らない。前の版で空き頁に残った本文を起動時に一度消す。
    this.db.exec("VACUUM");
    this.truncateWal();
  }

  cursor(channelId: string): string {
    return this.db.query<{ last_message_id: string }, [string]>(
      "SELECT last_message_id FROM channel_cursors WHERE channel_id = ?",
    ).get(channelId)?.last_message_id ?? "0";
  }

  save(message: GatewayMessage, advanceCursor = false): boolean {
    return this.db.transaction(() => {
      const result = this.db.query(
        "INSERT OR IGNORE INTO inbox (channel_id, message_id, payload) VALUES (?, ?, ?)",
      ).run(message.channelId, message.id, JSON.stringify(message));
      if (advanceCursor) this.advance(message.channelId, message.id);
      return result.changes > 0;
    })();
  }

  advance(channelId: string, messageId: string): void {
    if (compareIds(messageId, this.cursor(channelId)) <= 0) return;
    this.db.query(`INSERT INTO channel_cursors (channel_id, last_message_id) VALUES (?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET last_message_id = excluded.last_message_id`
    ).run(channelId, messageId);
  }

  /** 受信箱は処理待ちの間だけ本文を持つ。処理が済んだら消す。 */
  ack(channelId: string, messageId: string): void {
    this.db.query("DELETE FROM inbox WHERE channel_id = ? AND message_id = ?").run(channelId, messageId);
    this.truncateWal();
  }

  /** 処理されずに残った本文も、期限を過ぎたら消す。 */
  purge(maxAgeSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): number {
    const removed = this.db.query("DELETE FROM inbox WHERE received_at <= ?").run(nowSeconds - maxAgeSeconds).changes;
    this.truncateWal();
    return removed;
  }

  /** secure_delete で上書きした頁を本体へ戻し、本文の残る WAL を空にする。 */
  protected truncateWal(): void {
    // 読み取り中の接続があると例外ではなく busy=1 が返る。成功扱いにせず呼び出し元で再試行させる。
    const result = this.db.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (!result || result.busy !== 0) throw new Error("WAL checkpoint incomplete");
  }

  messages(channelId: string): GatewayMessage[] {
    return this.db.query<{ payload: string }, [string]>(
      "SELECT payload FROM inbox WHERE channel_id = ? ORDER BY length(message_id), message_id",
    ).all(channelId).map(row => JSON.parse(row.payload) as GatewayMessage);
  }

  close(): void {
    this.db.close();
  }
}
