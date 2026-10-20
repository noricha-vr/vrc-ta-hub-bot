import { createHash } from "node:crypto";
import { HubApiError, type HubDetailFields, type HubReviewApi } from "./hub-api";
import { HubDeliveryStore, type HubDelivery, type HubReviewDecision } from "./hub-delivery-store";
import { httpUrl } from "./extraction-fields";
import type { ExtractionStore, TalkDraft } from "./extraction-store";
import type { HubSetting, HubStore, NotificationTarget } from "./hub-store";
import type { HubInteraction, HubView } from "./hub-setup";

export interface HubReviewGateway {
  notify(guildId: string, target: NotificationTarget, view: HubView, nonce: string): Promise<void>;
}
const text = (content: string): HubView => ({ content, controls: [] });
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const html = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const discordText = (value: string) => value.replace(/[\r\n]/g, " ").replace(/@/g, "＠").replace(/[\\[\]()*_~`|>#<>]/g, "\\$&");

/** SQLite を正本に、同じ下書きの送信・更新・レビューを直列化する。 */
export class HubReview {
  private active: Promise<void> | undefined;
  private readonly busy = new Map<string, Promise<void>>();
  private readonly sending = new Map<string, string>();
  constructor(
    private readonly gateway: HubReviewGateway,
    private readonly settings: HubStore,
    private readonly extracted: ExtractionStore,
    readonly deliveries: HubDeliveryStore,
    private readonly hub: HubReviewApi,
    private readonly log: (event: string) => void = () => {},
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  private setting(row: HubDelivery): HubSetting | undefined {
    const draft = this.extracted.get(row.draft_id);
    if (draft?.meetingId !== String(row.community_id)) return;
    return this.draftSetting(draft, row.guild_id);
  }

  private draftSetting(draft: TalkDraft, guildId?: string): HubSetting | undefined {
    for (const source of draft.sources) {
      const match = /^https:\/\/discord\.com\/channels\/([0-9]{1,20})\/([0-9]{1,20})\/([0-9]{1,20})$/.exec(source.url);
      if (!match || source.channelId !== match[2] || source.messageId !== match[3] || (guildId && guildId !== match[1])) continue;
      const setting = this.settings.messageSettings(source.channelId, source.messageId)
        .find(s => s.guildId === match[1] && String(s.community.id) === draft.meetingId);
      if (setting) return setting;
    }
  }

  /** 抽出保存と enqueue の間で停止しても、抽出済み項目から復旧する。 */
  private enqueue(): void {
    for (const draft of this.extracted.allDrafts()) {
      const setting = this.draftSetting(draft);
      if (!setting) continue;
      const previous = this.deliveries.get(draft.id);
      this.deliveries.enqueue(draft.id, setting.guildId, setting.community.id);
      if (previous?.state === "closed" && previous.reason === "setting_removed" && previous.hub_id) {
        this.recordDraft(this.deliveries.get(draft.id)!, draft, previous.hub_id, false);
      }
    }
  }

  flush(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.run().finally(() => { this.active = undefined; });
    return this.active;
  }
  pendingReviews(guildId?: string, communityId?: number) {
    return this.deliveries.pendingReviews(this.now(), guildId, communityId);
  }
  private async lock(id: string): Promise<() => void> {
    const previous = this.busy.get(id);
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.busy.set(id, current);
    await previous;
    return () => {
      if (this.busy.get(id) === current) this.busy.delete(id);
      release();
    };
  }
  private async run(): Promise<void> {
    this.enqueue();
    for (const row of this.deliveries.due(this.now())) {
      if (this.busy.has(row.draft_id) || !this.setting(row)) continue;
      const unlock = await this.lock(row.draft_id);
      try { await this.deliver(row.draft_id); }
      catch {
        this.deliveries.retry(row.draft_id, this.now(), "hub_delivery_failed");
        this.log("hub_delivery_retry");
      } finally { unlock(); }
    }
    for (const pending of this.deliveries.dueDecisions(this.now())) {
      const row = this.deliveries.get(pending.draft_id);
      if (!row?.hub_id || row.state === "closed" || this.busy.has(row.draft_id) || !this.setting(row)) continue;
      const unlock = await this.lock(row.draft_id);
      try {
        const current = this.deliveries.get(row.draft_id);
        if (!current?.hub_id || current.state === "closed" || !this.setting(current)) continue;
        const decision = this.deliveries.decision(row.draft_id, pending.discord_id);
        if (!decision || decision.next_at > this.now()) continue;
        await this.submitDecision(current, decision);
      }
      catch {
        this.deliveries.retryDecision(row.draft_id, pending.discord_id, this.now());
        this.log("hub_review_retry");
      } finally { unlock(); }
    }
  }

  private fields(draft: TalkDraft, event: number): HubDetailFields {
    const materials = draft.materials.filter(m => httpUrl(m.url));
    return { event, detail_type: "LT", speaker: html(draft.presenterName), theme: html(draft.title),
      slide_url: materials[0]?.url ?? "", additional_info: materials.map(m => html(m.url)).join("\n") };
  }

  private async deliver(id: string): Promise<void> {
    let row = this.deliveries.get(id);
    if (!row || !this.setting(row)) return;
    if (row.state === "closed") { await this.syncClosed(id); return; }
    const draft = this.extracted.get(id);
    if (!draft) return;
    const hash = fingerprint(draft);
    if (row.state === "creating") {
      const found = await this.hub.findDraft(draft.sources[0]!.url);
      if (!found) {
        this.extracted.holdReview(draft.meetingId, draft.presenterId, draft.sources[0]!, "hub_create_unconfirmed", this.now());
        this.deliveries.retry(row.draft_id, this.now(), "hub_create_unconfirmed");
        this.log("hub_create_unconfirmed");
        return;
      }
      this.deliveries.created(row.draft_id, found.id, row.attempted_hash);
      if (this.extracted.pending(draft.sources[0]!.messageId)?.reason === "hub_create_unconfirmed") {
        this.extracted.clearPending(draft.sources[0]!.messageId);
      }
      this.recordDraft(row, draft, found.id, found.status === "approved");
      if (found.status && found.status !== "pending") {
        this.deliveries.closed(row.draft_id, found.status); return;
      }
      row = this.deliveries.get(row.draft_id)!;
    }
    if (row.state === "queued") {
      // 読み取りで疎通・対象イベントを確認してから POST を試みる。
      const events = (await this.hub.events(row.community_id)).filter(e => e.date === draft.eventDate);
      if (events.length !== 1 || !this.setting(row)) throw new HubApiError();
      const fields = this.fields(draft, events[0]!.id);
      this.deliveries.creating(row.draft_id, hash);
      let id: number;
      try { id = await this.hub.createDraft(fields, draft.sources[0]!.url); }
      catch (error) {
        // 処理前の拒否だけ再送する。保存された可能性があれば creating を残して照合する。
        if (error instanceof HubApiError && [400, 401, 403, 404, 422, 429].includes(error.status)) this.deliveries.requeue(row.draft_id);
        throw error;
      }
      this.deliveries.created(row.draft_id, id, hash);
      this.recordDraft(row, draft, id, false);
      this.log("hub_draft_created");
      row = this.deliveries.get(row.draft_id)!;
    } else if (row.synced_hash !== hash) {
      await this.sync(row, draft);
      row = this.deliveries.get(row.draft_id)!;
    }
    const setting = this.setting(row);
    if (!setting || row.state !== "ready") return;
    const notificationHash = fingerprint([row.synced_hash, setting.notification]);
    if (row.notified_hash !== notificationHash) {
      const view: HubView = {
        content: `承認待ちの発表があります。\n日付：${eventDateLabel(draft.eventDate)}\n発表者：${discordText(draft.presenterName).slice(0, 300)}\nテーマ：${discordText(draft.title).slice(0, 300)}\n${sourceFor(draft, setting.guildId)}`,
        controls: [{ type: "buttons", buttons: [
          { id: `hub-review:${row.draft_id}:approved`, label: "承認" },
          { url: this.hub.editUrl(row.hub_id!), label: "直す" },
          { id: `hub-review:${row.draft_id}:rejected`, label: "却下" },
        ] }],
      };
      await this.gateway.notify(setting.guildId, setting.notification, view, fingerprint([row.draft_id, notificationHash]).slice(0, 24));
      this.deliveries.notified(row.draft_id, notificationHash);
      this.log("hub_review_notified");
    }
  }

  private async sync(row: HubDelivery, draft: TalkDraft): Promise<void> {
    const hash = fingerprint(draft);
    if (row.synced_hash === hash) return;
    // 続報では題名や承認状態を上書きせず、資料だけ更新する。
    const fields = this.fields(draft, 0);
    await this.hub.updateDraft(row.hub_id!, { slide_url: fields.slide_url, additional_info: fields.additional_info });
    this.deliveries.synced(row.draft_id, hash);
    this.log("hub_draft_updated");
  }

  private recordDraft(row: HubDelivery, draft: TalkDraft, id: number, approved: boolean): void {
    if (this.setting(row)) this.settings.saveDraft({ id: String(id), guildId: row.guild_id, communityId: row.community_id,
      sourceUrl: draft.sources[0]!.url, createdAt: new Date(this.now() * 1000).toISOString(), approved });
  }

  private async finishDecision(row: HubDelivery, decision: "approved" | "rejected"): Promise<void> {
    const current = this.deliveries.get(row.draft_id);
    if (!current || current.state === "closed" || !this.setting(current)) return;
    const draft = this.extracted.get(current.draft_id)!;
    // 判断は資料の更新より先に確定し、更新の失敗で再送待ちに戻さない。
    this.recordDraft(current, draft, current.hub_id!, decision === "approved");
    this.deliveries.closed(current.draft_id, decision);
    try { await this.syncClosed(current.draft_id); }
    catch {
      this.deliveries.retry(current.draft_id, this.now(), "hub_delivery_failed");
      this.log("hub_delivery_retry");
    }
  }

  private async syncClosed(id: string): Promise<void> {
    for (;;) {
      const current = this.deliveries.get(id);
      if (!current?.hub_id || current.state !== "closed" || !["approved", "rejected"].includes(current.reason) || !this.setting(current)) return;
      const draft = this.extracted.get(id);
      if (!draft || current.synced_hash === fingerprint(draft)) return;
      await this.sync(current, draft);
    }
  }

  private async submitDecision(row: HubDelivery, pending: HubReviewDecision): Promise<"done" | "forbidden" | "processed" | "cancelled"> {
    this.sending.set(row.draft_id, pending.discord_id);
    try {
      await this.sync(row, this.extracted.get(row.draft_id)!);
      const current = this.deliveries.get(row.draft_id);
      const decision = this.deliveries.decision(row.draft_id, pending.discord_id);
      if (!current?.hub_id || current.state === "closed" || !this.setting(current) || !decision) return "cancelled";
      row = current; pending = decision;
      try { await this.hub.reviewDraft(row.hub_id!, pending.decision, pending.discord_id); }
      catch (error) {
        if (error instanceof HubApiError && error.status === 403) {
          this.deliveries.clearDecision(row.draft_id, pending.discord_id);
          this.log("hub_review_forbidden"); return "forbidden";
        }
        if (error instanceof HubApiError && [400, 401, 404, 422, 429].includes(error.status)) throw error;
        // 409 と成否不明の応答は、他の利用者の保留に関係なく現在状態を照合する。
        const draft = this.extracted.get(row.draft_id)!;
        const found = await this.hub.findDraft(draft.sources[0]!.url);
        if (found?.id !== row.hub_id || (found.status !== "approved" && found.status !== "rejected")) throw new HubApiError();
        await this.finishDecision(row, found.status);
        this.log("hub_review_already_processed"); return "processed";
      }
      this.deliveries.recordReviewer(row.draft_id, pending.discord_id);
      await this.finishDecision(row, pending.decision);
      this.log(pending.decision === "approved" ? "hub_review_approved" : "hub_review_rejected");
      return "done";
    } finally { this.sending.delete(row.draft_id); }
  }

  async handle(i: HubInteraction): Promise<void> {
    let unlock: (() => void) | undefined;
    try {
      await i.defer();
      const match = /^hub-review:([0-9a-f-]{36}):(approved|rejected)$/.exec(i.action);
      let row = match ? this.deliveries.get(match[1]!) : undefined;
      if (!row || !row.hub_id || (i.guildId !== null && i.guildId !== row.guild_id) || !this.setting(row)) {
        await i.edit(text("この通知は古くなりました。/hub status で現在の設定を確認してください。")); return;
      }
      if (row.state === "closed") { await i.edit(text("この発表はすでに処理済みです。Hub で現在の状態を確認してください。")); return; }
      if (this.sending.get(row.draft_id) === i.userId) {
        await i.edit(text("前の操作を送信中です。結果が出てから押し直してください")); return;
      }
      const decision = match![2] as "approved" | "rejected";
      const pending = this.deliveries.decision(row.draft_id, i.userId);
      if (!this.deliveries.queueDecision(row.draft_id, decision, i.userId, this.now())) {
        this.log("hub_review_queue_full");
        await i.edit(text("Hub に接続できません。復旧後にもう一度押してください")); return;
      }
      if (pending) {
        await i.edit(text(pending.decision !== decision
          ? `再送待ちの判断を${decision === "approved" ? "承認" : "却下"}に変更しました`
          : "この発表は処理中です。しばらく待ってから確認してください。")); return;
      }
      // 他人の送信中も本人の判断を保存し、同じ下書きへの操作を順番に送る。
      unlock = await this.lock(row.draft_id);
      row = this.deliveries.get(row.draft_id)!;
      if (row.state === "closed") { await i.edit(text("この発表はすでに処理済みです。Hub で現在の状態を確認してください。")); return; }
      if (!this.setting(row)) {
        await i.edit(text("この通知は古くなりました。/hub status で現在の設定を確認してください。")); return;
      }
      const current = this.deliveries.decision(row.draft_id, i.userId)!;
      let outcome: "done" | "forbidden" | "processed" | "cancelled";
      try {
        outcome = await this.submitDecision(row, current);
      } catch {
        this.deliveries.retryDecision(row.draft_id, i.userId, this.now());
        this.log("hub_review_retry");
        await i.edit(text("Hub に接続できません。操作を保存しました。復旧後に同じ操作を再送します。"));
        return;
      }
      await i.edit(text(outcome === "forbidden" ? "この発表を承認・却下できる主催者ではありません。"
        : outcome === "processed" ? "この発表はすでに処理済みです。Hub で現在の状態を確認してください。"
        : outcome === "cancelled" ? "この通知は古くなりました。/hub status で現在の設定を確認してください。"
        : current.decision === "approved" ? "承認しました。" : "却下しました。"));
    } catch {
      this.log("hub_review_failed");
      try { await i.edit(text("処理に失敗しました。しばらく待ってから確認してください。")); } catch { /* 生の SDK エラーは残さない。 */ }
    } finally { unlock?.(); }
  }
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** 開催日（YYYY-MM-DD）に曜日を添える。例: 2026-11-03(火) */
export function eventDateLabel(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(day.getTime()) ? discordText(date) : `${discordText(date)}(${WEEKDAYS[day.getUTCDay()]})`;
}

/** 通知先のサーバーの出典を優先する（別サーバーで設定し直した時に、見られない旧サーバーのリンクを出さない）。 */
export function sourceFor(draft: Pick<TalkDraft, "sources">, guildId: string): string {
  const prefix = `https://discord.com/channels/${guildId}/`;
  return [...draft.sources].reverse().find(source => source.url.startsWith(prefix))?.url ?? draft.sources.at(-1)!.url;
}
