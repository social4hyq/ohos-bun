import { expect, test } from "bun:test";
import path from "path";

test(
  "should not leak memory with already aborted signals",
  async () => {
    expect([path.join(import.meta.dir, "abort-signal-leak-read-write-file-fixture.ts")]).toRun();
  },
  process.platform === "openharmony" ? 60_000 : 5_000, // 100k async fs.promises calls; OHOS fs syscall overhead is higher; 30s still timed out on a loaded run (30023ms)
);
