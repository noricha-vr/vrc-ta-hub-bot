import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubApi, type HubRequest } from "../src/hub-api";
import { HubBot } from "../src/bot";
import { HubDeliveryStore } from "../src/hub-delivery-store";
import { ExtractionStore, type TalkDraft } from "../src/extraction-store";
import { HubReview, eventDateLabel } from "../src/hub-review";
import { HubPipeline } from "../src/hub-pipeline";
import { HubStore, type NotificationTarget } from "../src/hub-store";
import { HubSetup, type HubInteraction, type HubView } from "../src/hub-setup";
import type { Judge, JudgeRequest } from "../src/jev";
import { FakeGateway, message } from "./fake-gateway";

const userId = "123456789012345678";
const source = { messageId: "101", channelId: "10", url: "https://discord.com/channels/100/10/101" };
const community = { id: 1, name: "集会", role: "owner" as const, recording_allowed: false };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture(setupRole: "owner" | "staff" = "owner") {
  const dir = mkdtempSync(join(tmpdir(), "hub-review-"));
  const path = join(dir, "state.sqlite");
  let settings = new HubStore(path);
  let extracted = new ExtractionStore(path);
  let deliveries = new HubDeliveryStore(path);
  const log: string[] = [];
  const notifications: Array<{ guildId: string; target: NotificationTarget; view: HubView; nonce: string }> = [];
  const calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
  let now = 1000;
  let eventsDown = false;
  let patchDown = false;
  let notifyDown = false;
  let lookupDown = false;
  let createFailure: "none" | "lost" | "unconfirmed" | "saved" | "unreadable" = "none";
  let createStatus = 201;
  let reviewStatus = 200;
  let reviewFailure: "none" | "lost" | "timeout" = "none";
  let reviewUserId: string | undefined;
  let beforeCreate: (() => void) | undefined;
  let beforePatch: ((id: number) => void | Promise<void>) | undefined;
  let beforeReview: (() => Promise<void>) | undefined;
  let found: Array<Record<string, unknown>> = [];
  let createCount = 0;
  let savedCount = 0;
  const request: HubRequest = async (url, options) => {
    expect(options.headers).toMatchObject({ "X-API-Key": "synthetic-key" });
    expect(url.origin).toBe("https://example.invalid");
    const body = options.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({ path: url.pathname + url.search, method: options.method ?? "GET", ...(body ? { body } : {}) });
    if (url.pathname === "/api/v1/community-by-discord/") {
      return Response.json({ discord_id: url.searchParams.get("discord_id"), communities: [{ ...community, role: setupRole }] });
    }
    if (url.pathname === "/api/v1/event/") {
      if (eventsDown) return new Response("unavailable", { status: 503 });
      return Response.json([{ id: 7, date: "2026-10-25", community: { id: 1 } }]);
    }
    if (url.pathname === "/api/v1/event-details/" && options.method === "GET") {
      if (lookupDown) return new Response("unavailable", { status: 503 });
      return Response.json(found);
    }
    if (url.pathname === "/api/v1/event-details/" && options.method === "POST") {
      beforeCreate?.();
      createCount++;
      if (createFailure === "unconfirmed") throw new Error("synthetic connection lost before response");
      if (createFailure === "none" && createStatus !== 201) return new Response("unavailable", { status: createStatus });
      const id = 42 + savedCount++;
      found.push({ id, source_url: body.source_url, source: "discord_bot", status: "pending" });
      if (createFailure === "lost") throw new Error("synthetic lost response");
      if (createFailure === "saved") return new Response("unavailable", { status: createStatus });
      if (createFailure === "unreadable") return new Response("invalid json", { status: 201 });
      return Response.json({ id }, { status: 201 });
    }
    const patchPath = /^\/api\/v1\/event-details\/(\d+)\/$/.exec(url.pathname);
    if (patchPath && options.method === "PATCH") {
      const id = Number(patchPath[1]);
      await beforePatch?.(id);
      return patchDown ? new Response("unavailable", { status: 503 }) : Response.json({ id });
    }
    const reviewPath = /^\/api\/v1\/event-details\/(\d+)\/review\/$/.exec(url.pathname);
    if (reviewPath) {
      const id = Number(reviewPath[1]);
      await beforeReview?.();
      if (reviewFailure === "timeout") throw new Error("synthetic timeout");
      if (reviewStatus !== 200) return new Response(reviewStatus === 204 ? null : "{}", { status: reviewStatus });
      if (reviewUserId && body.discord_id !== reviewUserId) return new Response("forbidden", { status: 403 });
      if (found.some(row => row.id === id && row.status !== "pending")) return new Response("{}", { status: 409 });
      const status = body.decision;
      found = found.map(row => row.id === id ? { ...row, status } : row);
      if (reviewFailure === "lost") throw new Error("synthetic lost review response");
      return Response.json({ status });
    }
    throw new Error("Unexpected fake request");
  };
  const hub = new HubApi("https://example.invalid", "synthetic-key", request);
  const gateway = { notify: async (guildId: string, target: NotificationTarget, view: HubView, nonce: string) => {
    if (notifyDown) throw new Error("Synthetic notification failure");
    notifications.push({ guildId, target, view, nonce });
  } };
  const makeReview = () => new HubReview(gateway, settings, extracted, deliveries, hub, event => log.push(event), () => now);
  let review = makeReview();
  settings.configure({ guildId: "100", community, channelIds: ["10"], notification: { type: "channel", channelId: "11" } }, "100");
  const create = (presenterId = userId, messageId = "101") => extracted.create({ meetingId: "1", presenterId, presenterName: "発表者 <@123>",
    eventDate: "2026-10-25", title: "題名 <script>", materials: [{ kind: "slides", url: "https://example.invalid/slides/one" }] },
    { ...source, messageId, url: `https://discord.com/channels/100/10/${messageId}` }).draft;
  const followUp = (draft: TalkDraft, id = "102") => extracted.addFollowUp(draft.id,
    [{ kind: "pdf", url: `https://example.invalid/${id}.pdf` }], { ...source, messageId: id, url: `https://discord.com/channels/100/10/${id}` });
  cleanups.push(() => { deliveries.close(); extracted.close(); settings.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    get settings() { return settings; }, get extracted() { return extracted; }, dir, hub, log, notifications, calls, create, followUp,
    get review() { return review; }, get deliveries() { return deliveries; }, get createCount() { return createCount; },
    get savedCount() { return savedCount; },
    advance: (seconds = 30000) => { now += seconds; },
    reopen: () => {
      deliveries.close(); extracted.close(); settings.close();
      settings = new HubStore(path); extracted = new ExtractionStore(path); deliveries = new HubDeliveryStore(path);
      review = makeReview();
    },
    setEventsDown: (value: boolean) => { eventsDown = value; }, setPatchDown: (value: boolean) => { patchDown = value; },
    setNotifyDown: (value: boolean) => { notifyDown = value; }, setLookupDown: (value: boolean) => { lookupDown = value; },
    setCreateFailure: (value: typeof createFailure) => { createFailure = value; },
    setCreateStatus: (value: number) => { createStatus = value; },
    setReviewFailure: (value: typeof reviewFailure) => { reviewFailure = value; },
    setReviewUser: (value: string) => { reviewUserId = value; },
    setReviewStatus: (value: number) => { reviewStatus = value; }, setFound: (value: typeof found) => { found = value; },
    beforeCreate: (fn: () => void) => { beforeCreate = fn; }, beforePatch: (fn: NonNullable<typeof beforePatch>) => { beforePatch = fn; },
    beforeReview: (fn: () => Promise<void>) => { beforeReview = fn; },
  };
}

function interaction(draftId: string, decision = "approved", guildId: string | null = "100", actor = userId) {
  const views: HubView[] = [];
  const i: HubInteraction = { guildId, userId: actor, kind: "component", action: `hub-review:${draftId}:${decision}`, values: [],
    defer: async () => {}, edit: async view => { views.push(view); }, followUp: async () => { throw new Error("No public edits"); } };
  return { i, views };
}

async function setup(f: ReturnType<typeof fixture>, actor: string) {
  const hub = new HubSetup({ validateChannels: async () => {}, leaveGuild: async () => {} }, f.settings, f.hub, () => {});
  const { i, views } = interaction("", "approved", "100", actor);
  await hub.handle({ ...i, kind: "command", action: "setup" });
  for (const values of [["1"], ["10"], ["channel"], ["11"]]) {
    const control = views.at(-1)!.controls[0]!;
    if (control.type === "buttons") throw new Error("Expected setup selection");
    await hub.handle({ ...i, action: control.id, values });
  }
  expect(views.at(-1)!.content).toContain("設定を保存しました");
}

test("作成前に記録し pending・出典・X-API-Key で登録し、設定された通知先だけにボタンを送る", async () => {
  const f = fixture(); const draft = f.create();
  f.beforeCreate(() => expect(f.deliveries.get(draft.id)?.state).toBe("creating"));
  await f.review.flush();
  const create = f.calls.find(c => c.method === "POST")!;
  expect(create.body).toEqual({ event: 7, detail_type: "LT", speaker: "発表者 &lt;@123&gt;", theme: "題名 &lt;script&gt;",
    slide_url: "https://example.invalid/slides/one", additional_info: "https://example.invalid/slides/one",
    status: "pending", source: "discord_bot", source_url: source.url });
  expect(f.notifications).toHaveLength(1);
  expect(f.notifications[0]).toMatchObject({ guildId: "100", target: { type: "channel", channelId: "11" } });
  expect(f.notifications[0]!.view.content).not.toContain("<@123>");
  const lines = f.notifications[0]!.view.content.split("\n");
  expect(lines[0]).toBe("承認待ちの発表があります。Hub で内容を確認してください。");
  expect(lines[1]).toMatch(/^日付：\d{4}-\d{2}-\d{2}\([日月火水木金土]\)$/);
  expect(lines[2]).toStartWith("発表者：");
  expect(lines[3]).toStartWith("テーマ：");
  expect(lines[4]).toBe(source.url);
  expect(f.notifications[0]!.view.controls).toEqual([{ type: "buttons", buttons: [
    { id: `hub-review:${draft.id}:approved`, label: "承認" },
    { url: "https://example.invalid/event/detail/42/update/", label: "直す" },
    { id: `hub-review:${draft.id}:rejected`, label: "却下" },
  ] }]);
  expect(f.settings.drafts("100", 1)).toHaveLength(1);
});

test("重複受信・再起動でも作成と通知を繰り返さず、続報は同じ ID に PATCH する", async () => {
  const f = fixture(); const draft = f.create(); await f.review.flush();
  f.create(); f.reopen(); await f.review.flush();
  expect(f.createCount).toBe(1); expect(f.notifications).toHaveLength(1);
  f.followUp(draft); await f.review.flush();
  const patch = f.calls.find(c => c.method === "PATCH")!;
  expect(patch.path).toBe("/api/v1/event-details/42/");
  expect(patch.body).toEqual({ slide_url: "https://example.invalid/slides/one",
    additional_info: "https://example.invalid/slides/one\nhttps://example.invalid/102.pdf" });
  expect(f.createCount).toBe(1); expect(f.notifications).toHaveLength(2);
  expect(f.notifications[0]!.nonce).not.toBe(f.notifications[1]!.nonce);
});

test("Hub 停止中は送信待ちを保持し、再起動後の復旧で取りこぼさず送る", async () => {
  const f = fixture(); const draft = f.create(); f.setEventsDown(true);
  await f.review.flush();
  expect(f.createCount).toBe(0); expect(f.notifications).toHaveLength(0);
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "queued", attempts: 1 });
  f.reopen(); f.advance(); f.setEventsDown(false); await f.review.flush();
  expect(f.createCount).toBe(1); expect(f.notifications).toHaveLength(1);
  expect(f.deliveries.counts()).toMatchObject({ ready: 1, retry: 0 });
});

