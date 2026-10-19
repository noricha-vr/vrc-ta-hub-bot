import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

function fileContains(path: string, needle: string): boolean {
  return existsSync(path) && readFileSync(path).includes(Buffer.from(needle));
}

for (const how of ["ack", "purge"] as const) {
  test(`${how} で消した本文は DB ファイルと WAL のバイト列に残らない`, () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"));
    dirs.push(dir);
    const path = join(dir, "state.sqlite");
    const store = new MessageStore(path);
    const secret = "SYNTHETIC-BODY-7f3a9c";
    // 頁をまたぐ長さにして、空きリストへ回るオーバーフロー頁も確かめる（FAST 既定では消えない）。
    const longBody = `${secret}-gone `.repeat(1000);
    store.save({ ...message("10"), content: longBody });
    store.save(message("11"));
    if (how === "ack") store.ack("c1", "10");
    else store.purge(0, Math.floor(Date.now() / 1000) + 10);
    expect(fileContains(path, `${secret}-gone`)).toBe(false);
    expect(fileContains(`${path}-wal`, `${secret}-gone`)).toBe(false);
    store.close();
  });
}
