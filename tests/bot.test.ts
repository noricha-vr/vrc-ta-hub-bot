import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubBot } from "../src/bot";
import { loadConfig } from "../src/config";
import type { Health } from "../src/health";
import { MessageStore } from "../src/store";
import { FakeGateway, message } from "./fake-gateway";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

function fixture(channelIds = ["10"], heartbeatMs = 60000) {
  const dir = mkdtempSync(join(tmpdir(), "hub-bot-test-"));
  const store = new MessageStore(join(dir, "state.sqlite"));
  const gateway = new FakeGateway();
  const healthPath = join(dir, "health.json");
  const logs: string[] = [];
  let fatal = false;
  const bot = new HubBot(gateway, store, {
    channelIds, healthPath, heartbeatMs,
    envFilePath: join(dir, "bot.env"),
    hubHost: new URL(loadConfig({ DISCORD_TOKEN: "token", HUB_API_KEY: "key", JEV_API_KEY: "judge",
      HUB_BASE_URL: "https://example.invalid:8443/api-secret-path?secret=hidden" }).hubBaseUrl).hostname,
    log: event => logs.push(event), onFatal: () => { fatal = true; },
  });
  cleanups.push(async () => {
    await bot.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, gateway, bot, logs, health: () => JSON.parse(readFileSync(healthPath, "utf8")) as Health, fatal: () => fatal };
}

describe("durable gateway ingestion", () => {
  test("reconnect fetches only IDs newer than each channel's saved cursor", async () => {
    const f = fixture(["10", "11"]);
    f.store.save(message("9007199254740993"), true);
    f.store.save(message(5, "11"), true);
    await f.bot.start("fake");
    await f.bot.reconcile();
    f.gateway.events!.disconnected();
    f.gateway.events!.reconnecting();
    f.gateway.history = [
      message("9007199254740992"), message("9007199254740993"),
      message("9007199254740994"), message("9007199254740995"),
      message(4, "11"), message(5, "11"), message(6, "11"), message(99, "12"),
    ];
    f.gateway.queries.length = 0;
    f.gateway.events!.connected();
    f.gateway.events!.connected();
    await f.bot.reconcile();
    expect(f.store.messages("10").map(item => item.id)).toEqual([
      "9007199254740993", "9007199254740994", "9007199254740995",
    ]);
    expect(f.store.messages("11").map(item => item.id)).toEqual(["5", "6"]);
    expect(f.store.messages("12")).toEqual([]);
    expect(f.store.cursor("10")).toBe("9007199254740995");
    expect(f.store.cursor("11")).toBe("6");
    expect(f.gateway.queries[0]?.query).toEqual({ after: "9007199254740993", limit: 100 });
    expect(f.health().reconnectCount).toBe(1);
    expect(f.health().recoveredMessageCount).toBe(3);
    expect(f.health().pendingChannelCount).toBe(0);
  });

  test("fills a gap larger than 100 messages without skipping a page", async () => {
    const f = fixture();
    f.store.save(message(1), true);
    f.gateway.afterDirection = "nearest";
    f.gateway.history = Array.from({ length: 252 }, (_, index) => message(index + 1));
    await f.bot.start("fake");
    await f.bot.reconcile();
    expect(f.store.messages("10").map(item => item.id)).toEqual(f.gateway.history.map(item => item.id));
    expect(f.store.cursor("10")).toBe("252");
    expect(f.health().recoveredMessageCount).toBe(251);
    expect(f.gateway.queries.map(item => item.query)).toEqual([
      { after: "1", limit: 100 }, { after: "101", limit: 100 }, { after: "201", limit: 100 },
    ]);
  });

  test("resume replay before connected and live arrivals during recovery cannot skip gaps", async () => {
    const f = fixture();
    f.store.save(message(1), true);
    await f.bot.start("fake");
    await f.bot.reconcile();
    f.gateway.events!.disconnected();
    f.gateway.events!.message(message(5)); // replayed by the SDK before resume
    expect(f.store.cursor("10")).toBe("1");
    f.gateway.history = [message(2), message(3), message(4), message(5), message(6)];
    let liveSent = false;
    f.gateway.beforeFetch = async () => {
      if (liveSent) return;
      liveSent = true;
      f.gateway.events!.message(message(6));
      expect(f.store.cursor("10")).toBe("1");
    };
    f.gateway.events!.connected();
    await f.bot.reconcile();
    expect(f.store.messages("10").map(item => item.id)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(f.store.cursor("10")).toBe("6");
    expect(f.health().recoveredMessageCount).toBe(3);
  });

  test("partial recovery failure keeps cursor and safely retries without duplicates", async () => {
    const f = fixture();
    f.store.save(message(1), true);
    f.gateway.afterDirection = "nearest";
    f.gateway.history = Array.from({ length: 151 }, (_, index) => message(index + 1));
    f.gateway.beforeFetch = async (_channelId, query) => {
      if (query.after === "101") throw new Error("temporary network failure");
    };
    await f.bot.start("fake");
    await f.bot.reconcile();
    expect(f.store.cursor("10")).toBe("1");
    expect(f.store.messages("10")).toHaveLength(101);
    expect(f.health().pendingChannelCount).toBe(1);
    expect(f.logs).toContain("history_recovery_failed");
    delete f.gateway.beforeFetch;
    await f.bot.reconcile();
    expect(f.store.messages("10")).toHaveLength(151);
    expect(f.store.cursor("10")).toBe("151");
    expect(f.health().recoveredMessageCount).toBe(150);
  });

  test("a live save failure during recovery keeps the channel pending until a later recovery saves it", async () => {
    const f = fixture();
    f.store.save(message(1), true);
    f.gateway.history = [message(2)];
    const save = f.store.save.bind(f.store);
    f.store.save = (item, advance) => {
      if (item.id === "3") throw new Error("disk full");
      return save(item, advance);
    };
    let liveSent = false;
    f.gateway.beforeFetch = async () => {
      if (liveSent) return;
      liveSent = true;
      f.gateway.events!.message(message(3)); // fails to persist
      f.gateway.events!.message(message(4));
    };
    await f.bot.start("fake");
    await f.bot.reconcile();
    expect(f.logs).toContain("message_store_failed");
    expect(f.health().pendingChannelCount).toBe(1);
    expect(f.store.cursor("10")).toBe("1");
    f.gateway.events!.message(message(5)); // still pending: must not jump the cursor past 3
    expect(f.store.cursor("10")).toBe("1");
    f.store.save = save;
    f.gateway.history = [message(2), message(3), message(4), message(5)];
    await f.bot.reconcile();
    expect(f.store.messages("10").map(item => item.id)).toEqual(["1", "2", "3", "4", "5"]);
    expect(f.store.cursor("10")).toBe("5");
    expect(f.health().pendingChannelCount).toBe(0);
  });

  test("one failed channel does not prevent recovery of other selected channels", async () => {
    const f = fixture(["10", "11"]);
    f.gateway.history = [message(1), message(2, "11")];
    f.gateway.beforeFetch = async channel => { if (channel === "10") throw new Error("no access"); };
    await f.bot.start("fake");
    await f.bot.reconcile();
    expect(f.store.cursor("10")).toBe("0");
    expect(f.store.cursor("11")).toBe("2");
    expect(f.health().pendingChannelCount).toBe(1);
  });

  test("a disconnect during an in-flight fetch cannot advance a stale cursor", async () => {
    const f = fixture();
    f.store.save(message(1), true);
    f.gateway.history = [message(2), message(3)];
    f.gateway.beforeFetch = async () => f.gateway.events!.disconnected();
    await f.bot.start("fake");
    await f.bot.reconcile();
    expect(f.store.cursor("10")).toBe("1");
    expect(f.health().connectionState).toBe("disconnected");
    delete f.gateway.beforeFetch;
    f.gateway.events!.connected();
    await f.bot.reconcile();
    expect(f.store.cursor("10")).toBe("3");
  });

  test("saved cursor and inbox survive restart and live duplicates are harmless", async () => {
    const f = fixture();
    await f.bot.start("fake");
    await f.bot.reconcile();
    f.gateway.events!.message(message(5));
    f.gateway.events!.message(message(5));
    f.gateway.events!.message(message(3));
    f.gateway.events!.message(message(99, "12"));
    expect(f.store.cursor("10")).toBe("5");
    await f.bot.stop();
    const reopened = new MessageStore(join(f.dir, "state.sqlite"));
    const gateway = new FakeGateway();
    gateway.history = [message(3), message(5), message(6)];
    const bot = new HubBot(gateway, reopened, { channelIds: ["10"], healthPath: join(f.dir, "restart-health.json") });
    try {
      await bot.start("fake");
      await bot.reconcile();
      expect(reopened.messages("10").map(item => item.id)).toEqual(["3", "5", "6"]);
      expect(reopened.messages("12")).toEqual([]);
      expect(JSON.parse(readFileSync(join(f.dir, "restart-health.json"), "utf8")).recoveredMessageCount).toBe(1);
    } finally {
      await bot.stop();
      reopened.close();
    }
  });

  test("writes health JSON with heartbeat even for an idle channel and retries failures", async () => {
    const f = fixture(["10"], 10);
    f.gateway.beforeFetch = async () => { throw new Error("temporary error"); };
    await f.bot.start("fake");
    await f.bot.reconcile();
    const previous = f.health().updatedAt;
    delete f.gateway.beforeFetch;
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(f.health().updatedAt > previous).toBe(true);
    expect(f.health().connectionState).toBe("connected");
    expect(f.health().envFilePath).toBe(join(f.dir, "bot.env"));
    expect(f.health().hubHost).toBe("example.invalid");
    expect(JSON.stringify(f.health())).not.toContain("hidden");
    expect(JSON.stringify(f.health())).not.toContain("/api-secret-path");
    expect(f.health().lastReceivedAt).toBeNull();
    expect(f.health().pendingChannelCount).toBe(0);
    expect(f.health().lastSuccessfulSyncAt).not.toBeNull();
    f.gateway.events!.message(message(1));
    expect(f.health().lastReceivedAt).not.toBeNull();
    await f.bot.stop();
    expect(f.health().connectionState).toBe("stopped");
    expect(f.health().envFilePath).toBe(join(f.dir, "bot.env"));
    expect(f.health().hubHost).toBe("example.invalid");
  });

  test("startup failure destroys gateway, stops heartbeat, and redacts raw error", async () => {
    const f = fixture();
    f.gateway.failStart = true;
    await expect(f.bot.start("fake")).rejects.toThrow("Gateway startup failed");
    expect(f.gateway.stopped).toBe(true);
    expect(f.gateway.events).toBeUndefined();
    expect(f.health().connectionState).toBe("error");
    expect(f.logs).toEqual(["gateway_start_failed"]);
  });

  test("fatal session invalidation requests shutdown and marks health as error", async () => {
    const f = fixture();
    await f.bot.start("fake");
    await f.bot.reconcile();
    f.gateway.events!.fatal();
    expect(f.fatal()).toBe(true);
    expect(f.health().connectionState).toBe("error");
  });

  test("health write failures do not stop durable reception", async () => {
    const f = fixture();
    await f.bot.start("fake");
    await f.bot.reconcile();
    mkdirSync(join(f.dir, "health.json.tmp"));
    f.gateway.events!.message(message(1));
    expect(f.logs).toContain("health_write_failed");
    expect(f.store.cursor("10")).toBe("1");
    expect(f.store.messages("10")).toEqual([message(1)]);
  });
});

test("history starts after the setup boundary and discards unexpectedly returned older IDs", async () => {
  const f = fixture();
  f.store.advance("10", "100");
  f.gateway.fetchMessages = async (channelId, query) => {
    f.gateway.queries.push({ channelId, query });
    return [message(99), message(101), message(100)];
  };
  await f.bot.start("fake"); await f.bot.reconcile();
  expect(f.gateway.queries[0]).toEqual({ channelId: "10", query: { after: "100", limit: 100 } });
  expect(f.store.messages("10").map(m => m.id)).toEqual(["101"]);
  expect(f.store.cursor("10")).toBe("101");
});

test("history recovery only requests after pages and never fetches at or below the setup boundary", async () => {
  const f = fixture();
  f.store.advance("10", "100");
  f.gateway.history = Array.from({ length: 200 }, (_, n) => message(n + 1));
  await f.bot.start("fake"); await f.bot.reconcile();
  expect(f.gateway.queries.map(item => item.query)).toEqual([
    { after: "100", limit: 100 }, { after: "200", limit: 100 },
  ]);
  expect(f.gateway.responses.every(response => response.query.after !== undefined)).toBe(true);
  expect(f.gateway.responses.flatMap(response => response.ids).every(id => BigInt(id) > 100n)).toBe(true);
  expect(f.store.messages("10").map(item => item.id)).toEqual(Array.from({ length: 100 }, (_, n) => String(n + 101)));
  expect(f.store.cursor("10")).toBe("200");
});

test("after pagination sorts IDs and advances with each page maximum", async () => {
  const f = fixture();
  f.store.advance("10", "100");
  f.gateway.afterDirection = "nearest";
  f.gateway.history = Array.from({ length: 451 }, (_, n) => message(n + 1));
  await f.bot.start("fake"); await f.bot.reconcile();
  expect(f.gateway.queries.map(item => item.query)).toEqual([
    { after: "100", limit: 100 }, { after: "200", limit: 100 },
    { after: "300", limit: 100 }, { after: "400", limit: 100 },
  ]);
  expect(f.gateway.queries.every(item => item.query.after !== undefined)).toBe(true);
  expect(f.store.messages("10").map(item => item.id)).toEqual(Array.from({ length: 351 }, (_, n) => String(n + 101)));
  expect(f.store.cursor("10")).toBe("451");
  expect(f.health().pendingChannelCount).toBe(0);
});

test("recovery caps each channel at 20 pages and lets other channels progress", async () => {
  const f = fixture(["10", "11"]);
  f.gateway.afterDirection = "nearest";
  f.gateway.history = [...Array.from({ length: 2050 }, (_, n) => message(n + 1)), message(7, "11")];
  await f.bot.start("fake"); await f.bot.reconcile();
  expect(f.gateway.queries.filter(item => item.channelId === "10")).toHaveLength(20);
  expect(f.gateway.queries.some(item => item.channelId === "11")).toBe(true);
  expect(f.store.cursor("10")).toBe("2000");
  expect(f.store.messages("10")).toHaveLength(2000);
  expect(f.store.cursor("11")).toBe("7");
  expect(f.store.messages("11").map(item => item.id)).toEqual(["7"]);
  expect(f.health().pendingChannelCount).toBe(1);
  expect(f.logs).toContain("history_recovery_page_limit");
  await f.bot.reconcile();
  expect(f.gateway.queries.filter(item => item.channelId === "10")).toHaveLength(21);
  expect(f.gateway.queries.at(-1)?.query).toEqual({ after: "2000", limit: 100 });
  expect(f.store.cursor("10")).toBe("2050");
  expect(f.store.messages("10")).toHaveLength(2050);
  expect(f.health().pendingChannelCount).toBe(0);
});

test("受信と補完から後続処理を起動し、承認操作と送信処理の完了を待ってから停止する", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-worker-test-"));
  const store = new MessageStore(join(dir, "state.sqlite"));
  const gateway = new FakeGateway();
  let workCalls = 0;
  let finishWork: () => void = () => {};
  let finishReview: () => void = () => {};
  let reviewCalls = 0;
  const work = {
    run: async () => { workCalls++; await new Promise<void>(resolve => { finishWork = resolve; }); },
    review: { handle: async () => { reviewCalls++; await new Promise<void>(resolve => { finishReview = resolve; }); } },
  };
  const bot = new HubBot(gateway, store, { channelIds: ["10"], work, healthPath: join(dir, "health.json") });
  cleanups.push(async () => { finishWork(); finishReview(); await bot.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  await bot.start("fake"); await bot.reconcile();
  expect(workCalls).toBe(1);
  gateway.events!.message(message("101"));
  expect(workCalls).toBe(1);
  gateway.events!.interaction!({ guildId: null, userId: "20", kind: "component", action: "hub-review:token:approved", values: [],
    defer: async () => {}, edit: async () => {}, followUp: async () => {} });
  expect(reviewCalls).toBe(1);
  let stopped = false;
  const stopping = bot.stop().then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false); expect(gateway.stopped).toBe(false);
  finishWork(); finishReview(); await stopping;
  expect(stopped).toBe(true); expect(gateway.stopped).toBe(true);
});

test("補完に失敗したチャンネルの新着は待たせ、他のチャンネルの処理を続ける", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-worker-test-"));
  const store = new MessageStore(join(dir, "state.sqlite"));
  const gateway = new FakeGateway();
  const processed: string[] = [];
  const work = {
    run: async (channelReady: (channelId: string) => boolean) => {
      for (const channelId of ["10", "11"]) {
        if (!channelReady(channelId)) continue;
        for (const item of store.messages(channelId)) {
          processed.push(item.id); store.ack(channelId, item.id);
        }
      }
    },
    review: { handle: async () => {} },
  };
  const bot = new HubBot(gateway, store, { channelIds: ["10", "11"], work, healthPath: join(dir, "health.json"), heartbeatMs: 60000 });
  cleanups.push(async () => { await bot.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  gateway.history = [message("101"), message("201", "11")];
  gateway.beforeFetch = async channelId => { if (channelId === "10") throw new Error("synthetic history failure"); };
  await bot.start("fake"); await bot.reconcile(); await Bun.sleep(0);
  expect(processed).toEqual(["201"]);
  gateway.events!.message(message("103")); await Bun.sleep(0);
  gateway.events!.message(message("202", "11")); await Bun.sleep(0);
  expect(processed).toEqual(["201", "202"]);
  expect(store.messages("10").map(item => item.id)).toEqual(["103"]);
  expect(store.cursor("10")).toBe("0");
  gateway.history.push(message("102"), message("103")); delete gateway.beforeFetch;
  await bot.reconcile();
  expect(processed).toEqual(["201", "202", "101", "102", "103"]);
  expect(store.messages("10")).toEqual([]); expect(store.cursor("10")).toBe("103");
});