for (const status of [400, 401, 403, 404, 422, 429]) test(`作成 POST の ${status} 応答は成否不明にせずバックオフ後に再送する`, async () => {
  const f = fixture(); const draft = f.create(); f.setCreateStatus(status);
  await f.review.flush();
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "queued", attempts: 1, next_at: 1300 });
  await f.review.flush(); f.advance(299); await f.review.flush(); expect(f.createCount).toBe(1);
  f.advance(1); await f.review.flush();
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "queued", attempts: 2, next_at: 1900 });
  f.reopen(); f.setCreateStatus(201); f.advance(599); await f.review.flush(); expect(f.createCount).toBe(2);
  f.advance(1); await f.review.flush();
  expect(f.createCount).toBe(3); expect(f.savedCount).toBe(1); expect(f.notifications).toHaveLength(1);
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "ready", attempts: 0 });
  expect(f.extracted.pending(source.messageId)).toBeUndefined();
  expect(f.calls.some(c => c.path === "/api/v1/event-details/" && c.method === "GET")).toBe(false);
});

for (const status of [408, 409, 500, 502, 503, 504]) test(`保存後の ${status} 応答は再作成せず出典の照合で下書き 1 件に確定する`, async () => {
  const f = fixture(); const draft = f.create(); f.setCreateFailure("saved"); f.setCreateStatus(status);
  await f.review.flush();
  expect(f.savedCount).toBe(1);
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "creating", attempts: 1 });
  f.reopen(); f.advance(); f.setCreateFailure("none"); f.setCreateStatus(201); await f.review.flush();
  expect(f.createCount).toBe(1); expect(f.savedCount).toBe(1); expect(f.notifications).toHaveLength(1);
  expect(f.calls.filter(c => c.path === "/api/v1/event-details/" && c.method === "GET")).toHaveLength(1);
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "ready", hub_id: 42, attempts: 0 });
});

test("作成の 2xx 応答本文を読めない時も再作成せず照合する", async () => {
  const f = fixture(); const draft = f.create(); f.setCreateFailure("unreadable"); await f.review.flush();
  expect(f.deliveries.get(draft.id)?.state).toBe("creating");
  f.reopen(); f.advance(); f.setCreateFailure("none"); await f.review.flush();
  expect(f.createCount).toBe(1); expect(f.savedCount).toBe(1);
  expect(f.calls.filter(c => c.path === "/api/v1/event-details/" && c.method === "GET")).toHaveLength(1);
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "ready", hub_id: 42 });
});

test("作成応答消失後は出典を照合し、POST を重ねず同じ下書きへ復帰する", async () => {
  const f = fixture(); const draft = f.create(); f.setCreateFailure("lost");
  await f.review.flush(); expect(f.deliveries.get(draft.id)?.state).toBe("creating");
  f.followUp(draft); f.reopen(); f.advance(); f.setCreateFailure("none"); await f.review.flush();
  expect(f.createCount).toBe(1); expect(f.notifications).toHaveLength(1);
  expect(f.calls.some(c => c.method === "PATCH")).toBe(true);
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "ready", hub_id: 42 });
});

test("成否不明の作成を照合できなければ再作成せず確認対象と記録を残す", async () => {
  const f = fixture(); const draft = f.create(); f.setCreateFailure("unconfirmed"); await f.review.flush();
  f.reopen(); f.advance(); await f.review.flush(); f.advance(); await f.review.flush();
  expect(f.createCount).toBe(1); expect(f.notifications).toHaveLength(0);
  expect(f.extracted.pending(source.messageId)).toMatchObject({ state: "review", reason: "hub_create_unconfirmed" });
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "creating", reason: "hub_create_unconfirmed" });
  expect(f.log).toContain("hub_create_unconfirmed");
});

test("照合 API の停止も空一覧とみなさず再試行し、後で復旧する", async () => {
  const f = fixture(); f.create(); f.setCreateFailure("lost"); await f.review.flush();
  f.advance(); f.setLookupDown(true); await f.review.flush(); expect(f.createCount).toBe(1);
  f.advance(); f.setLookupDown(false); await f.review.flush(); expect(f.notifications).toHaveLength(1);
});

test("PATCH と通知の失敗は再送し、新たな下書きを作らない", async () => {
  const f = fixture(); const draft = f.create(); await f.review.flush();
  f.followUp(draft); f.setPatchDown(true); await f.review.flush();
  expect(f.notifications).toHaveLength(1);
  f.advance(); f.setPatchDown(false); f.setNotifyDown(true); await f.review.flush();
  f.advance(); f.setNotifyDown(false); await f.review.flush();
  expect(f.notifications).toHaveLength(2); expect(f.createCount).toBe(1);
  expect(f.calls.filter(c => c.method === "PATCH")).toHaveLength(2);
});

for (const decision of ["approved", "rejected"]) test(`${decision} は押した人の Discord ID を送り、再起動後の古いボタンにも処理済みと返す`, async () => {
  const f = fixture(); const draft = f.create(); await f.review.flush();
  const { i, views } = interaction(draft.id, decision);
  await f.review.handle(i);
  expect(f.calls.filter(c => c.path.endsWith("/review/"))).toEqual([
    { path: "/api/v1/event-details/42/review/", method: "POST", body: { decision, discord_id: userId } },
  ]);
  expect(views[0]!.content).toContain(decision === "approved" ? "承認しました" : "却下しました");
  f.reopen(); const old = interaction(draft.id, decision); await f.review.handle(old.i);
  expect(old.views[0]!.content).toContain("処理済み");
  expect(f.calls.filter(c => c.path.endsWith("/review/"))).toHaveLength(1);
  f.followUp(draft); await f.review.flush(); expect(f.calls.some(c => c.method === "PATCH")).toBe(false);
});

