import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubBot } from "../src/bot";
import type { HubCommunity } from "../src/hub-api";
import { HubSetup, setupBaseline, type HubInteraction, type HubView } from "../src/hub-setup";
import { HubStore } from "../src/hub-store";
import { FakeGateway, message } from "./fake-gateway";

const userId = "123456789012345678";
const owner: HubCommunity = { id: 1, name: "集会 A", role: "owner", recording_allowed: false };
const staff: HubCommunity = { id: 2, name: "集会 B", role: "staff", recording_allowed: true };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hub-setup-"));
  const path = join(dir, "state.sqlite");
  const store = new HubStore(path);
  const gateway = new FakeGateway();
  const logs: string[] = [];
  let memberships: HubCommunity[] = [owner, staff];
  let lookup: (() => Promise<void>) | undefined;
  let now = Date.parse("2026-10-19T00:00:00Z");
  let bot: HubBot;
  const hub = new HubSetup(gateway, store, { communities: async id => {
    expect(id).toBe(userId); await lookup?.(); return memberships;
  } }, () => bot.refreshChannels(), event => logs.push(event), () => now);
  bot = new HubBot(gateway, store, { channelIds: () => store.channelIds(), baseline: id => store.baseline(id), hub,
    healthPath: join(dir, "health.json"), log: event => logs.push(event), heartbeatMs: 60000 });
  cleanups.push(async () => { await bot.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  async function interact(action: string, values: string[] = [], kind: "command" | "component" = "command", overrides: Partial<HubInteraction> = {}): Promise<HubView> {
    let result: HubView | undefined;
    let deferred = false;
    await hub.handle({ guildId: "100", userId, action, values, kind,
      defer: async () => { deferred = true; }, edit: async view => { expect(deferred).toBe(true); result = view; },
      followUp: async view => { expect(deferred).toBe(true); result = view; }, ...overrides });
    expect(result).toBeDefined();
    return result!;
  }
  const select = (view: HubView, values: string[], overrides: Partial<HubInteraction> = {}) => {
    const control = view.controls[0]!;
    if (control.type === "buttons") throw new Error("Expected select");
    return interact(control.id, values, "component", overrides);
  };
  async function setup(ids = ["10", "11"], communityId = 1, notification = "dm") {
    let view = await interact("setup");
    view = await select(view, [String(communityId)]);
    view = await select(view, ids);
    if (!view.controls.length) return view;
    view = await select(view, [notification]);
    if (notification === "channel") view = await select(view, ["12"]);
    return view;
  }
  async function action(action: string, communityId = 1) { return select(await interact(action), [String(communityId)]); }
  return { dir, path, store, gateway, bot, hub, logs, interact, select, setup, action,
    setMemberships: (value: HubCommunity[]) => { memberships = value; },
    setLookup: (value: (() => Promise<void>) | undefined) => { lookup = value; },
    tick: (ms: number) => { now += ms; }, baseline: () => setupBaseline(now) };
}

function draft(id: string, approved = false, communityId = 1, guildId = "100") {
  return { id, guildId, communityId, approved, sourceUrl: `https://discord.com/channels/${guildId}/10/123`, createdAt: "2026-10-19T00:00:00Z" };
}

test("zero settings starts and waits without querying any history", async () => {
  const f = fixture();
  await f.bot.start("fake"); await f.bot.reconcile();
  expect(f.gateway.queries).toEqual([]);
  expect(f.store.settings()).toEqual([]);
});

test("no eligible membership refuses setup and makes no persistent changes", async () => {
  const f = fixture(); f.setMemberships([]);
  const view = await f.interact("setup");
  expect(view.content).toContain("ありません");
  expect(view.controls).toEqual([]);
  expect(f.store.settings()).toEqual([]);
  expect(f.gateway.validations).toEqual([]);
});

test("multiple channels and notification persist across restart without source message bodies", async () => {
  const f = fixture();
  expect((await f.setup()).content).toContain("保存しました");
  expect(f.store.settings()).toEqual([{ guildId: "100", community: owner, channelIds: ["10", "11"], notification: { type: "dm", userId }, paused: false }]);
  expect(f.store.cursor("10")).toBe(f.baseline());
  const reopened = new HubStore(f.path);
  try { expect(reopened.settings()).toEqual(f.store.settings()); } finally { reopened.close(); }
  expect(f.logs).toContain("hub_setup_saved");
});

test("setup replaces channel selection, preserves retained cursor, and clears removed inbox", async () => {
  const f = fixture(); await f.setup();
  const original = f.baseline();
  const id = (BigInt(original) + 1n).toString();
  f.store.save(message(id), true);
  f.tick(1000);
  await f.setup(["11", "13"], 1, "channel");
  expect(f.store.channelIds()).toEqual(["11", "13"]);
  expect(f.store.messages("10")).toEqual([]);
  expect(f.store.cursor("10")).toBe("0");
  expect(f.store.cursor("11")).toBe(original);
  expect(f.store.cursor("13")).toBe(f.baseline());
  expect(f.store.settings()[0]?.notification).toEqual({ type: "channel", channelId: "12" });
});

test("live and recovered messages at or before setup are not ingested", async () => {
  const f = fixture();
  await f.bot.start("fake");
  const old = (BigInt(f.baseline()) - 1n).toString();
  f.gateway.history = [message(old)];
  await f.setup(["10"]); await f.bot.reconcile();
  f.gateway.events!.message(message(old));
  f.gateway.events!.message(message(f.baseline()));
  expect(f.store.messages("10")).toEqual([]);
  const fresh = (BigInt(f.baseline()) + 1n).toString();
  f.gateway.events!.message(message(fresh));
  expect(f.store.messages("10").map(m => m.id)).toEqual([fresh]);
  f.store.ack("10", fresh);
  expect(f.store.messages("10")).toEqual([]);
});

test("pause stops reads and setup resumes; status includes channels and recent draft links", async () => {
  const f = fixture(); await f.bot.start("fake"); await f.setup(["10"]); await f.bot.reconcile();
  f.store.saveDraft(draft("pending"));
  const view = await f.action("status");
  expect(view.content).toContain("<#10>"); expect(view.content).toContain("未承認 https://discord.com/");
  await f.action("pause");
  expect(f.store.channelIds()).toEqual([]);
  f.gateway.events!.message(message(BigInt(f.baseline()).toString()));
  expect(f.store.messages("10")).toEqual([]);
  expect((await f.action("status")).content).toContain("一時停止中");
  await f.setup(["10"]);
  expect(f.store.settings()[0]?.paused).toBe(false);
});

test("leave deletes settings, unapproved drafts, cursors and inbox, then leaves the last guild", async () => {
  const f = fixture(); await f.setup(["10"]);
  f.store.saveDraft(draft("pending")); f.store.saveDraft(draft("approved", true));
  f.store.save(message("123"));
  await f.action("leave");
  expect(f.store.settings()).toEqual([]);
  expect(f.store.drafts("100", 1).map(d => d.id)).toEqual(["approved"]);
  expect(f.store.cursor("10")).toBe("0"); expect(f.store.messages("10")).toEqual([]);
  expect(f.gateway.leftGuilds).toEqual(["100"]);
});

test("leave one community preserves another community and shared channel", async () => {
  const f = fixture(); await f.setup(["10"]); await f.setup(["10", "11"], 2);
  f.store.saveDraft(draft("second", false, 2));
  // 残る集会 2 の導入後の投稿だけが残る（導入前の本文は消える）。
  const after = String(BigInt(f.store.baseline("10")) + 1n);
  f.store.save(message("123")); f.store.save(message(after));
  await f.action("leave");
  expect(f.store.settings().map(s => s.community.id)).toEqual([2]);
  expect(f.store.messages("10").map(m => m.id)).toEqual([after]);
  expect(f.store.drafts("100", 2)).toHaveLength(1);
  expect(f.gateway.leftGuilds).toEqual([]);
});

test("guildDelete removes every community and only unapproved drafts in that guild", async () => {
  const f = fixture(); await f.bot.start("fake"); await f.setup(["10"]); await f.setup(["11"], 2);
  f.store.configure({ guildId: "200", community: owner, channelIds: ["20"], notification: { type: "dm", userId } }, f.baseline());
  f.store.saveDraft(draft("a")); f.store.saveDraft(draft("b", false, 2)); f.store.saveDraft(draft("approved", true));
  f.store.saveDraft(draft("other", false, 1, "200"));
  f.gateway.events!.guildDelete!("100");
  expect(f.store.settings().map(s => s.guildId)).toEqual(["200"]);
  expect(f.store.channelIds()).toEqual(["20"]);
  expect(f.store.drafts("100", 1).map(d => d.id)).toEqual(["approved"]);
  expect(f.store.drafts("100", 2)).toEqual([]); expect(f.store.drafts("200", 1)).toHaveLength(1);
  expect(f.store.cursor("10")).toBe("0"); expect(f.gateway.leftGuilds).toEqual([]);
});

test("channel permission failure or revoked membership cannot commit settings", async () => {
  const f = fixture();
  f.gateway.beforeValidate = async () => { throw new Error("secret response body"); };
  const view = await f.setup();
  expect(view.content).toContain("失敗"); expect(f.store.settings()).toEqual([]);
  expect(JSON.stringify(f.logs)).not.toContain("secret");
  delete f.gateway.beforeValidate;
  let menu = await f.interact("setup"); menu = await f.select(menu, ["1"]); menu = await f.select(menu, ["10"]);
  f.setMemberships([]);
  expect((await f.select(menu, ["dm"])).content).toContain("失敗");
  expect(f.store.settings()).toEqual([]);
});

test("user, guild, expiry, and wizard order are checked on every component", async () => {
  const f = fixture();
  const view = await f.interact("setup");
  expect((await f.select(view, ["1"], { userId: "999999999999999999" })).content).toContain("古くなりました");
  expect((await f.select(view, ["1"], { guildId: "200" })).content).toContain("古くなりました");
  const next = await f.select(view, ["1"]);
  expect((await f.select(view, ["1"])).content).toContain("古くなりました");
  expect((await f.select(next, ["10"])).content).toContain("通知先");
  const fresh = await f.interact("setup"); f.tick(600_001);
  expect((await f.select(fresh, ["1"])).content).toContain("古くなりました");
  expect(f.store.settings()).toEqual([]);
});

test("a component from an earlier wizard stage gets a private reply without replacing the current menu", async () => {
  const f = fixture();
  const oldMenu = await f.interact("setup");
  const oldControl = oldMenu.controls[0]!;
  if (oldControl.type === "buttons") throw new Error("Expected community selector");
  const currentMenu = await f.select(oldMenu, ["1"]);
  expect(currentMenu.controls[0]?.type).toBe("channels");

  let sourceEdited = false;
  let privateReply: HubView | undefined;
  await f.hub.handle({ guildId: "100", userId, kind: "component", action: oldControl.id, values: ["2"],
    defer: async () => {}, edit: async () => { sourceEdited = true; },
    followUp: async view => { privateReply = view; } });
  expect(sourceEdited).toBe(false);
  expect(privateReply?.content).toContain("このメニューは古くなりました");
  expect(currentMenu.controls[0]?.type).toBe("channels");
});

test("guild deletion invalidates an in-flight authorization and cannot resurrect settings", async () => {
  const f = fixture();
  let menu = await f.interact("setup"); menu = await f.select(menu, ["1"]); menu = await f.select(menu, ["10"]);
  f.setLookup(async () => f.hub.guildDeleted("100"));
  await f.select(menu, ["dm"]);
  expect(f.store.settings()).toEqual([]);
});

test("removing a channel during history fetch cannot resurrect its inbox or cursor", async () => {
  const f = fixture(); await f.setup(["10"]);
  f.gateway.history = [message((BigInt(f.baseline()) + 1n).toString())];
  f.gateway.beforeFetch = async () => f.hub.guildDeleted("100");
  await f.bot.start("fake"); await f.bot.reconcile();
  expect(f.store.settings()).toEqual([]); expect(f.store.messages("10")).toEqual([]);
  expect(f.store.cursor("10")).toBe("0");
});

test("more than 25 communities have paginated menus and the staff selection retains recording permission", async () => {
  const f = fixture();
  f.setMemberships(Array.from({ length: 26 }, (_, n) => ({ ...staff, id: n + 1, name: `集会 ${n + 1}` })));
  let menu = await f.interact("setup");
  const buttonRow = menu.controls[1]!;
  if (buttonRow.type !== "buttons") throw new Error();
  const next = buttonRow.buttons[0]!;
  if (!("id" in next)) throw new Error();
  menu = await f.interact(next.id, [], "component");
  menu = await f.select(menu, ["26"]); menu = await f.select(menu, ["10"]); await f.select(menu, ["dm"]);
  expect(f.store.settings()[0]?.community).toMatchObject({ id: 26, role: "staff", recording_allowed: true });
});

test("removed inbox bodies are erased from database and WAL", async () => {
  const f = fixture(); await f.setup(["10"]);
  const secret = "SYNTHETIC-REMOVED-BODY-123";
  f.store.save({ ...message("123"), content: secret.repeat(1000) });
  await f.action("leave");
  for (const path of [f.path, `${f.path}-wal`]) if (existsSync(path)) expect(readFileSync(path).includes(Buffer.from(secret))).toBe(false);
  expect(JSON.stringify(f.logs)).not.toContain(secret);
});

test("saving rechecks the actor's channel access after selection and rejects a revocation", async () => {
  for (const purpose of ["read", "notify"]) {
    const f = fixture();
    let menu = await f.interact("setup"); menu = await f.select(menu, ["1"]); menu = await f.select(menu, ["10"]);
    if (purpose === "notify") menu = await f.select(menu, ["channel"]);
    f.gateway.beforeValidate = async () => {
      const call = f.gateway.validations.at(-1)!;
      expect(call.userId).toBe(userId);
      if (call.purpose === purpose) throw new Error("User cannot view channel");
    };
    const result = await f.select(menu, [purpose === "read" ? "dm" : "12"]);
    expect(result.content).toContain("失敗");
    expect(f.store.settings()).toEqual([]);
    expect(f.gateway.validations.filter(call => call.purpose === "read")).toHaveLength(2);
  }
});

test("last leave excludes setup during both reply and guild leave, then releases the exclusion", async () => {
  const f = fixture(); await f.setup(["10"]);
  const menu = await f.interact("leave");
  let releaseReply!: () => void;
  let replyStarted!: () => void;
  const replyGate = new Promise<void>(resolve => { releaseReply = resolve; });
  const replying = new Promise<void>(resolve => { replyStarted = resolve; });
  let releaseLeave!: () => void;
  let leaveStarted!: () => void;
  const leaveGate = new Promise<void>(resolve => { releaseLeave = resolve; });
  const leaving = new Promise<void>(resolve => { leaveStarted = resolve; });
  f.gateway.beforeLeave = async () => { leaveStarted(); await leaveGate; };
  const control = menu.controls[0]!;
  if (control.type === "buttons") throw new Error();
  const request = f.hub.handle({ guildId: "100", userId, action: control.id, values: ["1"], kind: "component",
    defer: async () => {}, edit: async () => { replyStarted(); await replyGate; }, followUp: async () => {} });
  try {
    await replying;
    expect((await f.interact("setup")).content).toContain("退出処理中");
    expect(f.store.settings()).toEqual([]);
    releaseReply(); await leaving;
    expect((await f.interact("setup")).content).toContain("退出処理中");
    f.hub.guildDeleted("100");
    releaseLeave();
  } finally { releaseReply(); releaseLeave(); }
  await request;
  expect((await f.setup(["10"])).content).toContain("保存しました");
});

test("leave checks the remaining setting count again immediately before exiting", async () => {
  const f = fixture(); await f.setup(["10"]);
  const menu = await f.interact("leave");
  const control = menu.controls[0]!;
  if (control.type === "buttons") throw new Error();
  await f.hub.handle({ guildId: "100", userId, action: control.id, values: ["1"], kind: "component",
    defer: async () => {}, edit: async () => {
      f.store.configure({ guildId: "100", community: staff, channelIds: ["11"], notification: { type: "dm", userId } }, f.baseline());
    }, followUp: async () => {} });
  expect(f.gateway.leftGuilds).toEqual([]);
  expect(f.store.settings().map(s => s.community.id)).toEqual([2]);
});

test("paused shared channel keeps its own cursor while another community starts and advances", async () => {
  const f = fixture();
  const configure = (community: HubCommunity, baseline: string) => f.store.configure({
    guildId: "100", community, channelIds: ["10"], notification: { type: "dm", userId },
  }, baseline);
  configure(owner, "100");
  f.store.pause("100", 1);
  configure(staff, "200");
  expect(f.store.cursor("10")).toBe("200");
  f.gateway.history = [message(150), message(250)];
  await f.bot.start("fake"); f.bot.refreshChannels(); await f.bot.reconcile();
  expect(f.store.messages("10").map(m => m.id)).toEqual(["250"]);
  expect(f.store.cursor("10")).toBe("250");
  f.store.ack("10", "250");
  configure(owner, "300"); f.bot.refreshChannels(); await f.bot.reconcile();
  expect(f.gateway.queries.some(q => q.query.after === "100")).toBe(true);
  expect(f.store.messages("10").map(m => m.id)).toEqual(["150", "250"]);
  expect(f.store.cursor("10")).toBe("250");
  const reopened = new HubStore(f.path);
  try { expect(reopened.cursor("10")).toBe("250"); } finally { reopened.close(); }
});

test("ready reconciliation removes absent guilds and pending drafts before any history fetch", async () => {
  const f = fixture(); await f.setup(["10"]);
  f.store.saveDraft(draft("pending")); f.store.saveDraft(draft("approved", true));
  f.store.configure({ guildId: "200", community: staff, channelIds: ["20"], notification: { type: "dm", userId } }, "100");
  f.store.saveDraft(draft("joined", false, 2, "200"));
  const start = f.gateway.start.bind(f.gateway);
  f.gateway.start = async () => { f.gateway.events!.guildsReady!(["200"]); await start(); };
  await f.bot.start("fake"); await f.bot.reconcile();
  expect(f.store.settings().map(s => s.guildId)).toEqual(["200"]);
  expect(f.store.drafts("100", 1).map(d => d.id)).toEqual(["approved"]);
  expect(f.store.drafts("200", 2).map(d => d.id)).toEqual(["joined"]);
  expect(f.gateway.queries.every(q => q.channelId === "20")).toBe(true);
  expect(f.logs).toContain("hub_guild_deleted");
  f.gateway.events!.guildsReady!([]);
  expect(f.store.settings()).toEqual([]);
  expect(f.store.drafts("200", 2)).toEqual([]);
});

test("message community names escape Markdown links, formatting, and headings", async () => {
  const f = fixture();
  f.setMemberships([{ ...owner, name: '[集会](https://example.invalid) *_~`|>#\\' }]);
  const view = await f.setup(["10"]);
  expect(view.content).toContain('\\[集会\\]\\(https://example.invalid\\) \\*\\_\\~\\`\\|\\>\\#\\\\');
  expect(f.store.settings()[0]?.community.name).toBe('[集会](https://example.invalid) *_~`|>#\\');
});

test("an old wizard and an earlier stage cannot invalidate the current session", async () => {
  const f = fixture();
  const old = await f.interact("setup");
  const current = await f.interact("setup");
  expect((await f.select(old, ["1"])).content).toContain("古くなりました");
  let menu = await f.select(current, ["1"]);
  expect((await f.select(current, ["1"])).content).toContain("古くなりました");
  menu = await f.select(menu, ["10"]);
  expect((await f.select(menu, ["dm"])).content).toContain("保存しました");
});


test("legacy shared cursors migrate conservatively and survive reopening without resetting progress", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-cursor-upgrade-"));
  const path = join(dir, "state.sqlite");
  const db = new Database(path);
  db.exec(`CREATE TABLE hub_channels (guild_id TEXT NOT NULL, community_id INTEGER NOT NULL,
    channel_id TEXT NOT NULL, baseline TEXT NOT NULL, PRIMARY KEY (guild_id, community_id, channel_id));
    INSERT INTO hub_channels VALUES ('100', 1, '10', '100'), ('100', 2, '10', '200');
    CREATE TABLE channel_cursors (channel_id TEXT PRIMARY KEY, last_message_id TEXT NOT NULL);
    INSERT INTO channel_cursors VALUES ('10', '250');`);
  db.close();
  let store: HubStore | undefined;
  try {
    store = new HubStore(path);
    // Configure retained channels to attach the legacy rows to their settings.
    for (const community of [owner, staff]) store.configure({
      guildId: "100", community, channelIds: ["10"], notification: { type: "dm", userId },
    }, "300");
    expect(store.cursor("10")).toBe("100");
    store.advance("10", "300");
    store.close(); store = new HubStore(path);
    expect(store.cursor("10")).toBe("300");
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});


test("a failed guild leave releases the setup exclusion", async () => {
  const f = fixture(); await f.setup(["10"]);
  f.gateway.beforeLeave = async () => { throw new Error("synthetic failure"); };
  expect((await f.action("leave")).content).toContain("失敗");
  expect((await f.setup(["10"])).content).toContain("保存しました");
});

test("leaving one community erases shared-channel bodies older than every remaining setup", () => {
  const f = fixture();
  const configure = (community: HubCommunity, baseline: string) => f.store.configure({
    guildId: "100", community, channelIds: ["10"], notification: { type: "dm", userId },
  }, baseline);
  configure(owner, "100");
  configure(staff, "200");
  f.store.save(message(150), true); f.store.save(message(250), true);
  f.store.leave("100", 1);
  expect(f.store.messages("10").map(m => m.id)).toEqual(["250"]);
});

test("a failed leave of the last guild is retried on the next ready and forgotten once the bot is gone", async () => {
  const f = fixture(); await f.setup(["10"]);
  f.gateway.beforeLeave = async () => { throw new Error("rest down"); };
  await f.action("leave").catch(() => {});
  expect(f.store.settings()).toEqual([]);
  expect(f.store.pendingLeaves()).toEqual(["100"]);
  f.gateway.beforeLeave = async () => {};
  f.hub.guildsReady(["100"]);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.gateway.leftGuilds).toEqual(["100", "100"]);
  expect(f.store.pendingLeaves()).toEqual([]);
  f.store.markPendingLeave("100");
  f.hub.guildsReady([]);
  expect(f.store.pendingLeaves()).toEqual([]);
  expect(f.gateway.leftGuilds).toHaveLength(2);
});

test("setup is refused while a pending guild leave is being retried", async () => {
  const f = fixture();
  f.store.markPendingLeave("100");
  let release!: () => void;
  f.gateway.beforeLeave = () => new Promise<void>(resolve => { release = resolve; });
  f.hub.guildsReady(["100"]);
  const view = await f.interact("setup");
  expect(view.content).toContain("退出処理中");
  release();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.store.pendingLeaves()).toEqual([]);
  expect(f.store.settings()).toEqual([]);
});

test("the pending leave is committed with the last setting's deletion even if the WAL truncate fails", async () => {
  const f = fixture(); await f.setup(["10"]);
  (f.store as unknown as { truncateWal: () => void }).truncateWal = () => { throw new Error("busy"); };
  await f.action("leave").catch(() => {});
  expect(f.store.settings()).toEqual([]);
  expect(f.store.pendingLeaves()).toEqual(["100"]);
});
