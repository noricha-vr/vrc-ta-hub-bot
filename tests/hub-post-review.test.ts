import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubBot } from "../src/bot";
import { ExtractionStore } from "../src/extraction-store";
import { HubApi, type HubCommunity } from "../src/hub-api";
import { HubDeliveryStore } from "../src/hub-delivery-store";
import { HubPipeline } from "../src/hub-pipeline";
import { HubPostReview } from "../src/hub-post-review";
import { HubReview } from "../src/hub-review";
import { HubSetup, type HubInteraction, type HubView } from "../src/hub-setup";
import { HubStore, type NotificationTarget } from "../src/hub-store";
import { discordHubView } from "../src/discord-hub";
import { FakeGateway, message } from "./fake-gateway";

const userId = "123456789012345678";
const community: HubCommunity = { id: 1, name: "集会", role: "owner", recording_allowed: true };
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture(notification: NotificationTarget = { type: "channel", channelId: "11" }) {
  const dir = mkdtempSync(join(tmpdir(), "hub-post-review-"));
  const path = join(dir, "state.sqlite");
  const settings = new HubStore(path);
  let extracted = new ExtractionStore(path);
  const deliveries = new HubDeliveryStore(path);
  const gateway = new FakeGateway();
  const notices: Array<{ guildId: string; target: NotificationTarget; view: HubView; nonce: string }> = [];
  const logs: string[] = [];
  let memberships: HubCommunity[] = [community];
  let failLookup = false;
  let failNotify = false;
  let beforeNotify: ((nonce: string) => void) | undefined;
  let failFind = false;
  const lookups: NotificationTarget[] = [];
  let beforeLookup: (() => Promise<void>) | undefined;
  const hub = new HubApi("https://example.invalid", "synthetic", async url => {
    if (url.pathname === "/api/v1/community-by-discord/") {
      await beforeLookup?.();
      if (failLookup) throw new Error("secret response body");
      return Response.json({ discord_id: url.searchParams.get("discord_id"), communities: memberships });
    }
    if (url.pathname === "/api/v1/event/") return Response.json([]);
    throw new Error("Unexpected fake Hub request");
  });
  const notifier = { findNotification: async (guildId: string, target: NotificationTarget, nonce: string) => {
    lookups.push(target);
    if (failFind) throw new Error("secret response body");
    return notices.some(n => n.guildId === guildId && JSON.stringify(n.target) === JSON.stringify(target) && n.nonce === nonce);
  }, notify: async (guildId: string, target: NotificationTarget, view: HubView, nonce: string) => {
    beforeNotify?.(nonce);
    if (failNotify) throw new Error("secret response body");
    notices.push({ guildId, target, view, nonce });
  } };
  const log = (event: string) => logs.push(event);
  const makeReview = () => new HubReview(notifier, settings, extracted, deliveries, hub, log, () => 1000,
    new HubPostReview(notifier, settings, extracted, hub, log));
  let review = makeReview();
  settings.configure({ guildId: "100", community, channelIds: ["10"], notification }, "100");
  const hold = (reason = "title_unextracted", id = "101", meetingId = "1", url = `https://discord.com/channels/100/10/${id}`) => {
    extracted.holdReview(meetingId, userId, { messageId: id, channelId: "10", url }, reason, 1000);
  };
  const act = async (id = "101", guildId: string | null = "100", actor = userId) => {
    const views: HubView[] = [];
    let deferred = false;
    await review.handle({ action: `hub-review:${id}:ignore`, guildId, userId: actor, kind: "component", values: [],
      defer: async () => { deferred = true; }, edit: async view => { expect(deferred).toBe(true); views.push(view); },
      followUp: async () => {} });
    return views[0]!.content;
  };
  cleanups.push(() => { extracted.close(); deliveries.close(); settings.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, path, settings, deliveries, gateway, hub, notices, logs, hold, act, lookups,
    get extracted() { return extracted; }, get review() { return review; },
    reopen: () => { extracted.close(); extracted = new ExtractionStore(path); review = makeReview(); },
    memberships: (value: HubCommunity[]) => { memberships = value; },
    failLookup: (value: boolean) => { failLookup = value; },
    failNotify: (value: boolean) => { failNotify = value; },
    failFind: (value: boolean) => { failFind = value; },
    beforeNotify: (value: (nonce: string) => void) => { beforeNotify = value; },
    beforeLookup: (value: () => Promise<void>) => { beforeLookup = value; },
  };
}

for (const target of [{ type: "channel", channelId: "11" }, { type: "dm", userId }] as const)
test(`確認待ちを ${target.type} へ一度だけ通知し、再起動後も再送しない`, async () => {
  const f = fixture(target); f.hold(); f.hold("date_missing", "102");
  await Promise.all([f.review.flush(), f.review.flush()]); await f.review.flush();
  expect(f.notices).toHaveLength(2);
  expect(f.notices[0]).toMatchObject({ guildId: "100", target,
    view: { content: "https://discord.com/channels/100/10/101\n理由：題名を読み取れません。" } });
  expect(f.notices[1]!.view.content).toContain("開催日が決まりません");
  expect(new Set(f.notices.map(n => n.nonce)).size).toBe(2);
  const payload = discordHubView(f.notices[0]!.view);
  expect(payload.allowedMentions).toEqual({ parse: [], repliedUser: false });
  expect(payload.components[0]!.toJSON().components).toMatchObject([
    { label: "Hubで登録する", style: 5, url: "https://example.invalid/event/apply/1/" },
    { label: "無視する", custom_id: "hub-review:101:ignore" },
  ]);
  f.reopen(); await f.review.flush(); expect(f.notices).toHaveLength(2);
  expect(f.review.pendingPostReviews()).toBe(2);
});

for (const target of [{ type: "channel", channelId: "11" }, { type: "dm", userId }] as const)
test(`${target.type} への送信成功後、保存前に停止しても履歴を照合して再送しない`, async () => {
  const f = fixture(target); f.hold();
  f.beforeNotify(() => {
    expect(f.extracted.reviewNotification("101")).toMatchObject({ sending: 1, notified: 0,
      notification: JSON.stringify(target) });
  });
  f.extracted.markReviewNotified = () => { throw new Error("停止を再現"); };
  await f.review.flush();
  expect(f.notices).toHaveLength(1);
  expect(f.extracted.reviewNotification("101")?.notified).toBe(0);
  f.reopen(); await f.review.flush(); await f.review.flush();
  expect(f.lookups).toEqual([target]);
  expect(f.notices).toHaveLength(1);
  expect(f.extracted.reviewNotification("101")?.notified).toBe(1);
  expect(f.logs).toContain("hub_post_review_notification_recovered");
});

test("照合できるまでは再送せず、他の確認待ちを通知できる", async () => {
  const f = fixture(); f.hold(); f.failNotify(true); await f.review.flush();
  f.reopen(); f.failNotify(false); f.failFind(true); f.hold("date_missing", "102");
  await f.review.flush();
  expect(f.notices).toHaveLength(1);
  expect(f.notices[0]!.view.content).toContain("/102");
  expect(f.extracted.reviewNotification("101")).toMatchObject({ sending: 1, notified: 0 });
  f.failFind(false); await f.review.flush();
  expect(f.notices).toHaveLength(2);
  expect(f.extracted.reviewNotification("101")).toMatchObject({ sending: 0, notified: 1 });
  expect(f.logs.join()).not.toContain("secret");
});

test("送信後に設定が削除されても、旧宛先を照合して重複通知を防ぐ", async () => {
  const f = fixture();
  f.settings.configure({ guildId: "100", community: { ...community, id: 2 }, channelIds: ["10"],
    notification: { type: "dm", userId } }, "100");
  f.hold("multiple_communities", "101", "");
  f.extracted.markReviewNotified = () => { throw new Error("停止を再現"); };
  await f.review.flush(); f.settings.leave("100", 1); f.reopen(); await f.review.flush();
  expect(f.lookups).toEqual([{ type: "channel", channelId: "11" }]);
  expect(f.notices).toHaveLength(1);
  expect(f.extracted.reviewNotification("101")).toMatchObject({ community_id: 1, sending: 0, notified: 1 });
});

test("未送信の通知先の設定を消しても別の集会に通知する", async () => {
  const f = fixture();
  f.settings.configure({ guildId: "100", community: { ...community, id: 2 }, channelIds: ["10"],
    notification: { type: "dm", userId } }, "100");
  f.hold("multiple_communities", "101", ""); f.failNotify(true);
  await f.review.flush();
  f.settings.leave("100", 1); f.reopen();
  expect(f.review.pendingPostReviews()).toBe(1);
  expect(f.review.pendingPostReviews("100", 2)).toBe(1);
  f.failNotify(false); await f.review.flush();
  expect(f.notices).toHaveLength(1);
  expect(f.notices[0]!.target).toEqual({ type: "dm", userId });
  expect(f.extracted.reviewNotification("101")).toMatchObject({ community_id: 2, notified: 1 });
});

test("既存の通知テーブルに送信中の列を追加しても送信済み・無視済みを保持する", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-post-review-legacy-"));
  const path = join(dir, "state.sqlite");
  const db = new Database(path);
  db.exec(`CREATE TABLE post_review_notifications (
    message_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, community_id INTEGER NOT NULL,
    notified INTEGER NOT NULL DEFAULT 0, closed INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO post_review_notifications VALUES ('101', '100', 1, 1, 0), ('102', '100', 1, 1, 1), ('103', '100', 1, 0, 0);`);
  db.close();
  const store = new ExtractionStore(path);
  try {
    expect(store.reviewNotification("101")).toMatchObject({ notified: 1, closed: 0, sending: 0, notification: "" });
    expect(store.reviewNotification("102")).toMatchObject({ notified: 1, closed: 1, sending: 0, notification: "" });
    store.reserveReviewNotification("103", "100", 2, { type: "dm", userId });
    expect(store.reviewNotification("103")).toMatchObject({ community_id: 2, notified: 0, sending: 1,
      notification: JSON.stringify({ type: "dm", userId }) });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("実際の抽出経路の確認待ちから本文を消し、リンクと理由だけを通知・保存する", async () => {
  const f = fixture();
  const content = "本文固有の文字列 @everyone <@123456789012345678>";
  f.settings.save({ ...message("101"), authorId: userId, authorDisplayName: "秘密の表示名", content,
    sourceUrl: "https://discord.com/channels/100/10/101" });
  const pipeline = new HubPipeline(f.settings, f.extracted, f.gateway,
    { ask: async () => ({ classification: { answer: "application", confidence: 0.1 } }) }, f.hub, f.review);
  await pipeline.run(); await pipeline.run();
  expect(f.notices).toHaveLength(1);
  expect(f.settings.messages("10")).toEqual([]);
  expect(f.notices[0]!.view.content).toContain("確信を持って判断できません");
  const db = new Database(f.path);
  try {
    const rows = db.query("SELECT * FROM pending_posts").all();
    const notifications = db.query("SELECT * FROM post_review_notifications").all();
    const result = JSON.stringify([f.notices, f.logs, rows, notifications]);
    expect(result).not.toContain(content); expect(result).not.toContain("秘密の表示名");
    expect(result).not.toContain("@everyone"); expect(result).not.toContain("synthetic");
  } finally { db.close(); }
});

for (const guildId of [null, "100"]) for (const role of ["owner", "staff"] as const)
test(`${guildId ?? "DM"} の ${role} が無視すると確認待ちを閉じ、再起動・再取り込みでも復活しない`, async () => {
  const f = fixture(); f.hold(); await f.review.flush(); f.memberships([{ ...community, role }]);
  expect(await f.act("101", guildId)).toContain("確認待ちを閉じました");
  expect(f.review.pendingPostReviews()).toBe(0);
  expect(f.extracted.reviewNotification("101")).toMatchObject({ closed: 1, notified: 1 });
  f.reopen(); f.hold(); await f.review.flush();
  expect(f.review.pendingPostReviews()).toBe(0); expect(f.notices).toHaveLength(1);
  expect(await f.act()).toContain("処理済み");
});

test("非主催者・別集会の主催者・別サーバーからの無視では閉じない", async () => {
  const f = fixture(); f.hold(); await f.review.flush();
  for (const memberships of [[], [{ ...community, id: 2 }]]) {
    f.memberships(memberships); expect(await f.act()).toContain("主催・スタッフではありません");
    expect(f.review.pendingPostReviews()).toBe(1);
  }
  f.memberships([community]); expect(await f.act("101", "200")).toContain("設定が変更");
  expect(f.review.pendingPostReviews()).toBe(1);
});

test("権限 API の失敗で閉じず、本文や秘密をログに出さず再操作できる", async () => {
  const f = fixture(); f.hold(); await f.review.flush(); f.failLookup(true);
  expect(await f.act()).toContain("確認できません"); expect(f.review.pendingPostReviews()).toBe(1);
  expect(f.logs).toContain("hub_post_review_ignore_failed"); expect(f.logs.join()).not.toContain("secret");
  f.failLookup(false); expect(await f.act()).toContain("閉じました");
});

test("同時の無視操作は一度だけ閉じる", async () => {
  const f = fixture(); f.hold(); await f.review.flush();
  const results = await Promise.all([f.act(), f.act()]);
  expect(results.filter(v => v.includes("閉じました"))).toHaveLength(1);
  expect(f.logs.filter(v => v === "hub_post_review_ignored")).toHaveLength(1);
});

test("読み取りの一時停止中も既存の確認待ちを数え、通知と無視を行える", async () => {
  const f = fixture(); f.hold(); f.settings.pause("100", 1);
  expect(f.settings.messageSettings("10", "101")).toEqual([]);
  expect(f.review.pendingPostReviews("100", 1)).toBe(1);
  await f.review.flush(); expect(f.notices).toHaveLength(1);
  expect(await f.act()).toContain("閉じました");
  expect(f.review.pendingPostReviews()).toBe(0);
});

test("権限確認中に設定を外した投稿を閉じない", async () => {
  const f = fixture(); f.hold(); await f.review.flush();
  f.beforeLookup(async () => { f.settings.leave("100", 1); });
  expect(await f.act()).toContain("設定が変更");
  expect(f.extracted.reviewNotification("101")?.closed).toBe(0);
  expect(f.review.pendingPostReviews()).toBe(0);
});

test("通知失敗は次の周期で再試行し、他の確認待ちや受信処理を止めない", async () => {
  const f = fixture(); f.hold(); f.hold("date_missing", "102");
  let firstNonce: string | undefined;
  let failFirst = true;
  f.beforeNotify(nonce => {
    firstNonce ??= nonce;
    if (failFirst && nonce === firstNonce) throw new Error("secret response body");
  });
  f.settings.save({ ...message("103"), authorId: userId, content: "新着の投稿",
    sourceUrl: "https://discord.com/channels/100/10/103" });
  const pipeline = new HubPipeline(f.settings, f.extracted, f.gateway,
    { ask: async () => ({ classification: { answer: "application", confidence: 0.1 } }) }, f.hub, f.review);
  await pipeline.run();
  expect(f.notices).toHaveLength(2);
  expect(f.notices.map(n => n.view.content.split("\n")[0])).toEqual([
    "https://discord.com/channels/100/10/102", "https://discord.com/channels/100/10/103",
  ]);
  expect(f.settings.messages("10")).toEqual([]);
  expect(f.extracted.pending("103")?.state).toBe("review");
  expect(f.extracted.reviewNotification("101")?.notified).toBe(0);
  expect(f.logs).toContain("hub_post_review_notification_failed"); expect(f.logs.join()).not.toContain("secret");
  f.reopen(); failFirst = false; await f.review.flush(); await f.review.flush();
  expect(f.notices).toHaveLength(3);
});

test("複数集会の確認待ちは一件だけ通知し、集会別件数も二重に数えない", async () => {
  const f = fixture();
  f.settings.configure({ guildId: "100", community: { ...community, id: 2 }, channelIds: ["10"],
    notification: { type: "dm", userId } }, "100");
  f.hold("multiple_communities", "101", ""); await f.review.flush();
  expect(f.notices).toHaveLength(1); expect(f.notices[0]!.view.content).toContain("登録先の集会を決められません");
  expect(f.review.pendingPostReviews()).toBe(1);
  expect(f.review.pendingPostReviews("100", 1)).toBe(1); expect(f.review.pendingPostReviews("100", 2)).toBe(0);
});

test("不正な出典・設定前の投稿・別集会・再試行待ちは通知しない", async () => {
  const f = fixture();
  f.hold("title_unextracted", "101", "1", "https://evil.invalid/@everyone");
  f.hold("uncertain", "102", "1", "https://discord.com/channels/100/20/102");
  f.hold("uncertain", "103", "1", "https://discord.com/channels/200/10/103");
  f.hold("uncertain", "100"); f.hold("uncertain", "104", "2");
  f.extracted.scheduleRetry("1", userId, { messageId: "105", channelId: "10", url: "https://discord.com/channels/100/10/105" },
    "judge_unavailable", () => 300, 1000);
  await f.review.flush(); expect(f.notices).toEqual([]); expect(f.review.pendingPostReviews()).toBe(0);
});

test("理由は日本語の固定文言だけで通知し、未知の理由はそのまま転載しない", async () => {
  const f = fixture();
  for (const [n, reason] of ["no_choice", "too_many_choices", "date_ambiguous", "date_unmatched", "date_conflict",
    "missing_metadata", "refetch_failed", "retry_exhausted", "hub_create_unconfirmed", "@everyone secret body"].entries()) {
    f.hold(reason, String(101 + n));
  }
  await f.review.flush(); expect(f.notices).toHaveLength(10);
  for (const notice of f.notices) {
    expect(notice.view.content).toMatch(/\n理由：[\s\S]+。$/);
    expect(notice.view.content).not.toContain("@everyone"); expect(notice.view.content).not.toContain("secret body");
  }
});

test("確認待ち件数を /hub status と健康状態へ出し、無視後にゼロへ戻す", async () => {
  const f = fixture(); f.hold(); await f.review.flush();
  const setup = new HubSetup(f.gateway, f.settings, f.hub, () => {}, undefined, undefined, f.review);
  const views: HubView[] = [];
  const i: HubInteraction = { guildId: "100", userId, kind: "command", action: "status", values: [],
    defer: async () => {}, edit: async view => { views.push(view); }, followUp: async () => {} };
  const status = async () => {
    await setup.handle(i);
    const control = views.at(-1)!.controls[0]!;
    if (control.type !== "select") throw new Error("Expected community menu");
    await setup.handle({ ...i, kind: "component", action: control.id, values: ["1"] });
    return views.at(-1)!.content;
  };
  expect(await status()).toContain("確認待ちの投稿：1 件");
  const bot = new HubBot(f.gateway, f.settings, { channelIds: [], work: { run: async () => {}, review: f.review },
    healthPath: join(f.dir, "health.json"), heartbeatMs: 60000 });
  cleanups.push(() => bot.stop());
  await bot.start("fake"); await bot.reconcile();
  expect(JSON.parse(readFileSync(join(f.dir, "health.json"), "utf8"))).toMatchObject({ pendingPostReviewCount: 1, pendingReviewCount: 0 });
  await f.act(); expect(await status()).toContain("確認待ちの投稿：0 件"); await bot.stop();
  expect(JSON.parse(readFileSync(join(f.dir, "health.json"), "utf8"))).toMatchObject({ pendingPostReviewCount: 0 });
});
