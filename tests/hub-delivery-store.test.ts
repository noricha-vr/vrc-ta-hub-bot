import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubDeliveryStore } from "../src/hub-delivery-store";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hub-delivery-"));
  dirs.push(dir);
  return join(dir, "state.sqlite");
}

test("旧 DB の保留は操作者・判断・試行回数・再送時刻を保って移行し、通常の配送待ちは変えない", () => {
  const path = databasePath();
  const legacy = new Database(path);
  legacy.exec(`CREATE TABLE hub_deliveries (
    draft_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, community_id INTEGER NOT NULL,
    hub_id INTEGER, state TEXT NOT NULL DEFAULT 'queued',
    attempted_hash TEXT NOT NULL DEFAULT '', synced_hash TEXT NOT NULL DEFAULT '',
    notified_hash TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '', decision TEXT, discord_id TEXT
  );
  INSERT INTO hub_deliveries (draft_id, guild_id, community_id, hub_id, state, attempts, next_at, reason, decision, discord_id)
    VALUES ('draft-1', '100', 1, 42, 'ready', 3, 2200, 'hub_review_retry', 'approved', '123'),
      ('draft-2', '100', 1, 43, 'ready', 2, 1600, 'hub_delivery_failed', 'rejected', '456'),
      ('queued', '100', 1, NULL, 'queued', 4, 3400, 'hub_delivery_failed', NULL, NULL),
      ('closed', '100', 1, 44, 'closed', 0, 0, 'approved', NULL, NULL);`);
  legacy.close();
  let store = new HubDeliveryStore(path);
  try {
    expect(store.decision("draft-1", "123")).toEqual({ draft_id: "draft-1", discord_id: "123",
      decision: "approved", attempts: 3, next_at: 2200 });
    expect(store.decision("draft-2", "456")).toEqual({ draft_id: "draft-2", discord_id: "456",
      decision: "rejected", attempts: 2, next_at: 1600 });
    expect(store.get("draft-1")).toMatchObject({ state: "ready", hub_id: 42, attempts: 0, next_at: 0, reason: "" });
    expect(store.get("queued")).toMatchObject({ state: "queued", attempts: 4, next_at: 3400, reason: "hub_delivery_failed" });
    expect(store.decisions("queued")).toEqual([]); expect(store.decisions("closed")).toEqual([]);
    expect(store.dueDecisions(1599)).toEqual([]);
    expect(store.dueDecisions(1600).map(row => row.draft_id)).toEqual(["draft-2"]);
    expect(store.counts()).toMatchObject({ ready: 2, queued: 1, closed: 1, retry: 3 });
    store.close(); store = new HubDeliveryStore(path);
    expect(store.decisions("draft-1")).toHaveLength(1);
    expect(store.decision("draft-1", "123")).toMatchObject({ attempts: 3, next_at: 2200 });
    store.clearDecision("draft-1", "123");
    store.closed("draft-2", "rejected");
    store.close(); store = new HubDeliveryStore(path);
    expect(store.decisions("draft-1")).toEqual([]); expect(store.decisions("draft-2")).toEqual([]);
    expect(store.dueDecisions(10000)).toEqual([]);
  } finally { store.close(); }
});

test("操作者ごとに保留とバックオフを持ち、押し直しと 403 でも他人の行を変更しない", () => {
  const path = databasePath();
  let store = new HubDeliveryStore(path);
  try {
    store.enqueue("draft", "100", 1); store.created("draft", 42, "hash");
    store.queueDecision("draft", "approved", "123"); store.retryDecision("draft", "123", 1000);
    store.queueDecision("draft", "rejected", "456"); store.retryDecision("draft", "456", 1100);
    store.retryDecision("draft", "123", 1300);
    const other = store.decision("draft", "456");
    store.queueDecision("draft", "rejected", "123");
    expect(store.decision("draft", "123")).toMatchObject({ decision: "rejected", attempts: 2, next_at: 1900 });
    expect(store.decision("draft", "456")).toEqual(other);
    expect(store.dueDecisions(1400).map(row => row.discord_id)).toEqual(["456"]);
    expect(store.counts().retry).toBe(1);
    store.clearDecision("draft", "123");
    expect(store.decision("draft", "456")).toEqual(other);
    store.close(); store = new HubDeliveryStore(path);
    expect(store.decision("draft", "456")).toEqual(other);
    expect(store.decision("draft", "123")).toBeUndefined();
    store.queueDecision("draft", "approved", "123");
    store.closed("draft", "approved");
    expect(store.decisions("draft")).toEqual([]); expect(store.counts().retry).toBe(0);
    store.close(); store = new HubDeliveryStore(path);
    expect(store.dueDecisions(10000)).toEqual([]);
  } finally { store.close(); }
});
