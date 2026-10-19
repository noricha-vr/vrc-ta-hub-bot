import { closeSync, fstatSync, openSync, statSync, unlinkSync, writeFileSync } from "node:fs";

/** Fail closed: never steal a lock from another process, even if it appears stale. */
export function acquireLock(path: string): () => void {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Bot lock already exists; check that no other instance is running");
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
