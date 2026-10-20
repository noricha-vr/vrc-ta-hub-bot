import { PostExtractor, processDueRetries, processInboxMessage } from "./extract";
import type { ExtractionStore } from "./extraction-store";
import type { Gateway } from "./gateway";
import type { HubReviewApi } from "./hub-api";
import type { HubReview } from "./hub-review";
import type { HubStore } from "./hub-store";
import type { Judge } from "./jev";

/** 受信箱 → 抽出保存 → 送信待ち。外部通信中は SQLite のトランザクションを開かない。 */
export class HubPipeline {
  private active: Promise<void> | undefined;
  readonly extractor: PostExtractor;
  constructor(
    private readonly inbox: HubStore,
    extracted: ExtractionStore,
    private readonly gateway: Gateway,
    judge: Judge,
    hub: HubReviewApi,
    readonly review: HubReview,
    private readonly log: (event: string) => void = () => {},
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.extractor = new PostExtractor(judge, extracted,
      async meetingId => (await hub.events(Number(meetingId))).map(event => event.date));
  }
  run(channelReady: (channelId: string) => boolean = () => true): Promise<void> {
    if (this.active) return this.active;
    this.active = this.process(channelReady).finally(() => { this.active = undefined; });
    return this.active;
  }
  private async process(channelReady: (channelId: string) => boolean): Promise<void> {
    await this.review.flush();
    for (const channelId of this.inbox.channelIds()) {
      if (!channelReady(channelId)) continue;
      for (const message of this.inbox.messages(channelId)) {
        // 実行中に再接続が始まった場合も、補完が終わるまで新着を抽出しない。
        if (!channelReady(channelId)) break;
        const pending = this.extractor.store.pending(message.id);
        if (pending) {
          if (pending.state === "review") this.inbox.ack(channelId, message.id);
          continue;
        }
        const settings = this.inbox.messageSettings(channelId, message.id);
        if (!settings.length) continue;
        // 同じ投稿から複数集会へ自動で同じ下書きを登録しない。
        if (settings.length !== 1) {
          this.extractor.store.holdReview("", message.authorId, { messageId: message.id, channelId,
            url: message.sourceUrl ?? "" }, "multiple_communities", this.now(), message.authorDisplayName);
          this.inbox.ack(channelId, message.id);
          this.log("hub_extraction_ambiguous_community");
          continue;
        }
        await processInboxMessage(this.extractor, this.inbox, String(settings[0]!.community.id), message, this.now());
      }
    }
    await processDueRetries(this.extractor, this.inbox, this.gateway, this.now(), pending =>
      channelReady(pending.source.channelId) && this.inbox.messageSettings(pending.source.channelId, pending.source.messageId)
        .some(s => String(s.community.id) === pending.meetingId));
    await this.review.flush();
  }
}
