import { extractMaterials, httpUrl, resolveEventDate, validEventDate } from "./extraction-fields";
import { type ExtractionStore, type PostReference, type SavedDraft } from "./extraction-store";
import type { GatewayMessage } from "./gateway";
import { JudgeError, validAnswer, type ChoiceAnswer, type ChoiceQuestion, type Judge } from "./jev";
import type { MessageStore } from "./store";

export type MeetingDates = (meetingId: string) => readonly string[] | Promise<readonly string[]>;
export type ReviewReason = "uncertain" | "no_choice" | "missing_metadata" | "too_many_choices"
  | "date_missing" | "date_ambiguous" | "date_unmatched" | "date_conflict";
export type RetryReason = "judge_unavailable" | "dates_unavailable" | "store_unavailable";
export type ExtractionResult = SavedDraft
  | { status: "unrelated"; source: PostReference }
  | { status: "review"; reason: ReviewReason; question: "これは応募ですか"; source: PostReference }
  | { status: "retry"; reason: RetryReason; source: PostReference };

const classification: ChoiceQuestion = {
  type: "choice",
  instructions: "Classify this post as an LT application, a follow-up to an existing application, or unrelated, choosing none if uncertain.",
  criteria: {
    application: "A new application to give an LT talk",
    follow_up: "An update or materials for an existing LT application",
    unrelated: "Unrelated conversation or an announcement inviting applications",
    none: "Cannot determine",
  },
};

/** 候補を返す部品。ハブ登録・通知・受信処理への自動接続は行わない。 */
export class PostExtractor {
  private readonly totals: Record<ExtractionResult["status"], number> = {
    candidate: 0, duplicate: 0, review: 0, unrelated: 0, retry: 0,
  };

  constructor(
    private readonly judge: Judge,
    private readonly store: ExtractionStore,
    private readonly meetingDates: MeetingDates,
  ) {}

  /** 本文や秘密を含まない件数。返却 status と同じ分類で集計できる。 */
  counts(): Readonly<Record<ExtractionResult["status"], number>> { return { ...this.totals }; }

  async extract(meetingId: string, message: GatewayMessage): Promise<ExtractionResult> {
    const source: PostReference = {
      messageId: message.id, channelId: message.channelId, url: httpUrl(message.sourceUrl ?? "") ?? "",
    };
    const review = (reason: ReviewReason): ExtractionResult => ({ status: "review", reason, question: "これは応募ですか", source });
    let result: ExtractionResult;
    try {
      result = await this.run(meetingId, message, source, review);
    } catch {
      // DB 等の例外にも投稿本文・SQL・接続情報が含まれ得るので返さない。
      result = { status: "retry", reason: "store_unavailable", source };
    }
    this.totals[result.status]++;
    return result;
  }

  private async choose(content: string, name: string, question: ChoiceQuestion): Promise<ChoiceAnswer> {
    const answers = await this.judge.ask({ state: content, questions: { [name]: question } });
    const answer = answers[name];
    if (!validAnswer(answer, question.criteria)) throw new JudgeError("invalid_response");
    return answer;
  }

  private async dates(meetingId: string): Promise<readonly string[]> {
    const dates = await this.meetingDates(meetingId);
    if (!Array.isArray(dates) || dates.some(date => typeof date !== "string" || !validEventDate(date))) {
      throw new Error("Invalid meeting dates");
    }
    return dates;
  }

  private async run(
    meetingId: string, message: GatewayMessage, source: PostReference,
    review: (reason: ReviewReason) => ExtractionResult,
  ): Promise<ExtractionResult> {
    const prior = this.store.forMessage(message.id);
    if (prior) return { status: "duplicate", draft: prior };
    if (!meetingId.trim() || !message.authorDisplayName?.trim() || !source.url) return review("missing_metadata");
    const check = (answer: ChoiceAnswer): ExtractionResult | undefined => answer.confidence < 0.7
      ? review("uncertain") : answer.answer === "none" ? review("no_choice") : undefined;
    let category: ChoiceAnswer;
    try { category = await this.choose(message.content, "classification", classification); }
    catch { return { status: "retry", reason: "judge_unavailable", source }; }
    const held = check(category);
    if (held) return held;
    if (category.answer === "unrelated") return { status: "unrelated", source };

    const materials = extractMaterials(message.content, message.attachments);
    if (category.answer === "follow_up") {
      // 対象を投稿者の同じ集会の下書きに限定。API に渡す既存情報は ID だけ。
      const drafts = this.store.forPresenter(meetingId, message.authorId);
      if (drafts.length === 0) return review("no_choice");
      if (drafts.length > 99) return review("too_many_choices");
      const criteria = Object.fromEntries(drafts.map(draft => [draft.id, draft.id]));
      criteria.none = "No matching draft";
      let selected: ChoiceAnswer;
      try {
        selected = await this.choose(message.content, "draft", {
          type: "choice", instructions: "Select the existing draft ID this follow-up refers to, or none if uncertain.", criteria,
        });
      } catch { return { status: "retry", reason: "judge_unavailable", source }; }
      const heldDraft = check(selected);
      if (heldDraft) return heldDraft;
      const draft = drafts.find(item => item.id === selected.answer)!;
      let date = resolveEventDate(message.content, [], message.createdAt);
      // 日付のない資料の追記は可能。別日付への変更は自動で行わない。
      if (date.status !== "unresolved" || date.reason !== "missing") {
        try { date = resolveEventDate(message.content, await this.dates(meetingId), message.createdAt); }
        catch { return { status: "retry", reason: "dates_unavailable", source }; }
        if (date.status !== "resolved" || date.date !== draft.eventDate) return review("date_conflict");
      }
      return this.store.addFollowUp(draft.id, materials, source);
    }

    const lines = message.content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length === 0) return review("no_choice");
    if (lines.length > 99) return review("too_many_choices");
    const criteria = Object.fromEntries(lines.map((line, index) => [`line_${index + 1}`, line]));
    criteria.none = "No title line";
    let title: ChoiceAnswer;
    try {
      title = await this.choose(message.content, "title", {
        type: "choice", instructions: "Select the line that states the talk title, or none if absent or uncertain.", criteria,
      });
    } catch { return { status: "retry", reason: "judge_unavailable", source }; }
    const heldTitle = check(title);
    if (heldTitle) return heldTitle;
    let dates: readonly string[];
    try { dates = await this.dates(meetingId); }
    catch { return { status: "retry", reason: "dates_unavailable", source }; }
    const date = resolveEventDate(message.content, dates, message.createdAt);
    if (date.status === "unresolved") return review(`date_${date.reason}`);
    return this.store.create({
      meetingId, presenterId: message.authorId, presenterName: message.authorDisplayName,
      eventDate: date.date, title: criteria[title.answer]!, materials,
    }, source);
  }
}

/** 保存完了後だけ ack。retry の本文は既存 inbox の保持期限内で再処理する。 */
export async function processInboxMessage(
  extractor: PostExtractor, inbox: Pick<MessageStore, "ack">, meetingId: string, message: GatewayMessage,
): Promise<ExtractionResult> {
  const result = await extractor.extract(meetingId, message);
  if (result.status !== "retry") inbox.ack(message.channelId, message.id);
  return result;
}