for (const status of [403, 409]) test(`${status} は押した人に理由を返し、元の通知を変更しない`, async () => {
  const f = fixture(); const draft = f.create(); await f.review.flush();
  const original = JSON.stringify(f.notifications); f.setReviewStatus(status);
  if (status === 409) f.setFound([{ id: 42, source_url: source.url, source: "discord_bot", status: "approved" }]);
  const { i, views } = interaction(draft.id); await f.review.handle(i);
  expect(views[0]!.content).toContain(status === 403 ? "主催者ではありません" : "処理済み");
  expect(JSON.stringify(f.notifications)).toBe(original);
  expect(f.deliveries.get(draft.id)?.state).toBe(status === 403 ? "ready" : "closed");
  expect(f.deliveries.decisions(draft.id)).toEqual([]);
  if (status === 403) {
    f.setReviewStatus(200); const owner = interaction(draft.id, "approved", "100", "223456789012345678");
    await f.review.handle(owner.i); expect(owner.views[0]!.content).toContain("承認しました");
  }
});

test("レビューの障害時も押した人と判断を永続化し、復旧後に再送する", async () => {
  const f = fixture(); const draft = f.create(); await f.review.flush(); f.setReviewStatus(503);
  const { i, views } = interaction(draft.id, "rejected", null); await f.review.handle(i);
  expect(views[0]!.content).toContain("操作を保存");
  expect(f.deliveries.decision(draft.id, userId)).toMatchObject({ decision: "rejected", attempts: 1, next_at: 1300 });
  f.reopen(); f.setReviewStatus(200); f.advance(); await f.review.flush();
  expect(f.deliveries.get(draft.id)?.state).toBe("closed");
  expect(f.calls.filter(c => c.path.endsWith("/review/")).every(c => c.body?.discord_id === userId)).toBe(true);
});

test("障害中は 5 人分まで保留し、6 人目は保存も送信もしないが本人の変更は受け付ける", async () => {
  const f = fixture(); const draft = f.create(); await f.review.flush(); f.setReviewStatus(503);
  f.setReviewUser("223456789012345678");
  const actors = Array.from({ length: 6 }, (_, n) => String(BigInt(userId) + BigInt(n)));
  for (const actor of actors.slice(0, 5)) await f.review.handle(interaction(draft.id, "rejected", "100", actor).i);
  const pending = f.deliveries.decisions(draft.id);
  const before = f.calls.length;
  const sixth = interaction(draft.id, "rejected", "100", actors[5]!); await f.review.handle(sixth.i);
  expect(sixth.views[0]!.content).toBe("Hub に接続できません。復旧後にもう一度押してください");
  expect(f.deliveries.decision(draft.id, actors[5]!)).toBeUndefined();
  expect(f.deliveries.decisions(draft.id)).toEqual(pending);
  expect(f.calls).toHaveLength(before); expect(f.log).toContain("hub_review_queue_full");
  f.advance(10);
  const changed = interaction(draft.id, "approved", "100", actors[0]!); await f.review.handle(changed.i);
  expect(changed.views[0]!.content).toBe("再送待ちの判断を承認に変更しました");
  expect(f.deliveries.decision(draft.id, actors[0]!)).toEqual({ ...pending[0]!, decision: "approved" });
  expect(f.deliveries.decisions(draft.id)).toHaveLength(5); expect(f.calls).toHaveLength(before);
  f.reopen(); await f.review.handle(sixth.i);
  expect(f.deliveries.decisions(draft.id)).toHaveLength(5); expect(f.calls).toHaveLength(before);
});

for (const status of [200, 201, 204, 403, 409, 503]) test(`レビューの ${status} 応答では 200 の時だけ主催者の実績を保存する`, async () => {
  const f = fixture(); const draft = f.create(); await f.review.flush(); f.setReviewStatus(status);
  if (status === 409) f.setFound([{ id: 42, source_url: source.url, source: "discord_bot", status: "approved" }]);
  await f.review.handle(interaction(draft.id).i); f.reopen();
  const db = new Database(join(f.dir, "state.sqlite"), { readonly: true });
  try {
    expect(db.query("SELECT guild_id, community_id, discord_id FROM hub_reviewers").all())
      .toEqual(status === 200 ? [{ guild_id: "100", community_id: 1, discord_id: userId }] : []);
  } finally { db.close(); }
});

test("非主催者 5 人の保留があっても 200 の実績がある主催者の操作を保存・送信し、復旧時も先に再送する", async () => {
  const f = fixture(); const previous = f.create(); await f.review.flush();
  const ownerId = "223456789012345678"; f.setReviewUser(ownerId);
  await f.review.handle(interaction(previous.id, "approved", "100", ownerId).i);
  const draft = f.create("323456789012345678", "102"); await f.review.flush(); f.setReviewStatus(503);
  for (let n = 0; n < 5; n++) {
    await f.review.handle(interaction(draft.id, "rejected", "100", String(BigInt(userId) + BigInt(n))).i);
  }
  const owner = interaction(draft.id, "approved", "100", ownerId);
  const beforeOwner = f.calls.length; await f.review.handle(owner.i);
  expect(owner.views[0]!.content).toContain("操作を保存しました");
  expect(f.deliveries.decision(draft.id, ownerId)).toMatchObject({ decision: "approved", attempts: 1, next_at: 1300 });
  expect(f.calls.slice(beforeOwner).filter(c => c.path.endsWith("/review/"))).toEqual([
    { path: "/api/v1/event-details/43/review/", method: "POST", body: { decision: "approved", discord_id: ownerId } },
  ]);
  f.reopen(); f.advance(300); f.setReviewStatus(200);
  expect(f.deliveries.decisions(draft.id)).toHaveLength(6);
  const before = f.calls.length; await f.review.flush();
  expect(f.calls.slice(before)).toEqual([
    { path: "/api/v1/event-details/43/review/", method: "POST", body: { decision: "approved", discord_id: ownerId } },
  ]);
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "closed", reason: "approved" });
  expect(f.deliveries.decisions(draft.id)).toEqual([]);
});

for (const role of ["owner", "staff"] as const) test(`setup 済みの ${role} は満杯でも操作を保存・送信し、未確認の 6 人目は拒否する`, async () => {
  const f = fixture(role); const ownerId = "223456789012345678";
  await setup(f, ownerId); f.reopen();
  const draft = f.create(); await f.review.flush(); f.setReviewStatus(503); f.setReviewUser(ownerId);
  for (let n = 0; n < 5; n++) {
    await f.review.handle(interaction(draft.id, "rejected", "100", String(BigInt(userId) + BigInt(n))).i);
  }
  const owner = interaction(draft.id, "approved", "100", ownerId); await f.review.handle(owner.i);
  expect(owner.views[0]!.content).toContain("操作を保存しました");
  expect(f.deliveries.decision(draft.id, ownerId)).toMatchObject({ decision: "approved", attempts: 1, next_at: 1300 });
  const before = f.calls.length;
  const sixthId = String(BigInt(userId) + 5n);
  const sixth = interaction(draft.id, "rejected", "100", sixthId); await f.review.handle(sixth.i);
  expect(sixth.views[0]!.content).toBe("Hub に接続できません。復旧後にもう一度押してください");
  expect(f.deliveries.decision(draft.id, sixthId)).toBeUndefined();
  expect(f.deliveries.decisions(draft.id)).toHaveLength(6); expect(f.calls).toHaveLength(before);
  f.reopen(); f.advance(300); f.setReviewStatus(200); await f.review.flush();
  expect(f.calls.slice(before).filter(c => c.path.endsWith("/review/"))).toEqual([
    { path: "/api/v1/event-details/42/review/", method: "POST", body: { decision: "approved", discord_id: ownerId } },
  ]);
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "closed", reason: "approved" });
});

