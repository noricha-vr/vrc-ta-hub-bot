import { createHash } from "node:crypto";
import { discordText } from "./discord-text";
import { notificationTargetUnavailable, type NotificationReference } from "./gateway";
import type { HubApi } from "./hub-api";
import type { ExtractionStore, PendingPost } from "./extraction-store";
import type { HubReviewGateway } from "./hub-review";
import type { HubInteraction, HubView } from "./hub-setup";
import type { HubSetting, HubStore, NotificationTarget } from "./hub-store";

export interface HubPostReviewGateway extends HubReviewGateway {
  findNotification(guildId: string, target: NotificationTarget, nonce: string, buttonId: string,
    attemptedAt: number): Promise<NotificationReference | false | "unknown">;
}

const reasons: Record<string, string> = {
  uncertain: "応募か続報かを確信を持って判断できません。",
  no_choice: "題名または続報の宛先を決められません。",
  missing_metadata: "投稿の情報が不足しています。",
  too_many_choices: "候補が多く、題名または続報の宛先を決められません。",
  title_unextracted: "題名を読み取れません。",
  date_missing: "開催日が決まりません。",
  date_ambiguous: "開催日の候補が複数あります。",
  date_unmatched: "該当する開催日が見つかりません。",
  date_conflict: "続報の開催日が元の応募と一致しません。",
  refetch_failed: "元の投稿を取り直せません。",
  retry_exhausted: "再試行を重ねても処理できません。",
  multiple_communities: "登録先の集会を決められません。",
  hub_create_unconfirmed: "Hub に下書きが登録されたか確認できません。",
};
const text = (content: string): HubView => ({ content, controls: [] });
const targetKey = (target: NotificationTarget) => target.type === "dm" ? `dm:${target.userId}` : `channel:${target.channelId}`;
// 別宛先への再送を Discord の送信者単位の nonce 重複排除で捨てない。
const notificationNonce = (id: string, target: NotificationTarget) => createHash("sha256")
  .update(`post-review:${id}:${targetKey(target)}`).digest("hex").slice(0, 24);

