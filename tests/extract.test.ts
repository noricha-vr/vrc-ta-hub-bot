import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostExtractor, processInboxMessage, type MeetingDates } from "../src/extract";
import { extractMaterials, resolveEventDate } from "../src/extraction-fields";
import { ExtractionStore } from "../src/extraction-store";
import type { GatewayMessage } from "../src/gateway";
import type { ChoiceAnswer, Judge, JudgeRequest } from "../src/jev";
import { JevJudge } from "../src/jev";
import { MessageStore } from "../src/store";
import { message } from "./fake-gateway";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

class FixedJudge implements Judge {
  readonly requests: JudgeRequest[] = [];
  readonly replies: Array<ChoiceAnswer | Error> = [];
  async ask(request: JudgeRequest): Promise<Record<string, ChoiceAnswer>> {
    this.requests.push(request);
    const reply = this.replies.shift();
    if (!reply) throw new Error("No fixed answer supplied");
    if (reply instanceof Error) throw reply;
    return { [Object.keys(request.questions)[0]!]: reply };
  }
  answer(answer: string, confidence = 0.95): void { this.replies.push({ answer, confidence }); }
}

function fixture(dates: MeetingDates = async () => ["2026-10-23", "2026-11-06"]) {
  const dir = mkdtempSync(join(tmpdir(), "extract-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "drafts.sqlite");
  const store = new ExtractionStore(path);
  const inbox = new MessageStore(join(dir, "inbox.sqlite"));
  cleanups.push(() => { store.close(); inbox.close(); });
  const judge = new FixedJudge();
  return { dir, path, store, inbox, judge, extractor: new PostExtractor(judge, store, dates) };
}

const post = (id = "100", content = "10/23 の LT に応募します\n題名: 型の話\nスライド https://example.invalid/slides/type"): GatewayMessage => ({
  ...message(id), content, createdAt: "2026-10-19T00:00:00Z", authorDisplayName: "発表者の表示名",
  sourceUrl: `https://example.invalid/posts/${id}`,
});

test("応募から表示名・選択された題名行・開催日・資料・出典を下書きにし、本文を ack する", async () => {
  const f = fixture();
  const item = { ...post(), attachments: [{ name: "handout.pdf", url: "https://example.invalid/handout.pdf" }] };
  f.inbox.save(item);
  f.judge.answer("application");
  f.judge.answer("line_2");
  const result = await processInboxMessage(f.extractor, f.inbox, "meeting-1", item);
  expect(result.status).toBe("candidate");
  if (result.status !== "candidate") throw new Error("Expected a candidate");
  expect(result.action).toBe("created");
  expect(result.draft).toMatchObject({
    presenterId: "20", presenterName: "発表者の表示名", title: "題名: 型の話", eventDate: "2026-10-23",
    materials: [{ kind: "slides", url: "https://example.invalid/slides/type" }, { kind: "pdf", url: "https://example.invalid/handout.pdf" }],
    sources: [{ messageId: "100", channelId: "10", url: item.sourceUrl }],
  });
  expect(f.inbox.messages("10")).toEqual([]);
  expect(f.store.counts()).toEqual({ drafts: 1, sourcePosts: 1 });
  expect(f.extractor.counts()).toEqual({ candidate: 1, duplicate: 0, review: 0, unrelated: 0, retry: 0 });
  for (const request of f.judge.requests) {
    expect(request.state).toBe(item.content);
    expect(JSON.stringify(request)).not.toContain(item.authorDisplayName);
    expect(JSON.stringify(request)).not.toContain("handout.pdf");
    expect(JSON.stringify(request)).not.toContain(item.sourceUrl);
    for (const question of Object.values(request.questions)) expect(question.criteria).toHaveProperty("none");
  }
  const reopened = new ExtractionStore(f.path);
  try { expect(reopened.forMessage(item.id)).toEqual(result.draft); } finally { reopened.close(); }
});

test("続報は同じ投稿者の下書き ID を選び、資料を追加して題名を保持する", async () => {
  const f = fixture();
  f.judge.answer("application"); f.judge.answer("line_2");
  const initial = await f.extractor.extract("meeting-1", post());
  if (initial.status !== "candidate") throw new Error("Expected a candidate");
  // 他の発表者・集会の情報を選択肢に含めない。
  f.store.create({ ...initial.draft, presenterId: "other" }, { messageId: "900", channelId: "10", url: "https://example.invalid/900" });
  f.store.create({ ...initial.draft, meetingId: "other" }, { messageId: "901", channelId: "10", url: "https://example.invalid/901" });
  f.judge.answer("follow_up"); f.judge.answer(initial.draft.id);
  const update = post("101", "資料を追加します https://example.invalid/extra.pdf");
  const result = await f.extractor.extract("meeting-1", update);
  expect(result.status).toBe("candidate");
  if (result.status !== "candidate") throw new Error("Expected an update");
  expect(result.action).toBe("updated");
  expect(result.draft.id).toBe(initial.draft.id);
  expect(result.draft.title).toBe(initial.draft.title);
  expect(result.draft.materials).toHaveLength(2);
  expect(result.draft.sources).toHaveLength(2);
  expect(f.judge.requests.at(-1)).toEqual({
    state: update.content,
    questions: { draft: {
      type: "choice", instructions: "Select the existing draft ID this follow-up refers to, or none if uncertain.",
      criteria: { [initial.draft.id]: initial.draft.id, none: "No matching draft" },
    } },
  });
  const calls = f.judge.requests.length;
  expect((await f.extractor.extract("meeting-1", update)).status).toBe("duplicate");
  expect(f.judge.requests).toHaveLength(calls);
});

test("雑談は関係なしとして返し、下書きも日付問い合わせも行わない", async () => {
  const f = fixture(async () => { throw new Error("Dates must not be requested"); });
  const item = post("100", "今日はいい天気ですね");
  f.judge.answer("unrelated");
  f.inbox.save(item);
  expect((await processInboxMessage(f.extractor, f.inbox, "meeting-1", item)).status).toBe("unrelated");
  expect(f.store.counts().drafts).toBe(0);
  expect(f.inbox.messages("10")).toEqual([]);
  expect(f.judge.requests).toHaveLength(1);
});

for (const [answer, confidence, reason] of [["application", 0.699, "uncertain"], ["none", 1, "no_choice"], ["unrelated", 0.6, "uncertain"]] as const) {
  test(`${answer} / confidence ${confidence} は主催者への確認候補にする`, async () => {
    const f = fixture(); f.judge.answer(answer, confidence);
    expect(await f.extractor.extract("meeting-1", post())).toMatchObject({ status: "review", reason, question: "これは応募ですか" });
    expect(f.store.counts().drafts).toBe(0);
  });
}

for (const [answer, confidence] of [["none", 1], ["line_2", 0.69]] as const) {
  test(`題名 ${answer} / confidence ${confidence} で下書きを作らない`, async () => {
    const f = fixture(); f.judge.answer("application"); f.judge.answer(answer, confidence);
    expect((await f.extractor.extract("meeting-1", post())).status).toBe("review");
    expect(f.store.counts().drafts).toBe(0);
  });
}

test("confidence 0.7 は採用し、再開後も同一投稿と発表者＋開催日の重複を止める", async () => {
  const f = fixture(); f.judge.answer("application", 0.7); f.judge.answer("line_2", 0.7);
  const created = await f.extractor.extract("meeting-1", post());
  expect(created.status).toBe("candidate");
  const reopened = new ExtractionStore(f.path);
  try {
    const extractor = new PostExtractor(f.judge, reopened, async () => ["2026-10-23"]);
    expect((await extractor.extract("meeting-1", post())).status).toBe("duplicate");
    expect(f.judge.requests).toHaveLength(2);
    f.judge.answer("application"); f.judge.answer("line_2");
    expect((await extractor.extract("meeting-1", { ...post("102"), authorDisplayName: "変更後の表示名" })).status).toBe("duplicate");
    expect(reopened.counts()).toEqual({ drafts: 1, sourcePosts: 2 });
  } finally { reopened.close(); }
});

test("別開催日の応募と別発表者の応募は独立した候補にする", async () => {
  const f = fixture();
  for (const item of [post(), post("101", "11/6 に応募\n別の題名"), { ...post("102"), authorId: "21" }]) {
    f.judge.answer("application"); f.judge.answer("line_2");
    expect((await f.extractor.extract("meeting-1", item)).status).toBe("candidate");
  }
  expect(f.store.counts().drafts).toBe(3);
});

test("同時に処理する同じ発表はトランザクションで一件だけ作る", async () => {
  const f = fixture();
  f.judge.answer("application"); f.judge.answer("application"); f.judge.answer("line_2"); f.judge.answer("line_2");
  const results = await Promise.all([f.extractor.extract("meeting-1", post()), f.extractor.extract("meeting-1", post("101"))]);
  expect(results.map(result => result.status).sort()).toEqual(["candidate", "duplicate"]);
  expect(f.store.counts()).toEqual({ drafts: 1, sourcePosts: 2 });
});

test("判定 API の失敗は本文を返さず retry にし、inbox を残して再試行できる", async () => {
  const f = fixture(); const item = post(); f.inbox.save(item);
  f.judge.replies.push(new Error(`sensitive: ${item.content}`));
  const retry = await processInboxMessage(f.extractor, f.inbox, "meeting-1", item);
  expect(retry).toMatchObject({ status: "retry", reason: "judge_unavailable" });
  expect(JSON.stringify(retry)).not.toContain(item.content);
  expect(f.inbox.messages("10")).toEqual([item]);
  f.judge.answer("application"); f.judge.answer("line_2");
  expect((await processInboxMessage(f.extractor, f.inbox, "meeting-1", item)).status).toBe("candidate");
  expect(f.inbox.messages("10")).toEqual([]);
});

for (const failure of ["timeout", "5xx"] as const) {
  test(`偽 HTTP の ${failure} でも inbox と再試行用の出典を保つ`, async () => {
    const f = fixture(); const item = post(); f.inbox.save(item);
    const judge = new JevJudge("test-placeholder", async () => failure === "5xx"
      ? new Response("sensitive failure", { status: 503 }) : new Promise<Response>(() => {}), 5);
    const extractor = new PostExtractor(judge, f.store, () => ["2026-10-23"]);
    expect(await processInboxMessage(extractor, f.inbox, "meeting-1", item)).toEqual({
      status: "retry", reason: "judge_unavailable",
      source: { messageId: item.id, channelId: item.channelId, url: item.sourceUrl! },
    });
    expect(f.inbox.messages("10")).toEqual([item]);
    expect(f.store.counts().drafts).toBe(0);
  });
}

test("題名の判定失敗・不正回答・日付取得失敗も retry にする", async () => {
  const f = fixture(async () => { throw new Error("private error"); });
  f.judge.answer("application"); f.judge.replies.push(new Error("private error"));
  expect(await f.extractor.extract("meeting-1", post())).toMatchObject({ status: "retry", reason: "judge_unavailable" });
  f.judge.answer("out_of_choices");
  expect(await f.extractor.extract("meeting-1", post())).toMatchObject({ status: "retry", reason: "judge_unavailable" });
  f.judge.answer("application"); f.judge.answer("line_2");
  expect(await f.extractor.extract("meeting-1", post())).toMatchObject({ status: "retry", reason: "dates_unavailable" });
});

test("日付不明・不一致・複数候補では下書きにしない", async () => {
  const f = fixture();
  for (const [content, reason] of [["応募します\n型の話", "date_missing"], ["10/24 応募\n型の話", "date_unmatched"], ["10/23 または 11/6 に応募\n型の話", "date_ambiguous"]] as const) {
    f.judge.answer("application"); f.judge.answer("line_2");
    expect(await f.extractor.extract("meeting-1", post("100", content))).toMatchObject({ status: "review", reason });
  }
  expect(f.store.counts().drafts).toBe(0);
});

test("続報の none・低信頼度・不正な ID・日付の変更は既存下書きを変えない", async () => {
  const f = fixture(); f.judge.answer("application"); f.judge.answer("line_2");
  const initial = await f.extractor.extract("meeting-1", post());
  if (initial.status !== "candidate") throw new Error("Expected candidate");
  for (const [answer, confidence, status] of [["none", 1, "review"], [initial.draft.id, 0.69, "review"], ["other-id", 1, "retry"]] as const) {
    f.judge.answer("follow_up"); f.judge.answer(answer, confidence);
    expect((await f.extractor.extract("meeting-1", post("101", "資料を更新します"))).status).toBe(status);
  }
  f.judge.answer("follow_up"); f.judge.answer(initial.draft.id);
  expect(await f.extractor.extract("meeting-1", post("101", "11/6 に変更します"))).toMatchObject({ status: "review", reason: "date_conflict" });
  expect(f.store.get(initial.draft.id)).toEqual(initial.draft);
});

test("続報の次回は全開催日から解決し、選んだ下書きと開催日が違えば保留する", async () => {
  const f = fixture(); f.judge.answer("application"); f.judge.answer("line_2");
  const later = await f.extractor.extract("meeting-1", post("100", "11/6 の応募です\n型の話"));
  if (later.status !== "candidate") throw new Error("Expected candidate");
  f.judge.answer("follow_up"); f.judge.answer(later.draft.id);
  expect(await f.extractor.extract("meeting-1", post("101", "次回の資料です"))).toMatchObject({ status: "review", reason: "date_conflict" });
  expect(f.store.get(later.draft.id)).toEqual(later.draft);
});

test("複数の下書きから選んだ ID だけに続報を反映する", async () => {
  const f = fixture();
  for (const item of [post(), post("101", "11/6 に応募\n別の題名")]) {
    f.judge.answer("application"); f.judge.answer("line_2");
    await f.extractor.extract("meeting-1", item);
  }
  const drafts = f.store.forPresenter("meeting-1", "20");
  f.judge.answer("follow_up"); f.judge.answer(drafts[1]!.id);
  const result = await f.extractor.extract("meeting-1", post("102", "11/6 の資料 https://example.invalid/later.pdf"));
  expect(result.status).toBe("candidate");
  expect(f.store.get(drafts[0]!.id)).toEqual(drafts[0]);
  expect(f.store.get(drafts[1]!.id)?.materials).toContainEqual({ kind: "pdf", url: "https://example.invalid/later.pdf" });
});

test("選択肢が多すぎる投稿は切り捨てず保留し、不正な開催日は retry にする", async () => {
  const f = fixture(async () => ["2026-02-30"]);
  f.judge.answer("application");
  expect(await f.extractor.extract("meeting-1", post("100", Array.from({ length: 100 }, (_, i) => `行 ${i}`).join("\n"))))
    .toMatchObject({ status: "review", reason: "too_many_choices" });
  f.judge.answer("application"); f.judge.answer("line_2");
  expect(await f.extractor.extract("meeting-1", post())).toMatchObject({ status: "retry", reason: "dates_unavailable" });
});

test("表示名・出典がない旧 inbox と対象下書きのない続報は主催者に確認する", async () => {
  const f = fixture();
  expect(await f.extractor.extract("meeting-1", message(100))).toMatchObject({ status: "review", reason: "missing_metadata" });
  expect(f.judge.requests).toHaveLength(0);
  f.judge.answer("follow_up");
  expect(await f.extractor.extract("meeting-1", post())).toMatchObject({ status: "review", reason: "no_choice" });
});

test("永続化するのは選択した項目と出典だけで、残りの本文は DB と WAL にない", async () => {
  const f = fixture();
  const marker = "UNSELECTED-POST-BODY-49b42e";
  const item = post("100", `10/23 に応募します\n型の話\n${marker}`);
  f.inbox.save(item); f.judge.answer("application"); f.judge.answer("line_2");
  const result = await processInboxMessage(f.extractor, f.inbox, "meeting-1", item);
  expect(result.status).toBe("candidate");
  expect(JSON.stringify(result)).not.toContain(marker);
  for (const name of ["drafts.sqlite", "inbox.sqlite"]) for (const suffix of ["", "-wal"]) {
    const path = join(f.dir, `${name}${suffix}`);
    if (existsSync(path)) expect(readFileSync(path).includes(Buffer.from(marker))).toBe(false);
  }
});

test("保存に失敗した候補は retry にし、ack しない", async () => {
  const f = fixture(); const item = post(); f.inbox.save(item);
  f.store.create = () => { throw new Error(item.content); };
  f.judge.answer("application"); f.judge.answer("line_2");
  expect(await processInboxMessage(f.extractor, f.inbox, "meeting-1", item)).toMatchObject({ status: "retry", reason: "store_unavailable" });
  expect(f.inbox.messages("10")).toEqual([item]);
});

test("URL と PDF 添付を抽出し、重複・資格情報付き URL・無関係なリンクを除く", () => {
  expect(extractMaterials(
    "スライド [資料](https://example.invalid/presentation/123)。\nPDF https://example.invalid/file.pdf?dl=1\nhttps://example.invalid/home\nスライド https://user:pass@example.invalid/slides/private",
    [{ name: "file.pdf", url: "https://example.invalid/file.pdf?dl=1" }, { name: "file", contentType: "application/pdf", url: "https://example.invalid/download" }, { name: "image.png", url: "https://example.invalid/image.png" }],
  )).toEqual([
    { kind: "slides", url: "https://example.invalid/presentation/123" },
    { kind: "pdf", url: "https://example.invalid/file.pdf?dl=1" },
    { kind: "pdf", url: "https://example.invalid/download" },
  ]);
});

test("日付は日本時間・年越し・次回・明示年を考慮し、URL 中の日付と不正な日は使わない", () => {
  const dates = ["2027-01-08", "2026-12-31", "2026-12-25"];
  const createdAt = "2026-12-30T15:01:00Z";
  for (const [text, date] of [["次回に応募", "2026-12-31"], ["1/8 に応募", "2027-01-08"], ["2027年1月8日", "2027-01-08"], ["2027-01-08", "2027-01-08"], ["2027/1/8", "2027-01-08"]]) {
    expect(resolveEventDate(text!, dates, createdAt)).toEqual({ status: "resolved", date: date! });
  }
  expect(resolveEventDate("12/25", dates, createdAt)).toEqual({ status: "unresolved", reason: "unmatched" });
  expect(resolveEventDate("https://example.invalid/1/8", dates, createdAt)).toEqual({ status: "unresolved", reason: "missing" });
  expect(resolveEventDate("2/30", ["2027-02-30"], createdAt)).toEqual({ status: "unresolved", reason: "unmatched" });
});