test("確認済み主催者は未確認の 5 人枠を使わず、再送は全下書きを通じて主催者優先・古い順で 5 件を超えても送る", async () => {
  const f = fixture(); const owners = Array.from({ length: 6 }, (_, n) => String(223456789012345678n + BigInt(n)));
  for (const owner of owners) await setup(f, owner);
  const first = f.create(); const second = f.create("323456789012345678", "102"); await f.review.flush(); f.setReviewStatus(503);
  await f.review.handle(interaction(first.id, "rejected").i); f.advance(1);
  await f.review.handle(interaction(second.id, "rejected").i); f.advance(1);
  await f.review.handle(interaction(second.id, "approved", "100", owners[0]!).i); f.advance(1);
  for (const owner of owners) {
    await f.review.handle(interaction(first.id, "approved", "100", owner).i); f.advance(1);
  }
  for (let n = 1; n < 5; n++) {
    await f.review.handle(interaction(first.id, "rejected", "100", String(BigInt(userId) + BigInt(n))).i); f.advance(1);
  }
  expect(f.deliveries.decisions(first.id)).toHaveLength(11);
  const sixthId = String(BigInt(userId) + 5n);
  const sixth = interaction(first.id, "rejected", "100", sixthId); const before = f.calls.length;
  await f.review.handle(sixth.i);
  expect(sixth.views[0]!.content).toBe("Hub に接続できません。復旧後にもう一度押してください");
  expect(f.deliveries.decision(first.id, sixthId)).toBeUndefined(); expect(f.calls).toHaveLength(before);
  f.reopen(); f.advance(300); await f.review.flush();
  expect(f.calls.slice(before).filter(c => c.path.endsWith("/review/")).map(c => [c.path, c.body?.discord_id])).toEqual([
    ["/api/v1/event-details/43/review/", owners[0]],
    ...owners.map(owner => ["/api/v1/event-details/42/review/", owner]),
    ["/api/v1/event-details/42/review/", userId], ["/api/v1/event-details/43/review/", userId],
    ...Array.from({ length: 4 }, (_, n) => ["/api/v1/event-details/42/review/", String(BigInt(userId) + BigInt(n + 1))]),
  ]);
});

test("旧 DB の保留が 5 件を超えても flush ごとの再送は下書きごとに 5 件に収める", async () => {
  const f = fixture(); const draft = f.create(); await f.review.flush(); f.setReviewStatus(503);
  const db = new Database(join(f.dir, "state.sqlite"));
  try {
    for (let n = 0; n < 7; n++) db.query(`INSERT INTO hub_review_decisions (draft_id, discord_id, decision, created_at)
      VALUES (?, ?, 'rejected', 1000)`).run(draft.id, String(BigInt(userId) + BigInt(n)));
  } finally { db.close(); }
  f.reopen(); const before = f.calls.filter(c => c.path.endsWith("/review/")).length;
  await f.review.flush();
  expect(f.calls.filter(c => c.path.endsWith("/review/")).slice(before).map(c => c.body?.discord_id))
    .toEqual(Array.from({ length: 5 }, (_, n) => String(BigInt(userId) + BigInt(n))));
  expect(f.deliveries.decisions(draft.id)).toHaveLength(7);
  await f.review.flush();
  expect(f.calls.filter(c => c.path.endsWith("/review/"))).toHaveLength(before + 7);
});

test("健康状態に保留の行数と最古の経過秒数を出し、判断変更と再起動でも待ち時間を保つ", async () => {
  const f = fixture(); const draft = f.create(); await f.review.flush(); f.setReviewStatus(503);
  await f.review.handle(interaction(draft.id).i); f.advance(30);
  const otherId = "223456789012345678";
  await f.review.handle(interaction(draft.id, "rejected", "100", otherId).i); f.advance(60);
  await f.review.handle(interaction(draft.id, "rejected").i); f.reopen();
  const gateway = new FakeGateway();
  const bot = new HubBot(gateway, f.settings, { channelIds: [], work: { run: async () => {}, review: f.review },
    healthPath: join(f.dir, "health.json"), heartbeatMs: 60000 });
  const health = () => JSON.parse(readFileSync(join(f.dir, "health.json"), "utf8"));
  try {
    await bot.start("fake");
    expect(health()).toMatchObject({ pendingReviewCount: 2, oldestPendingReviewAgeSeconds: 90 });
    f.advance(10); gateway.events!.disconnected();
    expect(health()).toMatchObject({ pendingReviewCount: 2, oldestPendingReviewAgeSeconds: 100 });
    f.deliveries.clearDecision(draft.id, userId); gateway.events!.reconnecting();
    expect(health()).toMatchObject({ pendingReviewCount: 1, oldestPendingReviewAgeSeconds: 70 });
    f.deliveries.closed(draft.id, "approved"); gateway.events!.disconnected();
    expect(health()).toMatchObject({ pendingReviewCount: 0, oldestPendingReviewAgeSeconds: 0 });
  } finally { await bot.stop(); }
});

for (const failure of [201, 202, 204, 403, 409, 503, "timeout"] as const) test(`主催者の保留後に非主催者が押して ${failure} でも各人の判断を失わず照合・再送する`, async () => {
  const f = fixture(); const draft = f.create(); await f.review.flush();
  const ownerId = "223456789012345678"; f.setReviewUser(ownerId); f.setReviewStatus(503);
  await f.review.handle(interaction(draft.id, "approved", "100", ownerId).i);
  const pending = f.deliveries.decision(draft.id, ownerId)!;
  expect(pending).toMatchObject({ decision: "approved", discord_id: ownerId, next_at: 1300 });
  f.reopen();
  if (failure === "timeout") { f.setReviewStatus(200); f.setReviewFailure("timeout"); }
  else f.setReviewStatus(failure);
  if (failure === 409) f.setFound([{ id: 42, source_url: source.url, source: "discord_bot", status: "approved" }]);
  const before = f.calls.length;
  const other = interaction(draft.id, "rejected"); await f.review.handle(other.i);
  expect(f.calls.slice(before)).toEqual([
    { path: "/api/v1/event-details/42/review/", method: "POST", body: { decision: "rejected", discord_id: userId } },
    ...(failure === 403 ? [] : [{ path: "/api/v1/event-details/", method: "GET" }]),
  ]);
  expect(other.views[0]!.content).toContain(failure === 403 ? "主催者ではありません" : failure === 409 ? "処理済み" : "Hub に接続できません");
  if (failure === 409) {
    expect(f.deliveries.get(draft.id)).toMatchObject({ state: "closed", reason: "approved" });
    expect(f.deliveries.decisions(draft.id)).toEqual([]);
    expect(f.settings.drafts("100", 1)[0]?.approved).toBe(true);
    return;
  }
  expect(f.deliveries.decision(draft.id, ownerId)).toEqual(pending);
  if (failure === 403) expect(f.deliveries.decision(draft.id, userId)).toBeUndefined();
  else {
    expect(other.views[0]!.content).toContain("操作を保存");
    expect(f.deliveries.decision(draft.id, userId)).toMatchObject({ decision: "rejected", attempts: 1 });
  }
  const after = f.calls.length;
  f.reopen(); f.setReviewStatus(200); f.setReviewFailure("none");
  f.advance(299); await f.review.flush(); expect(f.calls).toHaveLength(after);
  f.advance(1); await f.review.flush();
  expect(f.calls.at(-1)).toEqual(
    { path: "/api/v1/event-details/42/review/", method: "POST", body: { decision: "approved", discord_id: ownerId } },
  );
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "closed", reason: "approved" });
  expect(f.deliveries.decisions(draft.id)).toEqual([]);
  expect(f.settings.drafts("100", 1)[0]?.approved).toBe(true);
});

for (const failure of ["503", "timeout"] as const) test(`非主催者の ${failure} 後の保留が再起動後も主催者の操作を塞がない`, async () => {
  const f = fixture(); const draft = f.create(); await f.review.flush();
  const ownerId = "223456789012345678"; f.setReviewUser(ownerId);
  if (failure === "503") f.setReviewStatus(503); else f.setReviewFailure("timeout");
  await f.review.handle(interaction(draft.id, "rejected").i);
  expect(f.deliveries.decision(draft.id, userId)).toMatchObject({ decision: "rejected", discord_id: userId });
  const duplicate = interaction(draft.id); await f.review.handle(duplicate.i);
  expect(duplicate.views[0]!.content).toBe("再送待ちの判断を承認に変更しました");
  f.reopen(); f.setReviewStatus(200); f.setReviewFailure("none");
  const owner = interaction(draft.id, "approved", "100", ownerId); await f.review.handle(owner.i);
  expect(owner.views[0]!.content).toContain("承認しました");
  expect(f.calls.filter(c => c.path.endsWith("/review/")).at(-1)?.body).toEqual({ decision: "approved", discord_id: ownerId });
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "closed", reason: "approved" });
  expect(f.deliveries.decisions(draft.id)).toEqual([]);
  expect(f.settings.drafts("100", 1)[0]?.approved).toBe(true);
});

