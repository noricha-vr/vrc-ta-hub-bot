import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_MAX_AGE_SECONDS, INBOX_PURGE_INTERVAL_MS, restrictDataPermissions } from "../src/main";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const DAY_MS = 86_400_000;

test("期限と削除周期を足しても本文の保持は 24 時間を超えない", () => {
  expect(INBOX_MAX_AGE_SECONDS * 1000 + INBOX_PURGE_INTERVAL_MS).toBeLessThanOrEqual(DAY_MS);
});

test("既存のデータディレクトリと DB ファイルの権限を起動時にそろえる", () => {
  const root = mkdtempSync(join(tmpdir(), "main-"));
  dirs.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { mode: 0o755 });
  chmodSync(dataDir, 0o755);
  const dbPath = join(dataDir, "state.sqlite");
  for (const path of [dbPath, `${dbPath}-wal`]) { writeFileSync(path, ""); chmodSync(path, 0o644); }
  restrictDataPermissions(dataDir, dbPath);
  expect(statSync(dataDir).mode & 0o777).toBe(0o700);
  expect(statSync(dbPath).mode & 0o777).toBe(0o600);
  expect(statSync(`${dbPath}-wal`).mode & 0o777).toBe(0o600);
});
