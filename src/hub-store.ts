import { compareIds } from "./gateway";
import { MessageStore } from "./store";
import type { HubCommunity } from "./hub-api";

export type NotificationTarget = { type: "dm"; userId: string } | { type: "channel"; channelId: string };
export interface HubSetting {
  guildId: string;
  community: HubCommunity;
  channelIds: string[];
  notification: NotificationTarget;
  paused: boolean;
}
export interface HubDraft {
  id: string;
  guildId: string;
  communityId: number;
  sourceUrl: string;
  createdAt: string;
  approved: boolean;
}

/** Shares the inbox transaction so removing settings cannot leave orphaned bodies. */
export class HubStore extends MessageStore {
  constructor(path: string) {
    super(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hub_settings (
        guild_id TEXT NOT NULL, community_id INTEGER NOT NULL,
        community TEXT NOT NULL, notification TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, community_id)
      );
      CREATE TABLE IF NOT EXISTS hub_channels (
        guild_id TEXT NOT NULL, community_id INTEGER NOT NULL, channel_id TEXT NOT NULL,
        baseline TEXT NOT NULL, cursor TEXT NOT NULL, PRIMARY KEY (guild_id, community_id, channel_id)
      );
      CREATE TABLE IF NOT EXISTS hub_drafts (
        id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, community_id INTEGER NOT NULL,
        source_url TEXT NOT NULL, created_at TEXT NOT NULL, approved INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS hub_pending_leaves (guild_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS hub_reviewers (
        guild_id TEXT NOT NULL, community_id INTEGER NOT NULL, discord_id TEXT NOT NULL,
        PRIMARY KEY (guild_id, community_id, discord_id)
      );
    `);
    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(hub_channels)").all();
    if (!columns.some(column => column.name === "cursor")) {
      this.db.transaction(() => {
        this.db.exec("ALTER TABLE hub_channels ADD COLUMN cursor TEXT NOT NULL DEFAULT '0'");
        // A legacy shared cursor cannot prove that a paused setting was covered.
        // Re-read from each setup boundary rather than skipping its unseen range.
        this.db.exec("UPDATE hub_channels SET cursor = baseline");
      })();
    }
  }

  settings(guildId?: string): HubSetting[] {
    const rows = this.db.query<{ guild_id: string; community: string; community_id: number; notification: string; paused: number }, []>(
      "SELECT * FROM hub_settings ORDER BY guild_id, community_id",
    ).all();
    return rows.filter(row => guildId === undefined || row.guild_id === guildId).map(row => ({
      guildId: row.guild_id, community: JSON.parse(row.community) as HubCommunity,
      notification: JSON.parse(row.notification) as NotificationTarget, paused: Boolean(row.paused),
      channelIds: this.db.query<{ channel_id: string }, [string, number]>(
        "SELECT channel_id FROM hub_channels WHERE guild_id = ? AND community_id = ? ORDER BY channel_id",
      ).all(row.guild_id, row.community_id).map(channel => channel.channel_id),
    }));
  }

  messageSettings(channelId: string, messageId: string): HubSetting[] {
    const rows = this.db.query<{ guild_id: string; community_id: number; baseline: string }, [string]>(
      "SELECT guild_id, community_id, baseline FROM hub_channels WHERE channel_id = ?",
    ).all(channelId);
    return this.settings().filter(s => !s.paused && rows.some(row => row.guild_id === s.guildId
      && row.community_id === s.community.id && compareIds(messageId, row.baseline) > 0));
  }

  channelIds(): string[] {
    return this.db.query<{ channel_id: string }, []>(`SELECT DISTINCT c.channel_id FROM hub_channels c
      JOIN hub_settings s USING (guild_id, community_id) WHERE s.paused = 0 ORDER BY c.channel_id`)
      .all().map(row => row.channel_id);
  }

  baseline(channelId: string): string {
    const rows = this.db.query<{ baseline: string }, [string]>(`SELECT c.baseline FROM hub_channels c
      JOIN hub_settings s USING (guild_id, community_id) WHERE c.channel_id = ? AND s.paused = 0`).all(channelId);
    return rows.reduce((min, row) => BigInt(row.baseline) < BigInt(min) ? row.baseline : min, rows[0]?.baseline ?? "0");
  }

  override cursor(channelId: string): string {
    const rows = this.db.query<{ cursor: string; paused: number }, [string]>(`SELECT c.cursor, s.paused FROM hub_channels c
      JOIN hub_settings s USING (guild_id, community_id) WHERE c.channel_id = ?`).all(channelId);
    const active = rows.filter(row => !row.paused);
    const selected = active.length ? active : rows;
    return selected.reduce((min, row) => compareIds(row.cursor, min) < 0 ? row.cursor : min,
      selected[0]?.cursor ?? super.cursor(channelId));
  }

  override advance(channelId: string, messageId: string): void {
    const rows = this.db.query<{ guild_id: string; community_id: number; cursor: string }, [string]>(`SELECT c.* FROM hub_channels c
      JOIN hub_settings s USING (guild_id, community_id) WHERE c.channel_id = ? AND s.paused = 0`).all(channelId);
    for (const row of rows) if (compareIds(messageId, row.cursor) > 0) {
      this.db.query("UPDATE hub_channels SET cursor = ? WHERE guild_id = ? AND community_id = ? AND channel_id = ?")
        .run(messageId, row.guild_id, row.community_id, channelId);
    }
  }

  configure(setting: Omit<HubSetting, "paused">, baseline: string, reviewerId?: string): void {
    if (!setting.channelIds.length || setting.channelIds.length > 25) throw new Error("Invalid channel selection");
    this.db.transaction(() => {
      this.db.query("DELETE FROM hub_pending_leaves WHERE guild_id = ?").run(setting.guildId);
      const old = this.db.query<{ channel_id: string; baseline: string; cursor: string }, [string, number]>(
        "SELECT channel_id, baseline, cursor FROM hub_channels WHERE guild_id = ? AND community_id = ?",
      ).all(setting.guildId, setting.community.id);
      this.db.query(`INSERT INTO hub_settings (guild_id, community_id, community, notification, paused) VALUES (?, ?, ?, ?, 0)
        ON CONFLICT (guild_id, community_id) DO UPDATE SET community = excluded.community, notification = excluded.notification, paused = 0`)
        .run(setting.guildId, setting.community.id, JSON.stringify(setting.community), JSON.stringify(setting.notification));
      if (reviewerId) this.db.query("INSERT OR IGNORE INTO hub_reviewers (guild_id, community_id, discord_id) VALUES (?, ?, ?)")
        .run(setting.guildId, setting.community.id, reviewerId);
      this.db.query("DELETE FROM hub_channels WHERE guild_id = ? AND community_id = ?").run(setting.guildId, setting.community.id);
      for (const id of new Set(setting.channelIds)) {
        const prior = old.find(row => row.channel_id === id);
        this.db.query("INSERT INTO hub_channels (guild_id, community_id, channel_id, baseline, cursor) VALUES (?, ?, ?, ?, ?)")
          .run(setting.guildId, setting.community.id, id, prior?.baseline ?? baseline, prior?.cursor ?? baseline);
      }
      this.removeOrphanedChannels(old.map(row => row.channel_id));
    })();
    this.truncateWal();
  }

  /** 最後の設定を外した後、サーバーからの退出が済むまで残す。失敗しても次の接続で退出し直す。 */
  markPendingLeave(guildId: string): void {
    this.db.query("INSERT OR IGNORE INTO hub_pending_leaves (guild_id) VALUES (?)").run(guildId);
  }

  clearPendingLeave(guildId: string): void {
    this.db.query("DELETE FROM hub_pending_leaves WHERE guild_id = ?").run(guildId);
  }

  pendingLeaves(): string[] {
    return this.db.query<{ guild_id: string }, []>("SELECT guild_id FROM hub_pending_leaves ORDER BY guild_id").all().map(row => row.guild_id);
  }

  pause(guildId: string, communityId: number): void {
    this.db.query("UPDATE hub_settings SET paused = 1 WHERE guild_id = ? AND community_id = ?").run(guildId, communityId);
  }

  /** pendingLeaveIfEmpty: 最後の設定を消したら、同じトランザクションで退出待ちを記録する。 */
  leave(guildId: string, communityId?: number, pendingLeaveIfEmpty = false): void {
    this.db.transaction(() => {
      const settings = this.settings(guildId).filter(setting => communityId === undefined || setting.community.id === communityId);
      if (this.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hub_deliveries'").get()) {
        this.db.query(`DELETE FROM hub_review_decisions WHERE draft_id IN (
          SELECT draft_id FROM hub_deliveries WHERE guild_id = ? AND (? IS NULL OR community_id = ?)
        )`).run(guildId, communityId ?? null, communityId ?? null);
        this.db.query(`UPDATE hub_deliveries SET state = 'closed', reason = 'setting_removed', decision = NULL, discord_id = NULL
          WHERE state <> 'closed' AND guild_id = ? AND (? IS NULL OR community_id = ?)`)
          .run(guildId, communityId ?? null, communityId ?? null);
      }
      for (const setting of settings) {
        this.db.query("DELETE FROM hub_settings WHERE guild_id = ? AND community_id = ?").run(guildId, setting.community.id);
        this.db.query("DELETE FROM hub_channels WHERE guild_id = ? AND community_id = ?").run(guildId, setting.community.id);
      }
      if (communityId === undefined) {
        this.db.query("DELETE FROM hub_drafts WHERE guild_id = ? AND approved = 0").run(guildId);
        this.db.query("DELETE FROM hub_pending_leaves WHERE guild_id = ?").run(guildId);
      }
      else this.db.query("DELETE FROM hub_drafts WHERE guild_id = ? AND community_id = ? AND approved = 0").run(guildId, communityId);
      this.removeOrphanedChannels(settings.flatMap(setting => setting.channelIds));
      if (pendingLeaveIfEmpty && communityId !== undefined && this.settings(guildId).length === 0) this.markPendingLeave(guildId);
    })();
    this.truncateWal();
  }

  private removeOrphanedChannels(channelIds: string[]): void {
    for (const channelId of channelIds) {
      const remaining = this.db.query<{ baseline: string }, [string]>(
        "SELECT baseline FROM hub_channels WHERE channel_id = ?",
      ).all(channelId);
      if (remaining.length) {
        // 残る設定のどれにとっても導入前の本文は、もう誰の分でもないので消す。
        const floor = remaining.reduce((min, row) => BigInt(row.baseline) < min ? BigInt(row.baseline) : min, BigInt(remaining[0]!.baseline));
        const stale = this.db.query<{ message_id: string }, [string]>("SELECT message_id FROM inbox WHERE channel_id = ?")
          .all(channelId).filter(row => BigInt(row.message_id) <= floor);
        for (const row of stale) this.db.query("DELETE FROM inbox WHERE channel_id = ? AND message_id = ?").run(channelId, row.message_id);
        continue;
      }
      this.db.query("DELETE FROM inbox WHERE channel_id = ?").run(channelId);
      this.db.query("DELETE FROM channel_cursors WHERE channel_id = ?").run(channelId);
    }
  }

  saveDraft(draft: HubDraft): void {
    // Only an extracted reference is stored here, never the source message body.
    if (!/^https:\/\/discord\.com\/channels\/[0-9]{1,20}\/[0-9]{1,20}\/[0-9]{1,20}$/.test(draft.sourceUrl)) {
      throw new Error("Draft source must be a Discord message link");
    }
    this.db.query("INSERT OR REPLACE INTO hub_drafts VALUES (?, ?, ?, ?, ?, ?)")
      .run(draft.id, draft.guildId, draft.communityId, draft.sourceUrl, draft.createdAt, Number(draft.approved));
  }

  drafts(guildId: string, communityId: number): HubDraft[] {
    return this.db.query<{ id: string; source_url: string; created_at: string; approved: number }, [string, number]>(
      "SELECT * FROM hub_drafts WHERE guild_id = ? AND community_id = ? ORDER BY created_at DESC, id DESC LIMIT 5",
    ).all(guildId, communityId).map(row => ({ id: row.id, guildId, communityId, sourceUrl: row.source_url, createdAt: row.created_at, approved: Boolean(row.approved) }));
  }
}