for (const restart of [false, true]) for (const failure of ["503", "timeout"] as const)
test(`非主催者と主催者の ${failure} 後、403 は本人分だけを消し主催者分を再送する（再起動: ${restart}）`, async () => {
  const f = fixture(); const draft = f.create(); await f.review.flush();
  const ownerId = "223456789012345678"; f.setReviewUser(ownerId);
  if (failure === "503") f.setReviewStatus(503); else f.setReviewFailure("timeout");
  await f.review.handle(interaction(draft.id, "rejected").i);
  if (restart) f.reopen();
  f.advance(100);
  const owner = interaction(draft.id, "approved", "100", ownerId); await f.review.handle(owner.i);
  expect(owner.views[0]!.content).toContain("操作を保存");
  expect(f.deliveries.decision(draft.id, userId)).toMatchObject({ decision: "rejected", attempts: 1, next_at: 1300 });
  expect(f.deliveries.decision(draft.id, ownerId)).toMatchObject({ decision: "approved", attempts: 1, next_at: 1400 });
  expect(f.deliveries.counts().retry).toBe(1);
  if (restart) f.reopen();
  f.setReviewStatus(200); f.setReviewFailure("none");
  const before = f.calls.length;
  f.advance(199); await f.review.flush(); expect(f.calls).toHaveLength(before);
  f.advance(1); await f.review.flush();
  expect(f.calls.slice(before)).toEqual([
    { path: "/api/v1/event-details/42/review/", method: "POST", body: { decision: "rejected", discord_id: userId } },
  ]);
  expect(f.deliveries.decision(draft.id, userId)).toBeUndefined();
  expect(f.deliveries.decision(draft.id, ownerId)).toMatchObject({ decision: "approved", attempts: 1, next_at: 1400 });
  expect(f.deliveries.get(draft.id)?.state).toBe("ready");
  f.advance(99); await f.review.flush(); expect(f.calls).toHaveLength(before + 1);
  f.advance(1); await f.review.flush();
  expect(f.calls.at(-1)).toEqual(
    { path: "/api/v1/event-details/42/review/", method: "POST", body: { decision: "approved", discord_id: ownerId } },
  );
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "closed", reason: "approved" });
  expect(f.deliveries.decisions(draft.id)).toEqual([]);
  expect(f.settings.drafts("100", 1)[0]?.approved).toBe(true);
  expect(f.deliveries.counts().retry).toBe(0);
});

for (const restart of ["none", "before", "after"] as const)
test(`非主催者の保留中に主催者の承認応答が消失しても照合で確定する（再起動: ${restart}）`, async () => {
  const f = fixture(); const draft = f.create(); await f.review.flush();
  const ownerId = "223456789012345678"; f.setReviewUser(ownerId); f.setReviewStatus(503);
  await f.review.handle(interaction(draft.id, "rejected").i);
  if (restart === "before") f.reopen();
  f.setReviewStatus(200); f.setReviewFailure("lost");
  if (restart === "after") f.setLookupDown(true);
  const owner = interaction(draft.id, "approved", "100", ownerId); await f.review.handle(owner.i);
  if (restart === "after") {
    expect(owner.views[0]!.content).toContain("操作を保存");
    expect(f.deliveries.decisions(draft.id)).toHaveLength(2);
    expect(f.settings.drafts("100", 1)[0]?.approved).toBe(false);
    f.reopen(); f.setLookupDown(false); f.setReviewFailure("none"); f.advance();
    const before = f.calls.length; await f.review.flush();
    expect(f.calls.slice(before)).toEqual([
      { path: "/api/v1/event-details/42/review/", method: "POST", body: { decision: "rejected", discord_id: userId } },
      { path: "/api/v1/event-details/42/review/", method: "POST", body: { decision: "approved", discord_id: ownerId } },
      { path: "/api/v1/event-details/", method: "GET" },
    ]);
  } else {
    expect(owner.views[0]!.content).toContain("処理済み");
    expect(f.calls.at(-1)).toEqual({ path: "/api/v1/event-details/", method: "GET" });
  }
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "closed", reason: "approved" });
  expect(f.settings.drafts("100", 1)[0]?.approved).toBe(true);
  expect(f.deliveries.decisions(draft.id)).toEqual([]);
  f.reopen(); const before = f.calls.length; f.advance(); await f.review.flush();
  expect(f.calls).toHaveLength(before);
});

test("同じ人の押し直しは本人の判断だけを上書きし再送時刻と他人の保留を維持する", async () => {
  const f = fixture(); const draft = f.create(); await f.review.flush(); f.setReviewStatus(503);
  const ownerId = "223456789012345678"; f.setReviewUser(ownerId);
  await f.review.handle(interaction(draft.id, "approved", "100", ownerId).i);
  await f.review.handle(interaction(draft.id, "approved").i);
  const other = f.deliveries.decision(draft.id, userId)!;
  const before = f.calls.length;
  const repeated = interaction(draft.id, "rejected", "100", ownerId); await f.review.handle(repeated.i);
  expect(repeated.views[0]!.content).toBe("再送待ちの判断を却下に変更しました");
  expect(f.calls).toHaveLength(before);
  expect(f.deliveries.decision(draft.id, ownerId)).toMatchObject({ decision: "rejected", attempts: 1, next_at: 1300 });
  expect(f.deliveries.decision(draft.id, userId)).toEqual(other);
  f.reopen(); f.setReviewStatus(200); f.advance(); await f.review.flush();
  expect(f.calls.at(-1)?.body).toEqual({ decision: "rejected", discord_id: ownerId });
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "closed", reason: "rejected" });
  expect(f.deliveries.decisions(draft.id)).toEqual([]);
});

for (const resend of [false, true]) for (const status of [200, 503])
test(`本人の送信中は判断変更も同じ判断の押し直しも保存せず拒否する（再送: ${resend}, 応答: ${status}）`, async () => {
  const f = fixture(); const draft = f.create(); await f.review.flush();
  if (resend) {
    f.setReviewStatus(503); await f.review.handle(interaction(draft.id).i); f.advance(300);
  }
  f.setReviewStatus(status);
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  f.beforeReview(async () => { started(); await waiting; });
  const original = interaction(draft.id);
  const sending = resend ? f.review.flush() : f.review.handle(original.i);
  await entered;
  const pending = f.deliveries.decision(draft.id, userId)!;
  const before = f.calls.length;
  try {
    for (const decision of ["rejected", "approved"]) {
      const changed = interaction(draft.id, decision); await f.review.handle(changed.i);
      expect(changed.views[0]!.content).toBe("前の操作を送信中です。結果が出てから押し直してください");
      expect(f.deliveries.decision(draft.id, userId)).toEqual(pending);
      expect(f.calls).toHaveLength(before);
    }
  } finally { release(); await sending; }
  if (status === 200) {
    expect(f.deliveries.get(draft.id)).toMatchObject({ state: "closed", reason: "approved" });
    expect(f.deliveries.decisions(draft.id)).toEqual([]);
    if (!resend) expect(original.views[0]!.content).toBe("承認しました。");
  } else {
    const retry = f.deliveries.decision(draft.id, userId)!;
    expect(retry).toMatchObject({ decision: "approved", attempts: resend ? 2 : 1, created_at: pending.created_at });
    const changed = interaction(draft.id, "rejected"); await f.review.handle(changed.i);
    expect(changed.views[0]!.content).toBe("再送待ちの判断を却下に変更しました");
    expect(f.deliveries.decision(draft.id, userId)).toEqual({ ...retry, decision: "rejected" });
    expect(f.calls).toHaveLength(before + 1);
  }
});

test("他人の送信中も本人の操作を保存して順番に送り、処理中の返事は本人の保留に限る", async () => {
  const f = fixture(); const draft = f.create(); await f.review.flush();
  const ownerId = "223456789012345678"; f.setReviewUser(ownerId);
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  f.beforeReview(async () => { started(); await waiting; });
  const other = interaction(draft.id, "rejected"); const first = f.review.handle(other.i);
  await entered;
  const owner = interaction(draft.id, "approved", "100", ownerId); const second = f.review.handle(owner.i);
  await Bun.sleep(0);
  expect(f.deliveries.decisions(draft.id)).toHaveLength(2);
  expect(owner.views).toEqual([]);
  const duplicate = interaction(draft.id, "approved", "100", ownerId); await f.review.handle(duplicate.i);
  expect(duplicate.views[0]!.content).toContain("処理中");
  release(); await Promise.all([first, second]);
  expect(other.views[0]!.content).toContain("主催者ではありません");
  expect(owner.views[0]!.content).toContain("承認しました");
  expect(f.calls.filter(c => c.path.endsWith("/review/")).map(c => c.body?.discord_id)).toEqual([userId, ownerId]);
  expect(f.deliveries.decisions(draft.id)).toEqual([]);
});

