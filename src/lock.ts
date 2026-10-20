import { closeSync, fstatSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";

/** ロックがあって起動できない。持ち主が生きているかは判断材料として出すだけで、ロックは奪わない。 */
export class LockExistsError extends Error {
  constructor(readonly holderAlive: boolean) {
    super("Bot lock already exists; check that no other instance is running");
  }
}

function holderAlive(path: string): boolean {
  try {
    const pid = (JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }).pid;
    // 自分の PID と同じなら、再利用された番号で前の持ち主ではない。
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // 権限がないだけなら、そのプロセスは生きている。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Fail closed: never steal a lock from another process, even if it appears stale. */
export function acquireLock(path: string): () => void {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new LockExistsError(holderAlive(path));
    }
    throw error;
  }
  const identity = fstatSync(fd);
  try {
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid })}\n`);
  } catch (error) {
    closeSync(fd);
    unlinkSync(path);
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const current = statSync(path);
      if (current.dev === identity.dev && current.ino === identity.ino) unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      closeSync(fd);
    }
  };
}
