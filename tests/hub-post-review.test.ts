import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelType, Client } from "discord.js";
import type { NotificationReference } from "../src/gateway";
import { HubBot } from "../src/bot";
import { clientOptions, DiscordGateway } from "../src/discord-gateway";
import { ExtractionStore } from "../src/extraction-store";
import { HubApi, type HubCommunity } from "../src/hub-api";
import { HubDeliveryStore } from "../src/hub-delivery-store";
import { HubPipeline } from "../src/hub-pipeline";
import { HubPostReview, type HubPostReviewGateway } from "../src/hub-post-review";
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
  let now = Date.now();
  const deliveries = new HubDeliveryStore(path);
  const gateway = new FakeGateway();
  const notices: Array<{ guildId: string; target: NotificationTarget; view: HubView; nonce: string }> = [];
  const logs: string[] = [];
  const edits: Array<{ reference: NotificationReference; result: string; removeLinks: boolean | undefined }> = [];
  let editError: unknown;
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
  const notifier: HubPostReviewGateway = { editNotification: async (reference, result, removeLinks) => {
    edits.push({ reference, result, removeLinks });
    if (editError) throw editError;
  }, findNotification: async (guildId: string, target: NotificationTarget, nonce: string) => {
    lookups.push(target);
    if (failFind) throw new Error("secret response body");
    const index = notices.findIndex(n => n.guildId === guildId && JSON.stringify(n.target) === JSON.stringify(target) && n.nonce === nonce);
    return index < 0 ? false : { channelId: target.type === "channel" ? target.channelId : "900", messageId: String(501 + index) };
  }, notify: async (guildId: string, target: NotificationTarget, view: HubView, nonce: string) => {
    beforeNotify?.(nonce);
    if (failNotify) throw new Error("secret response body");
    notices.push({ guildId, target, view, nonce });
    return { channelId: target.type === "channel" ? target.channelId : "900", messageId: String(500 + notices.length) };
  } };
  const log = (event: string) => logs.push(event);
  const makeReview = () => new HubReview(notifier, settings, extracted, deliveries, hub, log, () => 1000,
    new HubPostReview(notifier, settings, extracted, hub, log, () => now));
  let review = makeReview();
  settings.configure({ guildId: "100", community, channelIds: ["10"], notification }, "100");
  const hold = (reason = "title_unextracted", id = "101", meetingId = "1", url = `https://discord.com/channels/100/10/${id}`) => {
    extracted.holdReview(meetingId, userId, { messageId: id, channelId: "10", url }, reason, 1000);
  };
  const act = async (id = "101", guildId: string | null = "100", actor = userId, extra: Partial<HubInteraction> = {}) => {
    const views: HubView[] = [];
    let deferred = false;
    await review.handle({ action: `hub-review:${id}:ignore`, guildId, userId: actor, kind: "component", values: [],
      defer: async () => { deferred = true; }, edit: async view => { expect(deferred).toBe(true); views.push(view); },
      followUp: async () => {}, ...extra });
    return views[0]!.content;
  };
  cleanups.push(() => { extracted.close(); deliveries.close(); settings.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, path, settings, deliveries, gateway, hub, notices, logs, hold, act, lookups, notifier, edits,
    setEditError: (error: unknown) => { editError = error; },
    get extracted() { return extracted; }, get review() { return review; },
    reopen: () => { extracted.close(); extracted = new ExtractionStore(path); review = makeReview(); },
    advance: (ms: number) => { now += ms; },
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
    view: { content: "確認が必要な投稿があります。\nhttps://discord.com/channels/100/10/101\n理由：題名を読み取れません。" } });
  expect(f.notices[1]!.view.content).toContain("開催日が決まりません");
  expect(new Set(f.notices.map(n => n.nonce)).size).toBe(2);
  const payload = discordHubView(f.notices[0]!.view);
  expect(payload.allowedMentions).toEqual({ parse: [], repliedUser: false });
  expect(payload.components[0]!.toJSON().components).toMatchObject([
    { label: "Hub で登録する", style: 5, url: "https://example.invalid/event/apply/1/" },
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
  await f.act();
  expect(f.edits).toEqual([{ reference: { channelId: target.type === "dm" ? "900" : "11", messageId: "501" },
    result: "無視", removeLinks: true }]);
});

