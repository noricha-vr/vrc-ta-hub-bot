import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

test("起動時の不一致で保存先の作成前に終了し、ログにはキー名だけを出す", () => {
  const root = mkdtempSync(join(tmpdir(), "main-config-"));
  dirs.push(root);
  const path = join(root, "custom.env");
  writeFileSync(path, "HUB_API_KEY=file-secret\nHUB_BASE_URL=https://file.invalid/private?secret=file-query\n");
  const dataDir = join(root, "data");
  const result = Bun.spawnSync([process.execPath, "--no-env-file", new URL("../src/main.ts", import.meta.url).pathname], {
    cwd: root, env: { BOT_ENV_FILE: path, BOT_DATA_DIR: dataDir,
      HUB_API_KEY: "shell-secret", HUB_BASE_URL: "https://shell.invalid/private?secret=shell-query" },
  });
  expect(result.exitCode).toBe(1);
  expect(existsSync(dataDir)).toBe(false);
  const output = result.stdout.toString() + result.stderr.toString();
  const logs = result.stderr.toString().trim().split("\n").map(line => JSON.parse(line));
  expect(logs.map(({ time, ...entry }) => entry)).toEqual([
    { event: "bot_config_conflict", keys: ["HUB_API_KEY", "HUB_BASE_URL"] }, { event: "bot_start_failed" },
  ]);
  for (const value of ["file-secret", "shell-secret", "file.invalid", "shell.invalid", "file-query", "shell-query"]) {
    expect(output).not.toContain(value);
  }
});

test("設定ファイルが読めない時も値やファイルパスをログに出さず終了する", () => {
  const root = mkdtempSync(join(tmpdir(), "main-config-"));
  dirs.push(root);
  const result = Bun.spawnSync([process.execPath, "--no-env-file", new URL("../src/main.ts", import.meta.url).pathname], {
    cwd: root, env: { BOT_ENV_FILE: join(root, "secret-path.env"), HUB_API_KEY: "shell-secret" },
  });
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("");
  const logs = result.stderr.toString().trim().split("\n").map(line => JSON.parse(line));
  expect(logs.map(({ time, ...entry }) => entry)).toEqual([{ event: "bot_start_failed" }]);
});

test("start は .env.local の自動読み込みをせず BOT_ENV_FILE の不一致を検出する", () => {
  const root = mkdtempSync(join(tmpdir(), "main-config-"));
  dirs.push(root);
  const path = join(root, "custom.env");
  writeFileSync(path, "HUB_API_KEY=file-secret\nHUB_BASE_URL=https://file.invalid\n");
  writeFileSync(join(root, ".env.local"), "HUB_API_KEY=unrelated-secret\n");
  const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const start = scripts.start.replace("src/main.ts", JSON.stringify(new URL("../src/main.ts", import.meta.url).pathname));
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { start } }));
  const result = Bun.spawnSync([process.execPath, "start"], {
    cwd: root, env: { PATH: dirname(process.execPath), BOT_ENV_FILE: path, HUB_BASE_URL: "https://shell.invalid" },
  });
  expect(result.exitCode).toBe(1);
  const logs = result.stderr.toString().split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
  expect(logs.map(({ time, ...entry }) => entry)).toEqual([
    { event: "bot_config_conflict", keys: ["HUB_BASE_URL"] }, { event: "bot_start_failed" },
  ]);
  for (const secret of ["file-secret", "unrelated-secret", "file.invalid", "shell.invalid"]) {
    expect(result.stdout.toString() + result.stderr.toString()).not.toContain(secret);
  }
});
