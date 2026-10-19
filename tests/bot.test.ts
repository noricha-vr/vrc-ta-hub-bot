import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubBot } from "../src/bot";
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
    expect(f.gateway.queries[0]?.query).toEqual({ limit: 100 });
    expect(f.health().reconnectCount).toBe(1);
    expect(f.health().recoveredMessageCount).toBe(3);
    expect(f.health().pendingChannelCount).toBe(0);
  });

  test("fills a gap larger than 100 messages without skipping a page", async () => {
    const f = fixture();
    f.store.save(message(1), true);
    f.gateway.history = Array.from({ length: 252 }, (_, index) => message(index + 1));
    await f.bot.start("fake");
    await f.bot.reconcile();
    expect(f.store.messages("10").map(item => item.id)).toEqual(f.gateway.history.map(item => item.id));
    expect(f.store.cursor("10")).toBe("252");
    expect(f.health().recoveredMessageCount).toBe(251);
    expect(f.gateway.queries.map(item => item.query)).toEqual([
      { limit: 100 }, { before: "153", limit: 100 }, { before: "53", limit: 100 },
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
    f.gateway.history = Array.from({ length: 151 }, (_, index) => message(index + 1));
    f.gateway.beforeFetch = async (_channelId, query) => {
      if (query.before) throw new Error("temporary network failure");
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
    expect(f.health().lastReceivedAt).toBeNull();
    expect(f.health().pendingChannelCount).toBe(0);
    expect(f.health().lastSuccessfulSyncAt).not.toBeNull();
    f.gateway.events!.message(message(1));
    expect(f.health().lastReceivedAt).not.toBeNull();
    await f.bot.stop();
    expect(f.health().connectionState).toBe("stopped");
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
