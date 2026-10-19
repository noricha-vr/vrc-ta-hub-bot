import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageStore } from "../src/store";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function open(): MessageStore {
  const dir = mkdtempSync(join(tmpdir(), "store-"));
  dirs.push(dir);
  return new MessageStore(join(dir, "state.sqlite"));
}

const message = (id: string) => ({ id, channelId: "c1", authorId: "u1", content: "本文", createdAt: "2026-10-19T00:00:00Z" });

test("処理済みの投稿は受信箱から本文ごと消える", () => {
  const store = open();
  store.save(message("10"));
  store.save(message("11"));
  store.ack("c1", "10");
  expect(store.messages("c1").map(m => m.id)).toEqual(["11"]);
  store.close();
});

test("期限を過ぎた未処理の本文は purge で消え、カーソルは残る", () => {
  const store = open();
  store.save(message("10"), true);
  expect(store.purge(3600, Math.floor(Date.now() / 1000) + 7200)).toBe(1);
  expect(store.messages("c1")).toEqual([]);
  expect(store.cursor("c1")).toBe("10");
  store.close();
});