test("照合できるまでは再送せず、他の確認待ちを通知できる", async () => {
  const f = fixture(); f.hold(); f.failNotify(true); await f.review.flush();
  f.reopen(); f.failNotify(false); f.failFind(true); f.hold("date_missing", "102");
  await f.review.flush();
  expect(f.notices).toHaveLength(1);
  expect(f.notices[0]!.view.content).toContain("/102");
  expect(f.extracted.reviewNotification("101")).toMatchObject({ sending: 1, notified: 0 });
  f.failFind(false); f.advance(60000); await f.review.flush();
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
    expect(store.reviewNotification("101")).toMatchObject({ attempted_at: 0, send_outcome: "sent" });
    expect(store.reviewNotification("101")).toMatchObject({ reconcile_delay_ms: 0, reconcile_next_at: 0 });
    expect(store.reviewNotification("102")).toMatchObject({ notified: 1, closed: 1, sending: 0, notification: "" });
    store.reserveReviewNotification("103", "100", 2, { type: "dm", userId });
    expect(store.reviewNotification("103")).toMatchObject({ community_id: 2, notified: 0, sending: 1,
      notification: JSON.stringify({ type: "dm", userId }), send_outcome: "unknown" });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("実際の抽出経路の確認待ちから本文を消し、投稿者・リンク・理由を通知し、本文を保存しない", async () => {
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
    expect(result).not.toContain(content);
    expect(f.notices[0]!.view.content.split("\n").slice(0, 2)).toEqual(["確認が必要な投稿があります。", "投稿者：秘密の表示名"]);
    expect(f.logs.join()).not.toContain("秘密の表示名");
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
  expect(f.notices.map(n => n.view.content.split("\n").find(line => line.startsWith("https://discord.com/channels/")))).toEqual([
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

// REST と接続は使わず、実アダプターの履歴ページングまで通す。
function notificationHistory(f: ReturnType<typeof fixture>, foundOnPage?: number, attemptedAt?: number) {
  const client = new Client(clientOptions);
  const gateway = new DiscordGateway(client);
  Object.defineProperty(client, "user", { value: { id: "20" } });
  const queries: Array<{ before?: string; limit: number; cache: boolean }> = [];
  client.channels.fetch = (async () => ({
    id: "11", type: ChannelType.GuildText, guildId: "100", guild: { members: { me: { id: "20" } } },
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async (query: typeof queries[number]) => {
      queries.push(query);
      const page = queries.length;
      return new Map(Array.from({ length: 100 }, (_, i) => {
        const id = String(100000 - (page - 1) * 100 - i);
        return [id, { id, author: { id: "20" }, nonce: null,
          createdTimestamp: attemptedAt ?? Date.now() + 60000,
          components: page === foundOnPage && i === 0
            ? [{ components: [{ customId: "hub-review:101:ignore" }] }] : [] }];
      }));
    } },
  })) as unknown as typeof client.channels.fetch;
  f.notifier.findNotification = (...args) => gateway.findNotification(...args);
  cleanups.push(() => gateway.stop());
  return queries;
}

test("送信済み通知が履歴の 2 ページ目にあれば再起動後も再送しない", async () => {
  const f = fixture(); f.hold();
  f.extracted.markReviewNotified = () => { throw new Error("保存前の停止"); };
  const before = Date.now();
  await f.review.flush();
  expect(f.notices).toHaveLength(1);
  f.reopen();
  const queries = notificationHistory(f, 2);
  await f.review.flush();
  expect(f.notices).toHaveLength(1);
  expect(queries).toEqual([{ limit: 100, cache: false }, { limit: 100, cache: false, before: "99901" }]);
  expect(f.extracted.reviewNotification("101")).toMatchObject({ notified: 1, sending: 0 });
  expect(f.extracted.reviewNotification("101")!.attempted_at).toBeGreaterThanOrEqual(before);
  await f.act();
  expect(f.edits[0]?.reference).toEqual({ channelId: "11", messageId: "99900" });
});

test("履歴の 20 ページ上限で見つからない時は再送せず成否不明を健康状態に残す", async () => {
  const f = fixture(); f.hold(); f.failNotify(true);
  await f.review.flush(); f.reopen(); f.failNotify(false);
  const queries = notificationHistory(f);
  await f.review.flush();
  expect(queries).toHaveLength(20);
  expect(f.notices).toHaveLength(0);
  expect(f.extracted.reviewNotification("101")).toMatchObject({ notified: 0, sending: 1, send_outcome: "unknown" });
  expect(f.logs).toContain("hub_post_review_notification_unknown");
  const healthPath = join(f.dir, "health.json");
  const bot = new HubBot(f.gateway, f.settings, { channelIds: [], healthPath, heartbeatMs: 60000,
    work: { run: async () => {}, review: f.review } });
  cleanups.push(() => bot.stop());
  await bot.start("fake");
  expect(JSON.parse(readFileSync(healthPath, "utf8")).unknownPostReviewNotificationCount).toBe(1);
});

for (const status of [403, 404])
test(`送信 API が ${status} で確定拒否された後、削除された旧宛先を照合せず新宛先へ送る`, async () => {
  const f = fixture(); f.hold();
  const notify = f.notifier.notify;
  f.notifier.notify = async () => { throw Object.assign(new Error("private response"), { status }); };
  await f.review.flush();
  const rejected = f.extracted.reviewNotification("101");
  f.reopen(); f.failFind(true); f.notifier.notify = notify;
  f.settings.configure({ guildId: "100", community, channelIds: ["10"], notification: { type: "channel", channelId: "12" } }, "100");
  await f.review.flush();
  expect(f.lookups).toEqual([]);
  expect(f.notices).toHaveLength(1);
  expect(f.notices[0]!.target).toEqual({ type: "channel", channelId: "12" });
  expect(rejected).toMatchObject({ notified: 0, sending: 0, send_outcome: "rejected" });
  expect(f.logs).toContain("hub_post_review_notification_rejected");
});

for (const status of [403, 404])
test(`成否不明の旧宛先の履歴が ${status} なら、今の設定の別宛先へ送る`, async () => {
  const f = fixture(); f.hold(); f.failNotify(true);
  await f.review.flush(); f.reopen(); f.failNotify(false);
  f.notifier.findNotification = async () => { throw Object.assign(new Error("private response"), { status }); };
  f.settings.configure({ guildId: "100", community, channelIds: ["10"], notification: { type: "channel", channelId: "12" } }, "100");
  await f.review.flush();
  expect(f.notices).toHaveLength(1);
  expect(f.notices[0]!.target).toEqual({ type: "channel", channelId: "12" });
  expect(f.extracted.reviewNotification("101")).toMatchObject({ notified: 1, sending: 0, send_outcome: "sent" });
  expect(f.logs.join()).not.toContain("private response");
});

test("送信試行の時刻より前まで遡って見つからなければ未送信として送り、さらに古いページは取得しない", async () => {
  const f = fixture(); f.hold(); f.failNotify(true);
  await f.review.flush(); f.reopen(); f.failNotify(false);
  const attemptedAt = f.extracted.reviewNotification("101")!.attempted_at;
  const queries = notificationHistory(f, undefined, attemptedAt - 6000);
  await f.review.flush();
  expect(f.notices).toHaveLength(1);
  expect(queries).toHaveLength(1);
  expect(f.extracted.reviewNotification("101")).toMatchObject({ notified: 1, sending: 0 });
});

for (const status of [403, 404])
test(`成否不明で履歴が ${status} でも同じ通知先には再送しない`, async () => {
  const f = fixture(); f.hold(); f.failNotify(true);
  await f.review.flush(); f.reopen(); f.failNotify(false);
  f.notifier.findNotification = async () => { throw Object.assign(new Error("private response"), { status }); };
  await f.review.flush(); await f.review.flush();
  expect(f.notices).toHaveLength(0);
  expect(f.extracted.reviewNotification("101")).toMatchObject({ notified: 0, sending: 1, send_outcome: "unknown" });
});

for (const status of [undefined, 500, 503])
test(`履歴の一時障害 (${status ?? "接続断"}) では通知先の変更後も再送せず照合を待つ`, async () => {
  const f = fixture(); f.hold(); f.failNotify(true);
  await f.review.flush(); f.reopen(); f.failNotify(false);
  f.notifier.findNotification = async () => { throw Object.assign(new Error("private response"), { status }); };
  f.settings.configure({ guildId: "100", community, channelIds: ["10"], notification: { type: "channel", channelId: "12" } }, "100");
  await f.review.flush();
  expect(f.notices).toHaveLength(0);
  expect(f.extracted.reviewNotification("101")).toMatchObject({ notified: 0, sending: 1, send_outcome: "unknown" });
  expect(f.logs).toContain("hub_post_review_notification_unknown");
});

test("旧宛先に届いた成否不明の通知も、別宛先では nonce の重複排除に妨げられず送れる", async () => {
  const f = fixture(); f.hold();
  const notify = f.notifier.notify;
  f.notifier.notify = async (guildId, target, view, nonce) => {
    // Discord の送信者単位の重複排除を再現する。
    if (!f.notices.some(n => n.nonce === nonce)) return notify(guildId, target, view, nonce);
    return { channelId: "11", messageId: "501" };
  };
  f.extracted.markReviewNotified = () => { throw new Error("保存前の停止"); };
  await f.review.flush(); f.reopen();
  f.notifier.findNotification = async () => { throw Object.assign(new Error("private response"), { status: 403 }); };
  f.settings.configure({ guildId: "100", community, channelIds: ["10"], notification: { type: "dm", userId } }, "100");
  await f.review.flush(); await f.review.flush();
  expect(f.notices).toHaveLength(2);
  expect(f.notices[1]!.target).toEqual({ type: "dm", userId });
  expect(f.notices[0]!.nonce).not.toBe(f.notices[1]!.nonce);
  expect(f.extracted.reviewNotification("101")).toMatchObject({ notified: 1, send_outcome: "sent" });
});

test("成否不明の照合は再起動後も 1 分から倍増し、最大 1 時間まで待つ", async () => {
  const f = fixture(); f.hold(); f.failNotify(true);
  await f.review.flush(); f.failNotify(false);
  let calls = 0;
  f.notifier.findNotification = async () => { calls++; return "unknown"; };
  for (const minutes of [1, 2, 4, 8, 16, 32, 60, 60]) {
    await f.review.flush();
    const before = calls;
    expect(f.extracted.reviewNotification("101")!.reconcile_delay_ms).toBe(minutes * 60000);
    f.reopen();
    // 通知先が変わっても、待機中には照合も送信もしない。
    f.settings.configure({ guildId: "100", community, channelIds: ["10"],
      notification: { type: "channel", channelId: "12" } }, "100");
    for (let elapsed = 5000; elapsed < minutes * 60000; elapsed += 5000) {
      f.advance(5000); await f.review.flush();
      expect(calls).toBe(before); expect(f.notices).toHaveLength(0);
    }
    f.advance(4999); await f.review.flush(); expect(calls).toBe(before);
    f.advance(1);
  }
  await f.review.flush(); expect(calls).toBe(9);
});

for (const found of [true, false])
test(`成否不明の照合が ${found} になれば待機間隔を消す`, async () => {
  const f = fixture(); f.hold(); f.failNotify(true);
  await f.review.flush(); f.failNotify(false);
  let calls = 0;
  f.notifier.findNotification = async () => { calls++; return "unknown"; };
  await f.review.flush();
  f.notifier.findNotification = async () => { calls++; return found ? { channelId: "11", messageId: "501" } : false; };
  await f.review.flush(); expect(calls).toBe(1);
  f.advance(60000); await f.review.flush();
  expect(calls).toBe(2);
  expect(f.extracted.reviewNotification("101")).toMatchObject({ reconcile_delay_ms: 0, reconcile_next_at: 0, notified: 1 });
  expect(f.notices).toHaveLength(found ? 0 : 1);
});

for (const status of [403, 404]) for (const target of [
  { type: "channel", channelId: "11" }, { type: "dm", userId },
] as const)
test(`${target.type} の ${status} 拒否後は同じ宛先を再送せず、再起動後に宛先変更で送る`, async () => {
  const f = fixture(target); f.hold(); f.hold("uncertain", "102");
  const notify = f.notifier.notify;
  let attempts = 0;
  f.notifier.notify = async () => { attempts++; throw Object.assign(new Error("private response"), { status }); };
  await f.review.flush(); expect(attempts).toBe(2);
  f.reopen(); await f.review.flush(); f.advance(3600000); await f.review.flush();
  expect(attempts).toBe(2); expect(f.lookups).toEqual([]);
  const healthPath = join(f.dir, "health.json");
  const bot = new HubBot(f.gateway, f.settings, { channelIds: [], healthPath, heartbeatMs: 60000,
    work: { run: async () => {}, review: f.review } });
  cleanups.push(() => bot.stop()); await bot.start("fake");
  expect(JSON.parse(readFileSync(healthPath, "utf8"))).toMatchObject({
    rejectedPostReviewNotificationCount: 2, rejectedPostReviewNotificationTargets: [target],
  });
  f.settings.configure({ guildId: "100", community, channelIds: ["10"],
    notification: { type: "channel", channelId: "12" } }, "100");
  f.notifier.notify = notify; await f.review.flush(); await bot.stop();
  expect(f.notices).toHaveLength(2);
  expect(f.notices.every(n => n.target.type === "channel" && n.target.channelId === "12")).toBe(true);
  expect(JSON.parse(readFileSync(healthPath, "utf8"))).toMatchObject({
    rejectedPostReviewNotificationCount: 0, rejectedPostReviewNotificationTargets: [],
  });
  expect(f.logs).toContain("hub_post_review_notification_rejected");
  expect(f.logs.join()).not.toContain("private response");
});

test("無視すると保留行を消し、tombstone によって再取り込みでも保留・通知を復活させない", async () => {
  const f = fixture(); f.hold(); await f.review.flush(); await f.act();
  expect(f.extracted.pending("101")).toBeUndefined();
  expect(f.extracted.reviewPosts()).toEqual([]);
  expect(f.extracted.reviewNotification("101")).toMatchObject({ closed: 1, notified: 1 });
  f.reopen(); f.hold(); await f.review.flush();
  expect(f.extracted.pending("101")).toBeUndefined(); expect(f.notices).toHaveLength(1);
});

test("無視時の保留行削除が失敗したら tombstone の更新もロールバックする", async () => {
  const f = fixture(); f.hold(); await f.review.flush();
  const db = new Database(f.path);
  try {
    db.exec(`CREATE TRIGGER reject_pending_delete BEFORE DELETE ON pending_posts
      BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
    expect(await f.act()).toContain("確認できません");
    expect(f.extracted.pending("101")?.state).toBe("review");
    expect(f.extracted.reviewNotification("101")?.closed).toBe(0);
    db.exec("DROP TRIGGER reject_pending_delete");
    expect(await f.act()).toContain("閉じました");
    expect(f.extracted.pending("101")).toBeUndefined();
  } finally { db.close(); }
});


test("投稿者の表示名を再起動後も表示し、メンションと Markdown を無効にする", async () => {
  const f = fixture();
  f.extracted.holdReview("1", userId, { messageId: "101", channelId: "10", url: "https://discord.com/channels/100/10/101" },
    "uncertain", 1000, "**運営** @everyone <@123>\n[表示](https://example.invalid)");
  f.reopen(); await f.review.flush();
  const content = f.notices[0]!.view.content;
  expect(content.split("\n")).toEqual([
    "確認が必要な投稿があります。",
    "投稿者：\\*\\*運営\\*\\* ＠everyone \\<＠123\\> \\[表示\\]\\(https://example.invalid\\)",
    "https://discord.com/channels/100/10/101", "理由：応募か続報かを確信を持って判断できません。",
  ]);
  expect(discordHubView(f.notices[0]!.view).allowedMentions).toEqual({ parse: [], repliedUser: false });
});

for (const target of [{ type: "channel", channelId: "11" }, { type: "dm", userId }] as const)
test(`無視すると ${target.type} の元通知を編集し、全ボタンを外して安全な表示名を足す`, async () => {
  const f = fixture(target); f.hold(); await f.review.flush();
  expect(await f.act("101", target.type === "dm" ? null : "100", userId,
    { userDisplayName: "**運営** @everyone\n<@123>" })).toContain("閉じました");
  expect(f.edits).toEqual([{ reference: { channelId: target.type === "dm" ? "900" : "11", messageId: "501" },
    result: "無視（\\*\\*運営\\*\\* ＠everyone \\<＠123\\>）", removeLinks: true }]);
  expect(f.logs).toContain("hub_post_review_notification_edited");
  f.reopen(); await f.review.flush(); expect(f.edits).toHaveLength(1);
});

test("無視の通知編集に失敗しても閉じた記録を残し、再起動後に間隔を倍増して編集し直す", async () => {
  const f = fixture(); f.hold(); await f.review.flush();
  f.setEditError(new Error("private edit response"));
  expect(await f.act("101", "100", userId, { userDisplayName: "運営" })).toContain("閉じました");
  expect(f.extracted.pending("101")).toBeUndefined();
  expect(f.extracted.reviewNotification("101")?.closed).toBe(1);
  expect(f.edits).toHaveLength(1);
  f.reopen(); f.advance(299999); await f.review.flush(); expect(f.edits).toHaveLength(1);
  f.advance(1); await f.review.flush(); expect(f.edits).toHaveLength(2);
  f.reopen(); f.setEditError(undefined); f.advance(599999); await f.review.flush(); expect(f.edits).toHaveLength(2);
  f.advance(1); await f.review.flush(); expect(f.edits).toHaveLength(3);
  expect(f.edits[2]?.result).toBe("無視（運営）");
  f.advance(21600000); await f.review.flush(); expect(f.edits).toHaveLength(3);
  expect(f.notices).toHaveLength(1);
  expect(f.logs).toContain("hub_post_review_notification_retry");
  expect(f.logs.join()).not.toContain("private edit response");
});

for (const [error, reason] of [
  [{ code: 10008 }, "unknown_message"], [{ code: 10003 }, "unknown_channel"], [{ status: 404 }, "not_found"],
] as const)
test(`無視した通知の ${reason} は再起動後も再試行しない`, async () => {
  const f = fixture(); f.hold(); await f.review.flush();
  f.setEditError(Object.assign(new Error("private missing response"), error));
  await f.act(); expect(f.edits).toHaveLength(1);
  expect(f.logs).toContain(`hub_post_review_notification_${reason}`);
  f.reopen(); f.advance(21600000); await f.review.flush(); await f.act();
  expect(f.edits).toHaveLength(1);
  expect(f.extracted.reviewNotification("101")?.closed).toBe(1);
});

test("旧通知に編集先 ID がなくても押された通知から補って編集する", async () => {
  const f = fixture(); f.hold();
  f.extracted.reserveReviewNotification("101", "100", 1, { type: "channel", channelId: "11" });
  f.extracted.markReviewNotified("101");
  await f.act("101", "100", userId, { notification: { channelId: "11", messageId: "499" } });
  expect(f.edits).toEqual([{ reference: { channelId: "11", messageId: "499" }, result: "無視", removeLinks: true }]);
});


for (const error of [{ status: 403 }, { code: 50001 }, { code: 50013 }])
test(`無視通知の権限不足 ${JSON.stringify(error)} は再起動後も 6 時間待つ`, async () => {
  const f = fixture(); f.hold(); await f.review.flush();
  f.setEditError(Object.assign(new Error("private forbidden response"), error));
  await f.act(); expect(f.edits).toHaveLength(1);
  expect(f.logs).toContain("hub_post_review_notification_forbidden");
  f.reopen(); f.advance(21599999); await f.review.flush(); expect(f.edits).toHaveLength(1);
  f.setEditError(undefined); f.advance(1); await f.review.flush(); expect(f.edits).toHaveLength(2);
});

test("再試行の記録から元投稿が消えて確認待ちになっても投稿者を表示する", async () => {
  const f = fixture();
  f.settings.save({ ...message("101"), authorId: userId, authorDisplayName: "投稿者", content: "応募の本文",
    sourceUrl: "https://discord.com/channels/100/10/101" });
  let now = 1000;
  const pipeline = new HubPipeline(f.settings, f.extracted, f.gateway,
    { ask: async () => { throw new Error("Synthetic judge failure"); } }, f.hub, f.review, undefined, () => now);
  await pipeline.run();
  expect(f.extracted.pending("101")).toMatchObject({ state: "retry", authorDisplayName: "投稿者" });
  expect(f.settings.purge(23 * 3600, Math.floor(Date.now() / 1000) + 24 * 3600)).toBe(1);
  expect(f.settings.messages("10")).toEqual([]);
  f.reopen(); now += 300;
  // Gateway の偽物に元の投稿は無いので、確認待ちへ移る。
  const restarted = new HubPipeline(f.settings, f.extracted, f.gateway,
    { ask: async () => { throw new Error("Unexpected judge call"); } }, f.hub, f.review, undefined, () => now);
  await restarted.run();
  expect(f.notices[0]!.view.content).toContain("投稿者：投稿者\n");
  expect(f.notices[0]!.view.content).toContain("元の投稿を取り直せません");
  expect(JSON.stringify(f.notices)).not.toContain("応募の本文");
});

test("複数集会の確認待ちにも投稿者の表示名を引き継ぐ", async () => {
  const f = fixture();
  f.settings.configure({ guildId: "100", community: { ...community, id: 2 }, channelIds: ["10"],
    notification: { type: "channel", channelId: "11" } }, "100");
  f.settings.save({ ...message("101"), authorId: userId, authorDisplayName: "投稿者", content: "応募の本文",
    sourceUrl: "https://discord.com/channels/100/10/101" });
  const pipeline = new HubPipeline(f.settings, f.extracted, f.gateway,
    { ask: async () => { throw new Error("Unexpected judge call"); } }, f.hub, f.review);
  await pipeline.run();
  expect(f.notices[0]!.view.content).toContain("投稿者：投稿者\n");
  expect(f.notices[0]!.view.content).toContain("登録先の集会を決められません");
});
