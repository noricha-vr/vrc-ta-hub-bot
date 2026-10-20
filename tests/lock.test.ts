import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireLock, LockExistsError } from "../src/lock";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("exclusive lock rejects a second process and releases cleanly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-lock-test-"));
  dirs.push(dir);
  const path = join(dir, "bot.lock");
  const release = acquireLock(path);
  try {
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(process.pid);
    const script = `import { acquireLock } from ${JSON.stringify(resolve("src/lock.ts"))};
      try { acquireLock(process.argv[1]); process.exit(0); } catch { process.exit(23); }`;
    const child = Bun.spawn([process.execPath, "-e", script, path], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(23);
    expect(() => acquireLock(path)).toThrow("Bot lock already exists");
  } finally {
    release();
  }
  release(); // idempotent
  expect(existsSync(path)).toBe(false);
  const nextRelease = acquireLock(path);
  nextRelease();
});

test("ロックの PID が自分自身なら持ち主は生きていない扱いにし、ロックは奪わない", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-lock-test-"));
  dirs.push(dir);
  const path = join(dir, "bot.lock");
  writeFileSync(path, `${JSON.stringify({ pid: process.pid })}\n`);
  let error: unknown;
  try { acquireLock(path); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(LockExistsError);
  expect((error as LockExistsError).holderAlive).toBe(false);
  expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(process.pid);
});
