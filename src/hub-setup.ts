import { randomUUID } from "node:crypto";
import type { HubCommunity, HubLookup } from "./hub-api";
import { HubStore, type NotificationTarget } from "./hub-store";

export type HubControl =
  | { type: "select"; id: string; options: Array<{ label: string; value: string }> }
  | { type: "channels"; id: string; multiple: boolean }
  | { type: "buttons"; buttons: Array<{ id: string; label: string }> };
export interface HubView { content: string; controls: HubControl[] }
export interface HubInteraction {
  guildId: string | null;
  userId: string;
  kind: "command" | "component";
  action: string;
  values: string[];
  defer(): Promise<void>;
  edit(view: HubView): Promise<void>;
  followUp(view: HubView): Promise<void>;
}
export interface HubControlGateway {
  validateChannels(guildId: string, channelIds: string[], purpose: "read" | "notify", userId: string): Promise<void>;
  leaveGuild(guildId: string): Promise<void>;
}

type Action = "setup" | "status" | "pause" | "leave";
interface Session {
  token: string;
  userId: string;
  guildId: string;
  action: Action;
  communities: HubCommunity[];
  community?: HubCommunity;
  channelIds?: string[];
  stage: "community" | "channels" | "notification" | "notify-channel";
  expires: number;
  revision: number;
  busy: boolean;
}
const text = (content: string): HubView => ({ content, controls: [] });
class StaleMenuError extends Error {}
const plainName = (name: string) => name.replace(/[\r\n<@]/g, " ").slice(0, 80);
const safeName = (name: string) => plainName(name).replace(/[\\[\]()*_~`|>#]/g, "\\$&");
/** Upper snowflake bound at setup time; even an empty channel never starts at zero. */
export function setupBaseline(now: number): string {
  return ((BigInt(Math.max(0, now - 1420070400000)) << 22n) | 4194303n).toString();
}

export class HubSetup {
  private readonly sessions = new Map<string, Session>();
  private readonly leaving = new Set<string>();
  private readonly revisions = new Map<string, number>();
  constructor(
    private readonly gateway: HubControlGateway,
    private readonly store: HubStore,
    private readonly hub: HubLookup,
    private readonly changed: () => void,
    private readonly log: (event: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  async handle(interaction: HubInteraction): Promise<void> {
    try {
      await interaction.defer();
      if (!interaction.guildId) { await interaction.edit(text("サーバー内で実行してください。")); return; }
      for (const [token, session] of this.sessions) if (session.expires <= this.now()) this.sessions.delete(token);
      if (interaction.kind === "command") await this.command(interaction);
      else await this.component(interaction);
    } catch {
      this.log("hub_command_failed");
      try { await interaction.edit(text("処理に失敗しました。権限や接続を確認して、/hub からやり直してください。")); } catch { /* no raw SDK errors */ }
    }
  }

  private revision(guildId: string): number { return this.revisions.get(guildId) ?? 0; }
  private invalidate(guildId: string): void {
    this.revisions.set(guildId, this.revision(guildId) + 1);
    for (const [token, session] of this.sessions) if (session.guildId === guildId) this.sessions.delete(token);
  }

  private async command(i: HubInteraction): Promise<void> {
    if (!["setup", "status", "pause", "leave"].includes(i.action)) { await i.edit(text("不明なコマンドです。")); return; }
    const guildId = i.guildId!;
    if (this.leaving.has(guildId)) { await i.edit(text("退出処理中です。完了後にやり直してください。")); return; }
    const revision = this.revision(guildId);
    const communities = (await this.hub.communities(i.userId)).filter(c => c.role === "owner" || c.role === "staff");
    if (this.leaving.has(guildId) || revision !== this.revision(guildId)) { await i.edit(text("設定が変更されました。やり直してください。")); return; }
    const available = i.action === "setup" ? communities : communities.filter(c => this.store.settings(guildId).some(s => s.community.id === c.id));
    if (!available.length) { await i.edit(text("操作できる主催・スタッフの集会がありません。ハブの登録と設定を確認してください。")); return; }
    // One live wizard per person and guild. Expired menus can never overwrite new choices.
    for (const [token, session] of this.sessions) if (session.userId === i.userId && session.guildId === guildId) this.sessions.delete(token);
    if (this.sessions.size >= 500) { await i.edit(text("設定が混み合っています。しばらく待ってやり直してください。")); return; }
    const session: Session = { token: randomUUID(), userId: i.userId, guildId, action: i.action as Action,
      communities: available, stage: "community", expires: this.now() + 600_000, revision, busy: false };
    this.sessions.set(session.token, session);
    await i.edit(this.communityView(session, 0));
  }

  private id(s: Session, action: string): string { return `hub:${s.token}:${action}`; }
  private communityView(s: Session, page: number): HubView {
    const start = page * 25;
    const controls: HubControl[] = [{ type: "select", id: this.id(s, "community"),
      options: s.communities.slice(start, start + 25).map(c => ({ label: plainName(c.name) || "集会", value: String(c.id) })) }];
    const buttons = [];
    if (page > 0) buttons.push({ id: this.id(s, `page-${page - 1}`), label: "前へ" });
    if (start + 25 < s.communities.length) buttons.push({ id: this.id(s, `page-${page + 1}`), label: "次へ" });
    if (buttons.length) controls.push({ type: "buttons", buttons });
    return { content: "操作する集会を選んでください。", controls };
  }

  private async component(i: HubInteraction): Promise<void> {
    const [, token, action] = i.action.split(":");
    const s = token && this.sessions.get(token);
    if (!s || s.userId !== i.userId || s.guildId !== i.guildId || s.revision !== this.revision(s.guildId) || s.busy) {
      await this.stale(i); return;
    }
    const expected = action?.startsWith("page-") ? "community" : action;
    if (expected !== s.stage) {
      await this.stale(i); return;
    }
    s.busy = true;
    try {
      if (action?.startsWith("page-") && s.stage === "community") {
        const page = Number(action.slice(5));
        if (!Number.isInteger(page) || page < 0 || page * 25 >= s.communities.length) throw new Error("Invalid page");
        await i.edit(this.communityView(s, page)); return;
      }
      if (action === "community" && s.stage === "community" && i.values.length === 1) {
        const community = s.communities.find(c => String(c.id) === i.values[0]);
        if (!community) throw new Error("Invalid community");
        s.community = community;
        if (s.action !== "setup") { await this.finishAction(i, s); return; }
        s.stage = "channels";
        await i.edit({ content: "LT の応募が来るのはどのチャンネルですか？（複数選択できます）", controls: [
          { type: "channels", id: this.id(s, "channels"), multiple: true },
        ] }); return;
      }
      if (action === "channels" && s.stage === "channels" && i.values.length >= 1 && i.values.length <= 25) {
        const channelIds = [...new Set(i.values)];
        await this.gateway.validateChannels(s.guildId, channelIds, "read", s.userId);
        if (!this.current(s)) throw new StaleMenuError();
        s.channelIds = channelIds;
        s.stage = "notification";
        await i.edit({ content: "承認の通知先を選んでください。", controls: [{ type: "select", id: this.id(s, "notification"), options: [
          { label: "自分への DM（主催・スタッフ）", value: "dm" }, { label: "運営用チャンネル", value: "channel" },
        ] }] }); return;
      }
      if (action === "notification" && s.stage === "notification" && i.values.length === 1) {
        if (i.values[0] === "dm") { await this.configure(i, s, { type: "dm", userId: s.userId }); return; }
        if (i.values[0] === "channel") {
          s.stage = "notify-channel";
          await i.edit({ content: "運営用の通知先チャンネルを選んでください。", controls: [
            { type: "channels", id: this.id(s, "notify-channel"), multiple: false },
          ] }); return;
        }
      }
      if (action === "notify-channel" && s.stage === "notify-channel" && i.values.length === 1) {
        await this.configure(i, s, { type: "channel", channelId: i.values[0]! }); return;
      }
      throw new Error("Invalid setup step");
    } catch (error) {
      this.sessions.delete(s.token);
      if (error instanceof StaleMenuError) { await this.stale(i); return; }
      throw error;
    } finally { s.busy = false; }
  }

  private async stale(i: HubInteraction): Promise<void> {
    try { await i.followUp(text("このメニューは古くなりました。最新の選択欄から操作してください。")); }
    catch { /* Keep the source message and its current controls intact. */ }
  }

  private current(s: Session): boolean {
    return !this.leaving.has(s.guildId) && this.sessions.get(s.token) === s && s.revision === this.revision(s.guildId) && s.expires > this.now();
  }
  private async authorize(s: Session): Promise<HubCommunity> {
    const communities = await this.hub.communities(s.userId);
    const community = communities.find(c => c.id === s.community?.id && (c.role === "owner" || c.role === "staff"));
    if (!this.current(s)) throw new StaleMenuError();
    if (!community) throw new Error("Authorization expired");
    return community;
  }

  private async configure(i: HubInteraction, s: Session, notification: NotificationTarget): Promise<void> {
    const community = await this.authorize(s);
    await this.gateway.validateChannels(s.guildId, s.channelIds!, "read", s.userId);
    if (notification.type === "channel") await this.gateway.validateChannels(s.guildId, [notification.channelId], "notify", s.userId);
    if (!this.current(s)) throw new StaleMenuError();
    this.mutate(s.guildId, () => this.store.configure(
      { guildId: s.guildId, community, channelIds: s.channelIds!, notification }, setupBaseline(this.now()),
    ));
    this.log("hub_setup_saved");
    await i.edit(text(`${safeName(community.name)} の設定を保存しました。設定時点より後の投稿を読み取ります。`));
  }

  private async finishAction(i: HubInteraction, s: Session): Promise<void> {
    const community = await this.authorize(s);
    const setting = this.store.settings(s.guildId).find(c => c.community.id === community.id);
    if (!setting) throw new Error("Setting removed");
    if (s.action === "status") {
      this.sessions.delete(s.token);
      const drafts = this.store.drafts(s.guildId, community.id);
      const notification = setting.notification.type === "dm" ? "主催・スタッフへの DM" : `<#${setting.notification.channelId}>`;
      await i.edit(text(`${safeName(community.name)}：${setting.paused ? "一時停止中" : "読み取り中"}\nチャンネル：${setting.channelIds.map(id => `<#${id}>`).join("、")}\n通知先：${notification}\n最近の下書き：\n${drafts.length ? drafts.map(d => `${d.approved ? "承認済み" : "未承認"} ${d.sourceUrl}`).join("\n") : "まだありません。"}`));
      return;
    }
    if (s.action === "pause") {
      this.mutate(s.guildId, () => this.store.pause(s.guildId, community.id));
      this.log("hub_paused");
      await i.edit(text("読み取りを一時停止しました。/hub setup で再開できます。")); return;
    }
    this.leaving.add(s.guildId);
    try {
      this.mutate(s.guildId, () => {
        this.store.leave(s.guildId, community.id);
        if (this.store.settings(s.guildId).length === 0) this.store.markPendingLeave(s.guildId);
      });
      this.log("hub_left");
      try { await i.edit(text("集会の設定と未承認の下書きを削除しました。")); }
      finally { if (this.store.pendingLeaves().includes(s.guildId)) await this.leaveGuild(s.guildId); }
    } finally {
      this.invalidate(s.guildId);
      this.leaving.delete(s.guildId);
    }
  }

  private mutate(guildId: string, operation: () => void): void {
    this.invalidate(guildId);
    // A checkpoint can fail after a committed deletion: ingestion must still stop.
    try { operation(); } finally { this.changed(); }
  }

  private async leaveGuild(guildId: string): Promise<void> {
    await this.gateway.leaveGuild(guildId);
    this.store.clearPendingLeave(guildId);
  }

  guildsReady(guildIds: string[]): void {
    const joined = new Set(guildIds);
    // 退出に失敗したまま残ったサーバーは、接続のたびに退出し直す。もう居なければ記録だけ消す。
    for (const guildId of this.store.pendingLeaves()) {
      if (!joined.has(guildId)) { this.store.clearPendingLeave(guildId); continue; }
      if (this.store.settings(guildId).length) { this.store.clearPendingLeave(guildId); continue; }
      // 退出し直す間は、対話の leave と同じく setup を受け付けない（退出後に新しい設定が残らないように）。
      if (this.leaving.has(guildId)) continue;
      this.leaving.add(guildId);
      void this.leaveGuild(guildId).catch(() => this.log("hub_leave_retry_failed"))
        .finally(() => { this.invalidate(guildId); this.leaving.delete(guildId); });
    }
    for (const guildId of new Set(this.store.settings().map(s => s.guildId))) {
      if (!joined.has(guildId)) this.guildDeleted(guildId);
    }
  }

  guildDeleted(guildId: string): void {
    // Invalidate even a lookup that is still in flight when the removal arrives.
    this.mutate(guildId, () => this.store.leave(guildId));
    this.log("hub_guild_deleted");
  }
}
