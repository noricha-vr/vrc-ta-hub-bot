import { createHash } from "node:crypto";
import type { HubApi } from "./hub-api";
import type { ExtractionStore, PendingPost } from "./extraction-store";
import type { HubReviewGateway } from "./hub-review";
import type { HubInteraction, HubView } from "./hub-setup";
import type { HubSetting, HubStore, NotificationTarget } from "./hub-store";

export interface HubPostReviewGateway extends HubReviewGateway {
  findNotification(guildId: string, target: NotificationTarget, nonce: string, buttonId: string): Promise<boolean>;
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

/** 本文を持たない確認待ちを、投稿ごとに一度だけ通知する。 */
export class HubPostReview {
  constructor(
    private readonly gateway: HubPostReviewGateway,
    private readonly settings: HubStore,
    private readonly extracted: ExtractionStore,
    private readonly hub: Pick<HubApi, "communities" | "registrationUrl">,
    private readonly log: (event: string) => void = () => {},
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

  async flush(): Promise<void> {
    for (const post of this.extracted.reviewPosts()) {
      const recorded = this.extracted.reviewNotification(post.source.messageId);
      if (recorded?.notified || recorded?.closed) continue;
      try {
        const nonce = createHash("sha256").update(`post-review:${post.source.messageId}`).digest("hex").slice(0, 24);
        const buttonId = `hub-review:${post.source.messageId}:ignore`;
        // 設定が変わっても、送信した可能性のある旧宛先を先に確認する。
        // 履歴の取得失敗は未送信の証拠にならないため、再送せず次の周期で照合する。
        if (recorded?.sending && await this.gateway.findNotification(recorded.guild_id,
          JSON.parse(recorded.notification) as NotificationTarget, nonce, buttonId)) {
          this.extracted.markReviewNotified(post.source.messageId);
          this.log("hub_post_review_notification_recovered");
          continue;
        }
        const setting = this.target(post);
        if (!setting) continue;
        const view: HubView = {
          content: `${post.source.url}\n理由：${reasons[post.reason] ?? "自動で処理できないため確認が必要です。"}`,
          controls: [{ type: "buttons", buttons: [
            { url: this.hub.registrationUrl(setting.community.id), label: "Hubで登録する" },
            { id: buttonId, label: "無視する" },
          ] }],
        };
        this.extracted.reserveReviewNotification(post.source.messageId, setting.guildId, setting.community.id, setting.notification);
        await this.gateway.notify(setting.guildId, setting.notification, view, nonce);
        this.extracted.markReviewNotified(post.source.messageId);
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
      if (!target || target.guildId !== setting.guildId || target.community.id !== setting.community.id
        || !this.extracted.closeReview(id)) {
        await i.edit(text("この確認待ちは処理済みか、設定が変更されています。/hub status で確認してください。")); return;
      }
      this.log("hub_post_review_ignored");
      await i.edit(text("この投稿の確認待ちを閉じました。"));
    } catch {
      this.log("hub_post_review_ignore_failed");
      try { await i.edit(text("権限や接続を確認できません。しばらく待ってから押し直してください。")); } catch { /* 本文や SDK の例外は残さない。 */ }
    }
  }
}