for (const status of ["approved", "rejected"] as const) test(`レビュー応答消失後の 409 は GET の ${status} にローカルを合わせる`, async () => {
  const f = fixture(); const draft = f.create(); await f.review.flush();
  const local = f.settings.drafts("100", 1)[0]!;
  f.settings.saveDraft({ ...local, approved: status === "rejected" });
  f.setReviewFailure("lost"); f.setLookupDown(true);
  await f.review.handle(interaction(draft.id, status).i);
  expect(f.deliveries.decision(draft.id, userId)?.decision).toBe(status);
  f.reopen(); f.advance(); f.setReviewFailure("none"); f.setReviewStatus(409); f.setLookupDown(false);
  await f.review.flush();
  expect(f.calls.at(-1)).toMatchObject({ method: "GET", path: "/api/v1/event-details/" });
  expect(f.settings.drafts("100", 1)[0]?.approved).toBe(status === "approved");
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "closed", reason: status });
  expect(f.deliveries.decisions(draft.id)).toEqual([]);
  const before = f.calls.length; f.advance(); await f.review.flush(); expect(f.calls).toHaveLength(before);
});

test("409 の現在状態を取得できなければ確定せず、復旧後に実際の判断へ同期する", async () => {
  const f = fixture(); const draft = f.create(); await f.review.flush();
  f.setReviewStatus(409); f.setLookupDown(true);
  await f.review.handle(interaction(draft.id, "rejected").i);
  expect(f.deliveries.get(draft.id)?.state).toBe("ready");
  expect(f.deliveries.decision(draft.id, userId)?.decision).toBe("rejected");
  f.advance(); f.setLookupDown(false);
  f.setFound([{ id: 42, source_url: source.url, source: "discord_bot", status: "approved" }]);
  await f.review.flush();
  expect(f.settings.drafts("100", 1)[0]?.approved).toBe(true);
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "closed", reason: "approved" });
});

for (const found of [[], [{ id: 43, status: "approved" }], [{ id: 42, status: "pending" }], [{ id: 42 }]])
test(`409 の照合結果 ${JSON.stringify(found)} ではローカルを確定しない`, async () => {
  const f = fixture(); const draft = f.create(); await f.review.flush(); f.setReviewStatus(409);
  f.setFound(found.map(row => ({ ...row, source_url: source.url, source: "discord_bot" })));
  await f.review.handle(interaction(draft.id).i);
  expect(f.deliveries.get(draft.id)?.state).toBe("ready");
  expect(f.deliveries.decision(draft.id, userId)).toMatchObject({ decision: "approved", attempts: 1, next_at: 1300 });
  expect(f.settings.drafts("100", 1)[0]?.approved).toBe(false);
  f.setFound([{ id: 42, status: "rejected", source_url: source.url, source: "discord_bot" }]);
  f.advance(); await f.review.flush();
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "closed", reason: "rejected" });
  expect(f.deliveries.decisions(draft.id)).toEqual([]);
  expect(f.settings.drafts("100", 1)[0]?.approved).toBe(false);
});

test("存在しない・別サーバー・取り外し済みのボタンは外部へ送らず古いと返す", async () => {
  const f = fixture(); const draft = f.create(); await f.review.flush();
  for (const i of [interaction("00000000-0000-0000-0000-000000000000"), interaction(draft.id, "approved", "200")]) {
    await f.review.handle(i.i); expect(i.views[0]!.content).toContain("古くなりました");
  }
  f.settings.leave("100", 1); const removed = interaction(draft.id); await f.review.handle(removed.i);
  expect(removed.views[0]!.content).toContain("古くなりました");
  expect(f.calls.filter(c => c.path.endsWith("/review/"))).toHaveLength(0);
});

test("通知は setup で選んだ DM のみ・一時停止中は送信しない", async () => {
  const f = fixture(); f.create();
  f.settings.configure({ guildId: "100", community, channelIds: ["10"], notification: { type: "dm", userId } }, "100");
  f.settings.pause("100", 1); await f.review.flush(); expect(f.createCount).toBe(0);
  f.settings.configure({ guildId: "100", community, channelIds: ["10"], notification: { type: "dm", userId } }, "100");
  await f.review.flush(); expect(f.notifications[0]?.target).toEqual({ type: "dm", userId });
});

test("flush の重なりや二重クリックでも同じ下書きへの送信を直列化する", async () => {
  const f = fixture(); const draft = f.create();
  await Promise.all([f.review.flush(), f.review.flush()]); expect(f.createCount).toBe(1);
  const a = interaction(draft.id); const b = interaction(draft.id);
  await Promise.all([f.review.handle(a.i), f.review.handle(b.i)]);
  expect(f.calls.filter(c => c.path.endsWith("/review/"))).toHaveLength(1);
  expect(b.views[0]!.content).toContain("処理中");
});

test("抽出の保存直後に停止しても、受信箱の重複を ack して保存済み候補を配送できる", async () => {
  const f = fixture(); f.create();
  f.settings.save({ ...message("101"), sourceUrl: source.url });
  const judge: Judge = { ask: async () => { throw new Error("No reclassification"); } };
  const pipeline = new HubPipeline(f.settings, f.extracted, new FakeGateway(), judge, f.hub, f.review);
  await pipeline.run();
  expect(f.settings.messages("10")).toEqual([]); expect(f.createCount).toBe(1);
});

test("受信箱から応募・続報を処理し、本文を消した後も停止中の Hub へ配送できる", async () => {
  const f = fixture(); const gateway = new FakeGateway();
  const judge: Judge = { ask: async (request: JudgeRequest) => {
    const key = Object.keys(request.questions)[0]!;
    return { [key]: { answer: key === "classification" ? (request.state.includes("続報") ? "follow_up" : "application")
      : key === "title" ? "line_2" : f.extracted.allDrafts()[0]!.id, confidence: 1 } };
  } };
  const pipeline = new HubPipeline(f.settings, f.extracted, gateway, judge, f.hub, f.review);
  const application = { ...message("101"), authorId: userId, authorDisplayName: "発表者", sourceUrl: source.url,
    createdAt: "2026-10-20T00:00:00Z", content: "10/25 に応募\n題名：発表の題名" };
  f.settings.save(application); await pipeline.run();
  f.setEventsDown(true); f.setPatchDown(true);
  f.settings.save({ ...application, id: "102", sourceUrl: "https://discord.com/channels/100/10/102", content: "続報 スライド https://example.invalid/slide.pdf" });
  await pipeline.run(); expect(f.settings.messages("10")).toEqual([]);
  f.advance(); f.setEventsDown(false); f.setPatchDown(false); await pipeline.run();
  expect(f.createCount).toBe(1); expect(f.calls.filter(c => c.method === "PATCH")).toHaveLength(2);
});

test("再接続の履歴補完中に届いた続報は、応募を取り込んでから投稿順に抽出する", async () => {
  const f = fixture(); const gateway = new FakeGateway();
  const classified: string[] = [];
  const judge: Judge = { ask: async (request: JudgeRequest) => {
    const key = Object.keys(request.questions)[0]!;
    if (key === "classification") classified.push(request.state);
    return { [key]: { answer: key === "classification" ? (request.state.includes("続報") ? "follow_up" : "application")
      : key === "title" ? "line_2" : f.extracted.allDrafts()[0]!.id, confidence: 1 } };
  } };
  const pipeline = new HubPipeline(f.settings, f.extracted, gateway, judge, f.hub, f.review);
  let workTask = Promise.resolve();
  const work = { run: (ready?: (channelId: string) => boolean) => { workTask = pipeline.run(ready); return workTask; }, review: f.review };
  const bot = new HubBot(gateway, f.settings, { channelIds: ["10"], work, healthPath: join(f.dir, "health.json"), heartbeatMs: 60000 });
  let release: () => void = () => {};
  const recovery = new Promise<void>(resolve => { release = resolve; });
  try {
    await bot.start("fake"); await bot.reconcile(); await workTask; await Bun.sleep(0);
    gateway.events!.disconnected();
    const application = { ...message("101"), authorId: userId, authorDisplayName: "発表者", sourceUrl: source.url,
      createdAt: "2026-10-20T00:00:00Z", content: "10/25 に応募\n題名：発表の題名" };
    gateway.history = [application];
    gateway.beforeFetch = async () => { await recovery; };
    gateway.events!.connected();
    const followUps = ["103", "102"].map(id => ({ ...application, id, sourceUrl: `https://discord.com/channels/100/10/${id}`,
      content: `続報 スライド https://example.invalid/${id}.pdf` }));
    for (const item of followUps) gateway.events!.message(item);
    await Bun.sleep(0); await workTask; await Bun.sleep(0);
    expect(classified).toEqual([]);
    expect(f.extracted.pending("102")).toBeUndefined(); expect(f.extracted.pending("103")).toBeUndefined();
    release(); await bot.reconcile(); await workTask;
    expect(classified).toEqual([application.content, followUps[1]!.content, followUps[0]!.content]);
    const drafts = f.extracted.allDrafts(); expect(drafts).toHaveLength(1);
    expect(drafts[0]!.sources.map(s => s.messageId)).toEqual(["101", "102", "103"]);
    expect(drafts[0]!.materials.map(m => m.url)).toEqual(["https://example.invalid/102.pdf", "https://example.invalid/103.pdf"]);
    expect(f.extracted.pending("102")).toBeUndefined(); expect(f.extracted.pending("103")).toBeUndefined();
    expect(f.settings.messages("10")).toEqual([]); expect(f.createCount).toBe(1);
  } finally { release(); await bot.stop(); }
});