/** 本文を持たない確認待ちを、投稿ごとに一度だけ通知する。 */
export class HubPostReview {
  private readonly editing = new Set<string>();
  constructor(
    private readonly gateway: HubPostReviewGateway,
    private readonly settings: HubStore,
    private readonly extracted: ExtractionStore,
    private readonly hub: Pick<HubApi, "communities" | "registrationUrl">,
    private readonly log: (event: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  private target(post: PendingPost): HubSetting | undefined {
    const { source } = post;
    const match = /^https:\/\/discord\.com\/channels\/([0-9]{1,20})\/([0-9]{1,20})\/([0-9]{1,20})$/.exec(source.url);
    if (!match || match[2] !== source.channelId || match[3] !== source.messageId) return;
    const recorded = this.extracted.reviewNotification(source.messageId);
    if (recorded?.closed) return;
    return this.settings.messageSettings(source.channelId, source.messageId, true).find(s => s.guildId === match[1]
      && (!post.meetingId || String(s.community.id) === post.meetingId)
      && (!recorded?.notified || (s.guildId === recorded.guild_id && s.community.id === recorded.community_id)));
  }

  count(guildId?: string, communityId?: number): number {
    return this.extracted.reviewPosts().filter(post => {
      const setting = this.target(post);
      return setting && (guildId === undefined || setting.guildId === guildId)
        && (communityId === undefined || setting.community.id === communityId);
    }).length;
  }

  unknownNotificationCount(): number {
    return this.extracted.unknownReviewNotificationCount();
  }

  rejectedNotifications() {
    return this.extracted.rejectedReviewNotifications();
  }

  private async updateNotifications(id?: string): Promise<void> {
    for (const pending of this.extracted.dueReviewNotificationEdits(this.now(), id)) {
      const key = `${pending.channel_id}:${pending.message_id}`;
      if (this.editing.has(key)) continue;
      this.editing.add(key);
      try {
        const name = discordText(pending.reviewer_display_name);
        await this.gateway.editNotification({ channelId: pending.channel_id, messageId: pending.message_id },
          `無視${name ? `（${name}）` : ""}`, true);
        this.extracted.reviewNotificationEdited(pending);
        this.log("hub_post_review_notification_edited");
      } catch (error) {
        const { code, status } = error && typeof error === "object"
          ? error as { code?: unknown; status?: unknown } : {};
        const reason = code === 10008 ? "unknown_message" : code === 10003 ? "unknown_channel"
          : status === 404 ? "not_found" : undefined;
        if (reason) {
          this.extracted.closeReviewNotificationEdit(pending, reason);
          this.log(`hub_post_review_notification_${reason}`);
        } else {
          const forbidden = status === 403 || code === 50001 || code === 50013;
          this.extracted.retryReviewNotificationEdit(pending, this.now(), forbidden);
          this.log(forbidden ? "hub_post_review_notification_forbidden" : "hub_post_review_notification_retry");
        }
      } finally { this.editing.delete(key); }
    }
  }

  async flush(): Promise<void> {
    await this.updateNotifications();
    for (const post of this.extracted.reviewPosts()) {
      const recorded = this.extracted.reviewNotification(post.source.messageId);
      if (recorded?.notified || recorded?.closed) continue;
      if (recorded && recorded.reconcile_next_at > this.now()) continue;
      try {
        const buttonId = `hub-review:${post.source.messageId}:ignore`;
        let inaccessibleTarget: NotificationTarget | undefined;
        if (recorded?.sending) {
          const oldTarget = JSON.parse(recorded.notification) as NotificationTarget;
          let found: NotificationReference | false | "unknown";
          try {
            // 旧形式の nonce で送信した通知も、変わらないボタン ID で見つかる。
            found = await this.gateway.findNotification(recorded.guild_id, oldTarget,
              notificationNonce(post.source.messageId, oldTarget), buttonId, recorded.attempted_at);
          } catch (error) {
            // 一時障害は再送の根拠にならない。旧宛先が恒久的に読めない時だけ別宛先を許可する。
            if (!notificationTargetUnavailable(error)) {
              this.extracted.deferReviewNotification(post.source.messageId, this.now());
              this.log("hub_post_review_notification_unknown");
              throw error;
            }
            inaccessibleTarget = oldTarget;
            found = "unknown";
          }
          if (typeof found === "object") {
            this.extracted.markReviewNotified(post.source.messageId, found);
            this.log("hub_post_review_notification_recovered");
            continue;
          }
          if (found === "unknown") {
            this.log("hub_post_review_notification_unknown");
            this.extracted.deferReviewNotification(post.source.messageId, this.now());
            if (!inaccessibleTarget) continue;
          } else this.extracted.clearReviewNotificationDelay(post.source.messageId);
        }
        const setting = this.target(post);
        if (!setting) continue;
        if (inaccessibleTarget && targetKey(inaccessibleTarget) === targetKey(setting.notification)) {
          continue;
        }
        if (recorded?.send_outcome === "rejected"
          && targetKey(JSON.parse(recorded.notification) as NotificationTarget) === targetKey(setting.notification)) continue;
        const view: HubView = {
          content: `確認が必要な投稿があります。\n${/^[0-9]{17,20}$/.test(post.authorId) ? `投稿者：<@${post.authorId}>\n` : ""}${post.source.url}\n理由：${reasons[post.reason] ?? "自動で処理できないため確認が必要です。"}`,
          controls: [{ type: "buttons", buttons: [
            { url: this.hub.registrationUrl(setting.community.id), label: "Hub で登録する" },
            { id: buttonId, label: "無視する" },
          ] }],
        };
        this.extracted.reserveReviewNotification(post.source.messageId, setting.guildId, setting.community.id, setting.notification);
        let reference: NotificationReference;
        try {
          reference = await this.gateway.notify(setting.guildId, setting.notification, view, notificationNonce(post.source.messageId, setting.notification));
        } catch (error) {
          if (notificationTargetUnavailable(error)) {
            this.extracted.markReviewNotificationRejected(post.source.messageId);
            this.log("hub_post_review_notification_rejected");
          } else this.log("hub_post_review_notification_unknown");
          throw error;
        }
        this.extracted.markReviewNotified(post.source.messageId, reference);
        this.log("hub_post_review_notified");
      } catch { this.log("hub_post_review_notification_failed"); }
    }
  }

  async handle(i: HubInteraction): Promise<void> {
    try {
      await i.defer();
      const match = /^hub-review:([0-9]{1,20}):ignore$/.exec(i.action);
      const id = match?.[1];
      const post = id ? this.extracted.pending(id) : undefined;
      const setting = post?.state === "review" ? this.target(post) : undefined;
      if (!id || !setting || !this.extracted.reviewNotification(id)?.notified
        || (i.guildId !== null && i.guildId !== setting.guildId)) {
        await i.edit(text("この確認待ちは処理済みか、設定が変更されています。/hub status で確認してください。")); return;
      }
      const communities = await this.hub.communities(i.userId);
      if (!communities.some(c => c.id === setting.community.id && (c.role === "owner" || c.role === "staff"))) {
        await i.edit(text("この投稿を無視できる主催・スタッフではありません。")); return;
      }
      // 権限の照会中に設定や保留が変わっていないことも確かめる。
      const current = this.extracted.pending(id);
      const target = current?.state === "review" ? this.target(current) : undefined;
      if (!target || target.guildId !== setting.guildId || target.community.id !== setting.community.id) {
        await i.edit(text("この確認待ちは処理済みか、設定が変更されています。/hub status で確認してください。")); return;
      }
      if (i.notification) this.extracted.reviewNotificationReference(id, i.notification);
      if (!this.extracted.closeReview(id, i.userDisplayName)) {
        await i.edit(text("この確認待ちは処理済みか、設定が変更されています。/hub status で確認してください。")); return;
      }
      this.log("hub_post_review_ignored");
      await this.updateNotifications(id);
      await i.edit(text("この投稿の確認待ちを閉じました。"));
    } catch {
      this.log("hub_post_review_ignore_failed");
      try { await i.edit(text("権限や接続を確認できません。しばらく待ってから押し直してください。")); } catch { /* 本文や SDK の例外は残さない。 */ }
    }
  }
}
