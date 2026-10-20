import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubDeliveryStore } from "../src/hub-delivery-store";
import { HubStore } from "../src/hub-store";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hub-delivery-"));
  dirs.push(dir);
  const path = join(dir, "state.sqlite");
  const settings = new HubStore(path);
  try {
    for (const [guildId, id] of [["100", 1], ["100", 2], ["200", 1]] as const) {
      settings.configure({ guildId, community: { id, name: "集会", role: "owner", recording_allowed: false },
        channelIds: ["10"], notification: { type: "dm", userId: "123" } }, "100");
    }
  } finally { settings.close(); }
  return path;
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
    expect(store.decision("draft-1", "123")).toMatchObject({ draft_id: "draft-1", discord_id: "123",
      decision: "approved", attempts: 3, next_at: 2200 });
    expect(store.decision("draft-2", "456")).toMatchObject({ draft_id: "draft-2", discord_id: "456",
      decision: "rejected", attempts: 2, next_at: 1600 });
    expect(store.get("draft-1")).toMatchObject({ state: "ready", hub_id: 42, attempts: 0, next_at: 0, reason: "" });
    expect(store.get("draft-1")?.source_url).toBe("");
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

test("操作者別の旧 DB には開始時刻を補い、件数と待ち時間を再起動後も保持する", () => {
  const path = databasePath();
  const legacy = new Database(path);
  legacy.exec(`CREATE TABLE hub_review_decisions (
    draft_id TEXT NOT NULL, discord_id TEXT NOT NULL, decision TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (draft_id, discord_id)
  );
  INSERT INTO hub_review_decisions VALUES ('draft', '123', 'approved', 2, 1600);`);
  legacy.close();
  const before = Math.floor(Date.now() / 1000);
  let store = new HubDeliveryStore(path);
  try {
    store.enqueue("draft", "100", 1); store.created("draft", 42, "hash");
    const pending = store.decision("draft", "123")!;
    expect(pending).toMatchObject({ decision: "approved", attempts: 2, next_at: 1600 });
    expect(pending.created_at).toBeGreaterThanOrEqual(before);
    expect(pending.created_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(store.pendingReviews(pending.created_at + 45)).toEqual({ count: 1, oldestAgeSeconds: 45 });
    store.close(); store = new HubDeliveryStore(path);
    expect(store.decision("draft", "123")).toEqual(pending);
    expect(store.pendingReviews(pending.created_at - 1)).toEqual({ count: 1, oldestAgeSeconds: 0 });
  } finally { store.close(); }
});

test("旧通知の編集待ちを保って終了理由の列を追加し、終了状態を再起動後も保持する", () => {
  const path = databasePath();
  const legacy = new Database(path);
  legacy.exec(`CREATE TABLE hub_review_notifications (
    draft_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT NOT NULL,
    edited INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, message_id)
  );
  INSERT INTO hub_review_notifications VALUES ('draft', '11', '501', 0, 2, 1600);`);
  legacy.close();
  let store = new HubDeliveryStore(path);
  try {
    store.enqueue("draft", "100", 1); store.closed("draft", "approved");
    expect(store.dueNotifications(1599)).toEqual([]);
    const pending = store.dueNotifications(1600)[0]!;
    expect(pending).toMatchObject({ attempts: 2, next_at: 1600, edited: 0, closed_reason: "" });
    expect(store.counts().retry).toBe(1);
    store.close(); store = new HubDeliveryStore(path);
    expect(store.dueNotifications(1600)).toEqual([pending]);
    store.notificationClosed(pending, "unknown_message");
    store.close(); store = new HubDeliveryStore(path);
    expect(store.dueNotifications(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(store.counts().retry).toBe(0);
  } finally { store.close(); }
});

test("未確認者の上限と再送の 5 件枠は下書きごとに持ち、主催者の実績はサーバーと集会で分ける", () => {
  const store = new HubDeliveryStore(databasePath());
  try {
    for (const [id, guildId, communityId] of [["first", "100", 1], ["same", "100", 1],
      ["other-community", "100", 2], ["other-guild", "200", 1]] as const) {
      store.enqueue(id, guildId, communityId); store.created(id, 42, "hash");
    }
    store.recordReviewer("first", "owner"); store.closed("first", "approved");
    for (const id of ["same", "other-community", "other-guild"]) {
      for (const actor of ["1", "2", "3", "4", "owner"]) expect(store.queueDecision(id, "approved", actor, 1000)).toBe(true);
      expect(store.queueDecision(id, "approved", "sixth", 1001)).toBe(id === "same");
      expect(store.queueDecision(id, "approved", "seventh", 1001)).toBe(false);
      store.retryDecision(id, "owner", 1000);
      expect(store.queueDecision(id, "rejected", "owner", 1100)).toBe(true);
      expect(store.decision(id, "owner")).toMatchObject({ created_at: 1000, decision: "rejected", attempts: 1, next_at: 1300 });
    }
    expect(store.dueDecisions(1299)).toHaveLength(13);
    const due = store.dueDecisions(1300);
    expect(due).toHaveLength(16);
    expect(due.filter(r => r.draft_id === "same").map(r => r.discord_id)).toEqual(["owner", "1", "2", "3", "4", "sixth"]);
    for (const id of ["other-community", "other-guild"]) {
      expect(due.filter(r => r.draft_id === id).map(r => r.discord_id)).toEqual(["1", "2", "3", "4", "owner"]);
    }
    expect(store.pendingReviews(1090)).toEqual({ count: 16, oldestAgeSeconds: 90 });
    expect(store.pendingReviews(1090, "100", 1)).toEqual({ count: 6, oldestAgeSeconds: 90 });
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

test("閉じた配送は資料の変更か再試行がある時だけ返し、再送時刻と取り外しを守る", () => {
  const store = new HubDeliveryStore(databasePath());
  try {
    for (const id of ["approved", "rejected", "removed", "ready"]) {
      store.enqueue(id, "100", 1); store.created(id, 42, "hash");
    }
    store.closed("approved", "approved"); store.closed("rejected", "rejected"); store.closed("removed", "setting_removed");
    expect(store.due(1000).map(row => row.draft_id)).toEqual(["ready"]);
    expect(store.due(1000, ["approved", "removed"]).map(row => row.draft_id)).toEqual(["approved", "ready"]);
    store.retry("rejected", 1000, "hub_delivery_failed");
    expect(store.due(1299, ["rejected"]).map(row => row.draft_id)).toEqual(["ready"]);
    expect(store.due(1300).map(row => row.draft_id)).toEqual(["rejected", "ready"]);
    store.synced("rejected", "changed");
    expect(store.due(1300).map(row => row.draft_id)).toEqual(["ready"]);
    expect(store.get("rejected")).toMatchObject({ state: "closed", reason: "rejected", synced_hash: "changed", attempts: 0 });
  } finally { store.close(); }
});

test("作成時の出典を再起動と取り外し後も保持し、未作成が確定した再送では選び直せる", () => {
  const path = databasePath(); let store = new HubDeliveryStore(path);
  try {
    const sourceUrl = "https://discord.com/channels/100/10/201";
    store.enqueue("draft", "100", 1); store.creating("draft", "hash", sourceUrl);
    store.close(); store = new HubDeliveryStore(path);
    expect(store.get("draft")).toMatchObject({ state: "creating", source_url: sourceUrl, attempted_hash: "hash" });
    store.closed("draft", "setting_removed"); store.enqueue("draft", "200", 1);
    expect(store.get("draft")).toMatchObject({ state: "creating", guild_id: "200", source_url: sourceUrl });
    store.requeue("draft");
    expect(store.get("draft")).toMatchObject({ state: "queued", source_url: "", attempted_hash: "" });
  } finally { store.close(); }
});

test("本文の編集待ちは再起動後も保持し、本文編集済みでも確定後の結果を編集する", () => {
  const path = databasePath(); let store = new HubDeliveryStore(path);
  try {
    store.enqueue("draft", "100", 1); store.created("draft", 42, "first");
    store.notified("draft", "notice", { channelId: "11", messageId: "501" }, "target");
    expect(store.dueNotifications(1000)).toEqual([]);
    store.synced("draft", "second");
    const pending = store.dueNotifications(1000)[0]!;
    expect(pending).toMatchObject({ content_hash: "first", target_key: "target", edited: 0 });
    store.retryNotification(pending, 1000);
    store.close(); store = new HubDeliveryStore(path);
    expect(store.dueNotifications(1299)).toEqual([]); expect(store.counts().retry).toBe(1);
    const retry = store.dueNotifications(1300)[0]!;
    expect(retry).toMatchObject({ attempts: 1, next_at: 1300, content_hash: "first" });
    store.notificationUpdated(retry, "second");
    expect(store.dueNotifications(1300)).toEqual([]); expect(store.counts().retry).toBe(0);
    store.closed("draft", "approved");
    const result = store.dueNotifications(1300)[0]!;
    expect(result).toMatchObject({ edited: 0, content_hash: "second" });
    store.notificationEdited(result); store.synced("draft", "third");
    store.close(); store = new HubDeliveryStore(path);
    expect(store.dueNotifications(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(store.notifications("draft")[0]).toMatchObject({ edited: 1, content_hash: "second" });
  } finally { store.close(); }
});