test("POST 中・PATCH 中に保存された続報も次の周期で同じ下書きへ送る", async () => {
  const f = fixture(); const draft = f.create();
  f.beforeCreate(() => { f.followUp(draft, "102"); });
  await f.review.flush();
  f.beforePatch(() => { f.followUp(draft, "103"); });
  await f.review.flush(); await f.review.flush();
  const patches = f.calls.filter(c => c.method === "PATCH");
  expect(patches).toHaveLength(2);
  expect(patches[1]!.body?.additional_info).toContain("103.pdf");
  expect(f.createCount).toBe(1);
});

test("保存済み候補が 50 件を超えても完了行に阻まれず後の下書きも届く", async () => {
  const f = fixture();
  for (let index = 0; index < 55; index++) {
    const id = String(index + 101);
    f.extracted.create({ meetingId: "1", presenterId: String(index + 1000), presenterName: "発表者",
      eventDate: "2026-10-25", title: "題名", materials: [] }, { ...source, messageId: id, url: `https://discord.com/channels/100/10/${id}` });
  }
  await f.review.flush(); expect(f.createCount).toBe(55); expect(f.notifications).toHaveLength(55);
});

test("同じチャンネルの複数集会は確認対象に残し、導入前の投稿は別の集会へ送らない", async () => {
  const f = fixture();
  f.settings.configure({ guildId: "100", community: { ...community, id: 2 }, channelIds: ["10"], notification: { type: "dm", userId } }, "102");
  f.settings.save({ ...message("103"), authorId: userId, sourceUrl: "https://discord.com/channels/100/10/103" });
  let calls = 0;
  const judge: Judge = { ask: async () => { calls++; return { classification: { answer: "unrelated", confidence: 1 } }; } };
  const pipeline = new HubPipeline(f.settings, f.extracted, new FakeGateway(), judge, f.hub, f.review);
  await pipeline.run();
  expect(f.extracted.pending("103")).toMatchObject({ state: "review", reason: "multiple_communities" });
  expect(calls).toBe(0); expect(f.createCount).toBe(0);
  f.settings.save({ ...message("101"), authorId: userId, authorDisplayName: "発表者", sourceUrl: source.url }); await pipeline.run();
  expect(calls).toBe(1);
});

test("待機中のレビューが実は処理済みなら 409 で停止し、その後は送らない", async () => {
  const f = fixture(); const draft = f.create(); await f.review.flush(); f.setReviewStatus(503);
  await f.review.handle(interaction(draft.id).i);
  f.reopen(); f.advance(); f.setReviewStatus(409);
  f.setFound([{ id: 42, source_url: source.url, source: "discord_bot", status: "approved" }]); await f.review.flush();
  expect(f.deliveries.get(draft.id)?.state).toBe("closed");
  const before = f.calls.length; f.advance(); await f.review.flush(); expect(f.calls).toHaveLength(before);
});

test("取り外し後に再設定しても新しい導入境界より前の待機候補を送らない", async () => {
  const f = fixture(); const draft = f.create(); f.setEventsDown(true); await f.review.flush();
  f.settings.leave("100", 1);
  f.settings.configure({ guildId: "100", community, channelIds: ["10"], notification: { type: "dm", userId } }, "200");
  f.advance(); f.setEventsDown(false); await f.review.flush();
  expect(f.createCount).toBe(0);
  const stale = interaction(draft.id); await f.review.handle(stale.i); expect(stale.views[0]!.content).toContain("古くなりました");
});

for (const delivered of [false, true]) test(`再設定後の新しい応募が同じ下書きに加わったら新しい出典で配送を再開する（作成済み: ${delivered}）`, async () => {
  const f = fixture(); const draft = f.create();
  f.setEventsDown(!delivered); await f.review.flush();
  f.settings.leave("100", 1);
  f.settings.configure({ guildId: "100", community, channelIds: ["10"], notification: { type: "dm", userId } }, "200");
  f.setEventsDown(false); f.advance(); await f.review.flush();
  const before = f.calls.length;
  expect(f.create(userId, "201").id).toBe(draft.id);
  f.reopen(); await f.review.flush();
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "ready", hub_id: 42 });
  expect(f.createCount).toBe(1);
  expect(f.calls.slice(before).some(c => c.method === (delivered ? "PATCH" : "POST"))).toBe(true);
  expect(f.settings.drafts("100", 1)[0]?.approved).toBe(false);
  expect(f.notifications.at(-1)?.target).toEqual({ type: "dm", userId });
});

for (const delivered of [false, true]) test(`別サーバーの再設定後に統合された応募は今のサーバーと通知先へ配送する（作成済み: ${delivered}）`, async () => {
  const f = fixture(); const draft = f.create();
  f.setEventsDown(!delivered); await f.review.flush();
  f.settings.leave("100", 1);
  f.settings.configure({ guildId: "200", community, channelIds: ["20"], notification: { type: "channel", channelId: "21" } }, "200");
  f.setEventsDown(false); f.advance(); await f.review.flush();
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "closed", reason: "setting_removed" });
  const before = f.calls.length;
  const merged = f.extracted.create({ meetingId: draft.meetingId, presenterId: draft.presenterId, presenterName: draft.presenterName,
    eventDate: draft.eventDate, title: draft.title, materials: draft.materials },
    { messageId: "201", channelId: "20", url: "https://discord.com/channels/200/20/201" });
  expect(merged.draft.id).toBe(draft.id);
  f.reopen(); await f.review.flush();
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "ready", hub_id: 42, guild_id: "200", community_id: 1 });
  expect(f.createCount).toBe(1);
  expect(f.calls.slice(before).some(c => c.method === (delivered ? "PATCH" : "POST"))).toBe(true);
  expect(f.settings.drafts("100", 1)).toEqual([]);
  expect(f.settings.drafts("200", 1)[0]).toMatchObject({ id: "42", guildId: "200", approved: false });
  expect(f.notifications).toHaveLength(delivered ? 2 : 1);
  expect(f.notifications.at(-1)).toMatchObject({ guildId: "200", target: { type: "channel", channelId: "21" } });
});

test("設定のない配送と判断の保留は健康状態の集計から除く", async () => {
  const f = fixture(); const draft = f.create(); await f.review.flush();
  const other = f.create("223456789012345678", "102"); await f.review.flush();
  const db = new Database(join(f.dir, "state.sqlite"));
  try {
    db.query("UPDATE hub_deliveries SET guild_id = '200' WHERE draft_id = ?").run(draft.id);
    f.deliveries.queueDecision(draft.id, "approved", userId, 900);
    f.deliveries.retryDecision(draft.id, userId, 900);
    f.deliveries.queueDecision(other.id, "approved", userId, 1000);
    expect(f.review.pendingReviews()).toEqual({ count: 1, oldestAgeSeconds: 0 });
    expect(f.review.pendingReviews("200", 1)).toEqual({ count: 0, oldestAgeSeconds: 0 });
    expect(f.deliveries.counts()).toMatchObject({ ready: 1, retry: 0 });
  } finally { db.close(); }
});

for (const retryDue of [false, true]) test(`判断の保留中も続報を同期し、再送時刻まで判断を待つ（再送時刻到達: ${retryDue}）`, async () => {
  const f = fixture(); const draft = f.create(); await f.review.flush(); f.setReviewStatus(503);
  await f.review.handle(interaction(draft.id).i);
  f.followUp(draft); f.reopen(); f.setReviewStatus(200);
  if (retryDue) f.advance(300);
  const before = f.calls.length; await f.review.flush();
  const calls = f.calls.slice(before);
  expect(calls[0]).toMatchObject({ path: "/api/v1/event-details/42/", method: "PATCH" });
  expect(calls[0]?.body?.additional_info).toContain("102.pdf");
  expect(calls.filter(c => c.path.endsWith("/review/"))).toHaveLength(retryDue ? 1 : 0);
  expect(f.deliveries.get(draft.id)?.state).toBe(retryDue ? "closed" : "ready");
});

