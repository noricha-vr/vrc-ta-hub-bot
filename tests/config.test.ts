import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigConflictError, loadConfig, loadConfigFile } from "../src/config";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function envFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "config-"));
  dirs.push(dir);
  const path = join(dir, "bot.env");
  writeFileSync(path, contents);
  return path;
}

const env = {
  DISCORD_TOKEN: "test-placeholder", HUB_API_KEY: "test-placeholder", JEV_API_KEY: "test-placeholder",
  HUB_BASE_URL: "https://example.invalid",
};

test("configuration starts without fixed channels and reserves API settings", () => {
  const config = loadConfig(env);
  expect("channelIds" in config).toBe(false);
  expect(config.hubBaseUrl).toBe("https://example.invalid");
  expect(config.dataDir.endsWith("/data")).toBe(true);
});

test("invalid settings fail without exposing provided values", () => {
  expect(() => loadConfig({ ...env, DISCORD_TOKEN: "" })).toThrow("DISCORD_TOKEN");
  expect(() => loadConfig({ ...env, HUB_BASE_URL: "not-a-url" })).toThrow("HTTP(S)");
  expect(() => loadConfig({ ...env, HUB_BASE_URL: "https://user:password@example.invalid" })).toThrow("without credentials");
});

test("Hub API keys require HTTPS except on the two local HTTP hosts", () => {
  for (const url of ["http://example.invalid", "http://localhost.example.invalid", "http://127.0.0.2", "ftp://localhost", "http://[::1]"]) {
    expect(() => loadConfig({ ...env, HUB_BASE_URL: url })).toThrow("requires HTTPS");
  }
  for (const url of ["https://example.invalid", "http://localhost:8080", "http://127.0.0.1:8080/path"]) {
    expect(loadConfig({ ...env, HUB_BASE_URL: url }).hubBaseUrl).toBe(url);
  }
});

test("指定した設定ファイルを読み、未記載の設定は環境変数から補う", () => {
  const path = envFile('# settings\nexport HUB_API_KEY="file-key # literal"\nHUB_BASE_URL=https://file.invalid\n');
  const config = loadConfigFile({ DISCORD_TOKEN: "token", JEV_API_KEY: "judge", BOT_ENV_FILE: path });
  expect(config.envFilePath).toBe(path);
  expect(config.hubApiKey).toBe("file-key # literal");
  expect(config.hubBaseUrl).toBe("https://file.invalid");
});

test("設定ファイルと同じ環境変数は許可し、無関係な環境変数は比較しない", () => {
  const path = envFile('HUB_API_KEY="test-placeholder"\nUNUSED=\n');
  expect(loadConfigFile({ ...env, BOT_ENV_FILE: path, UNUSED: "", OTHER: "shell-only" }).hubApiKey).toBe(env.HUB_API_KEY);
});

test("設定ファイル内の全キーを比較し、空文字や空白の違いも検出する", () => {
  const path = envFile('HUB_API_KEY=file-secret\nBOT_DATA_DIR=file-data\nUNUSED=\n');
  let error: unknown;
  try { loadConfigFile({ ...env, BOT_ENV_FILE: path, HUB_API_KEY: "", BOT_DATA_DIR: "file-data ", UNUSED: "shell-secret" }); }
  catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(ConfigConflictError);
  expect((error as ConfigConflictError).keys).toEqual(["BOT_DATA_DIR", "HUB_API_KEY", "UNUSED"]);
  expect((error as Error).message).not.toContain("file-secret");
  expect((error as Error).message).not.toContain("shell-secret");
  expect((error as Error).message).not.toContain("file-data");
});

test("設定ファイルがない場合やディレクトリの場合は環境変数だけで起動しない", () => {
  const path = envFile("");
  expect(() => loadConfigFile({ ...env, BOT_ENV_FILE: `${path}.missing` })).toThrow("Cannot read BOT_ENV_FILE");
  mkdirSync(`${path}.dir`);
  expect(() => loadConfigFile({ ...env, BOT_ENV_FILE: `${path}.dir` })).toThrow("Cannot read BOT_ENV_FILE");
});

test("設定ファイル中の変数参照はシェルの値で展開しない", () => {
  const path = envFile("HUB_API_KEY='$OTHER'\n");
  expect(loadConfigFile({ DISCORD_TOKEN: "token", JEV_API_KEY: "judge", HUB_BASE_URL: env.HUB_BASE_URL,
    BOT_ENV_FILE: path, OTHER: "shell-secret" }).hubApiKey).toBe("$OTHER");
});

test("既定では作業ディレクトリの .env.local を明示的に読む", () => {
  const path = envFile("");
  const dir = join(path, "..");
  writeFileSync(join(dir, ".env.local"), 'HUB_API_KEY="local-key"\n');
  writeFileSync(join(dir, ".env"), 'HUB_API_KEY="other-key"\n');
  const modulePath = new URL("../src/config.ts", import.meta.url).pathname;
  const result = Bun.spawnSync([process.execPath, "--no-env-file", "-e",
    `import { loadConfigFile } from ${JSON.stringify(modulePath)}; const config = loadConfigFile(process.env); console.log(JSON.stringify({ path: config.envFilePath, key: config.hubApiKey }));`], {
    cwd: dir, env: { DISCORD_TOKEN: "token", JEV_API_KEY: "judge", HUB_BASE_URL: env.HUB_BASE_URL },
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({ path: realpathSync(join(dir, ".env.local")), key: "local-key" });
});
