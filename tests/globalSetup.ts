import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The integration tests share one MongoDB test database and drop it between tests: two runs at the same
// time wipe each other's data and fail at random. The first run holds this lock; a second one stops.
const LOCK = join(tmpdir(), "h-chat-backend-tests.lock");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export default function setup() {
  try {
    const fd = openSync(LOCK, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
  } catch {
    const holder = Number(readFileSync(LOCK, "utf8"));
    if (holder && alive(holder)) {
      throw new Error(`Another backend test run (pid ${holder}) is using the test database. Wait for it, or stop it: kill ${holder}`);
    }
    // Left behind by a run that crashed
    rmSync(LOCK, { force: true });
    return setup();
  }
  return () => rmSync(LOCK, { force: true });
}