test("続報の PATCH が失敗したら判断を閉じず、資料の同期後に確定する", async () => {
  const f = fixture(); const draft = f.create(); await f.review.flush(); f.setReviewStatus(503);
  await f.review.handle(interaction(draft.id).i);
  f.followUp(draft); f.setPatchDown(true); f.setReviewStatus(200); f.advance(300);
  await f.review.flush();
  expect(f.deliveries.get(draft.id)?.state).toBe("ready");
  expect(f.deliveries.decisions(draft.id)).toHaveLength(1);
  f.reopen(); f.setPatchDown(false); f.advance(); await f.review.flush();
  expect(f.calls.filter(c => c.method === "PATCH").at(-1)?.body?.additional_info).toContain("102.pdf");
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "closed", reason: "approved" });
  expect(f.deliveries.decisions(draft.id)).toEqual([]);
});

for (const reconciled of [false, true]) test(`ボタンからの判断中に届く続報も配送を閉じる前に同期する（照合: ${reconciled}）`, async () => {
  const f = fixture(); const draft = f.create(); await f.review.flush();
  f.beforeReview(async () => { f.followUp(draft); });
  if (reconciled) {
    f.setReviewStatus(409);
    f.setFound([{ id: 42, source_url: source.url, source: "discord_bot", status: "approved" }]);
  }
  await f.review.handle(interaction(draft.id).i);
  expect(f.calls.filter(c => c.method === "PATCH").at(-1)?.body?.additional_info).toContain("102.pdf");
  expect(f.deliveries.get(draft.id)?.state).toBe("closed");
  expect(f.notifications).toHaveLength(1);
});

test("判断後の PATCH 中に追加された資料も同期してから配送を閉じる", async () => {
  const f = fixture(); const draft = f.create(); await f.review.flush();
  f.beforeReview(async () => { f.followUp(draft); });
  f.beforePatch(() => { f.followUp(draft, "103"); });
  await f.review.handle(interaction(draft.id).i);
  const patches = f.calls.filter(c => c.method === "PATCH");
  expect(patches).toHaveLength(2);
  expect(patches.at(-1)?.body?.additional_info).toContain("103.pdf");
  expect(f.deliveries.get(draft.id)?.state).toBe("closed");
});

for (const status of [201, 400]) test(`作成 POST 中の leave を後の ${status} 応答で再開しない`, async () => {
  const f = fixture(); const draft = f.create(); f.setCreateStatus(status);
  f.beforeCreate(() => { f.settings.leave("100", 1); });
  await f.review.flush();
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "closed", reason: "setting_removed" });
  expect(f.settings.drafts("100", 1)).toEqual([]); expect(f.notifications).toEqual([]);
  expect(f.review.pendingReviews()).toEqual({ count: 0, oldestAgeSeconds: 0 });
});

for (const status of [400, 401, 403, 404, 422, 429]) test(`作成 POST 中の leave 後の ${status} 応答は未作成を記録し、再設定後の応募で新規作成する`, async () => {
  const f = fixture(); const draft = f.create(); f.setCreateStatus(status);
  f.beforeCreate(() => { f.settings.leave("100", 1); });
  await f.review.flush();
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "closed", reason: "setting_removed", attempted_hash: "", hub_id: null });
  expect(f.savedCount).toBe(0); expect(f.notifications).toEqual([]);
  f.reopen(); f.settings.configure({ guildId: "100", community, channelIds: ["10"], notification: { type: "dm", userId } }, "200");
  f.setCreateStatus(201); f.beforeCreate(() => {});
  await f.review.flush(); expect(f.createCount).toBe(1);
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "closed", reason: "setting_removed", attempted_hash: "" });
  expect(f.create(userId, "201").id).toBe(draft.id);
  f.reopen(); await f.review.flush();
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "ready", hub_id: 42 });
  expect(f.createCount).toBe(2); expect(f.savedCount).toBe(1); expect(f.notifications).toHaveLength(1);
  expect(f.notifications[0]?.target).toEqual({ type: "dm", userId });
  expect(f.calls.some(c => c.path === "/api/v1/event-details/" && c.method === "GET")).toBe(false);
});

test("flush の配送一覧を読んだ後にボタンで閉じた下書きには PATCH と承認待ち通知を送らない", async () => {
  const f = fixture(); const first = f.create(); const second = f.create("223456789012345678", "102");
  await f.review.flush(); f.followUp(first, "103"); f.followUp(second, "104");
  let release!: () => void; let started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  f.beforePatch(async id => { if (id === 42) { started(); await waiting; } });
  const flushing = f.review.flush(); await entered;
  try {
    await f.review.handle(interaction(second.id).i);
    expect(f.deliveries.get(second.id)?.state).toBe("closed");
    const before = f.calls.length;
    release(); await flushing;
    expect(f.calls.slice(before).some(c => c.path === "/api/v1/event-details/43/" && c.method === "PATCH")).toBe(false);
    expect(f.notifications).toHaveLength(3);
  } finally { release(); await flushing; }
});

for (const status of ["approved", "rejected"] as const) test(`作成応答の照合で ${status} なら状態を保存し、leave でも承認済みを残す`, async () => {
  const f = fixture(); const draft = f.create(); f.setCreateFailure("lost"); await f.review.flush();
  f.reopen(); f.advance(); f.setCreateFailure("none");
  f.setFound([{ id: 42, source_url: source.url, source: "discord_bot", status }]);
  await f.review.flush();
  expect(f.settings.drafts("100", 1)[0]?.approved).toBe(status === "approved");
  expect(f.deliveries.get(draft.id)).toMatchObject({ state: "closed", reason: status });
  expect(f.notifications).toEqual([]);
  f.settings.leave("100", 1);
  expect(f.settings.drafts("100", 1)).toHaveLength(status === "approved" ? 1 : 0);
});

test("成否不明の保留が後から照合できたら、その保留だけ解消する", async () => {
  const f = fixture(); f.create(); f.setCreateFailure("unconfirmed"); await f.review.flush();
  f.advance(); await f.review.flush(); expect(f.extracted.pending(source.messageId)?.reason).toBe("hub_create_unconfirmed");
  f.setFound([{ id: 42, source: "discord_bot", source_url: source.url, status: "pending" }]);
  f.advance(); await f.review.flush(); expect(f.extracted.pending(source.messageId)).toBeUndefined();
  expect(f.createCount).toBe(1); expect(f.notifications).toHaveLength(1);
});

test("抽出の再試行待ちは毎周期やり直さず、予定時刻に Gateway から取り直す", async () => {
  const f = fixture(); const gateway = new FakeGateway();
  const item = { ...message("101"), authorId: userId, authorDisplayName: "発表者", sourceUrl: source.url };
  gateway.history = [item]; f.settings.save(item);
  let now = 1000; let down = true; let calls = 0;
  const judge: Judge = { ask: async () => {
    calls++; if (down) throw new Error("Synthetic failure");
    return { classification: { answer: "unrelated", confidence: 1 } };
  } };
  const pipeline = new HubPipeline(f.settings, f.extracted, gateway, judge, f.hub, f.review, () => {}, () => now);
  await pipeline.run(); await pipeline.run();
  expect(calls).toBe(1); expect(gateway.queries).toHaveLength(0);
  expect(f.extracted.pending("101")).toMatchObject({ attempts: 1, nextAt: 1300 });
  now = 1300; down = false; await pipeline.run();
  expect(calls).toBe(2); expect(gateway.queries).toHaveLength(1);
  expect(f.settings.messages("10")).toEqual([]); expect(f.extracted.pending("101")).toBeUndefined();
});

test("取り外した集会の再試行が 50 件あっても有効な集会の再試行を妨げない", async () => {
  const f = fixture(); const gateway = new FakeGateway();
  for (let n = 0; n < 50; n++) f.extracted.scheduleRetry("2", userId,
    { ...source, messageId: String(200 + n), url: `https://discord.com/channels/100/10/${200 + n}` }, "judge_unavailable", () => 0, 1000);
  f.extracted.scheduleRetry("1", userId, { ...source, messageId: "1000", url: "https://discord.com/channels/100/10/1000" }, "judge_unavailable", () => 0, 1000);
  gateway.history = [{ ...message("1000"), authorId: userId, authorDisplayName: "発表者", sourceUrl: "https://discord.com/channels/100/10/1000" }];
  const judge: Judge = { ask: async () => ({ classification: { answer: "unrelated", confidence: 1 } }) };
  const pipeline = new HubPipeline(f.settings, f.extracted, gateway, judge, f.hub, f.review, () => {}, () => 1000);
  await pipeline.run();
  expect(gateway.queries).toHaveLength(1); expect(gateway.queries[0]!.query.around).toBe("1000");
  expect(f.extracted.pending("1000")).toBeUndefined(); expect(f.extracted.pending("200")).toBeDefined();
});

test("開催日に曜日を添える", () => {
  expect(eventDateLabel("2026-11-03")).toBe("2026-11-03(火)");
  expect(eventDateLabel("2026-10-22")).toBe("2026-10-22(木)");
});
