import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isASAN, isOHOS, tempDir } from "harness";

// ASAN's quarantine retains freed allocations (default 256 MB) so RSS deltas
// run far higher under bun-asan; widen the threshold there.
const thresholdMB = isASAN ? 400 : 100;
// OHOS device: the 100k-iteration sweep child runs several times slower than
// the workstation and the four variants run concurrently; in the serial round
// one variant died at the 60 s budget with the leak assertion never reached
// while its sibling passed at ~35 s. Widen the budget there instead of
// cutting iterations — the assertion (absolute RSS growth over the same
// 100k sweeps < threshold) is untouched and now actually executes.
const timeout = isOHOS ? 180_000 : 60_000;

async function run(dir: string, code: string) {
  await using proc = Bun.spawn({
    cmd: [bunExe(), "--smol", "-e", code],
    cwd: dir,
    env: bunEnv,
    stdio: ["inherit", "inherit", "inherit"],
  });
  expect(await proc.exited).toBe(0);
}

describe("leaks", () => {
  test.concurrent(
    "scanSync",
    async () => {
      using dir = tempDir("glob-leak-scansync", { "a.txt": "", "b.txt": "", "sub/c.txt": "" });
      await run(
        String(dir),
        /* ts */ `
        const rss = process.platform === "darwin" && typeof Bun.unsafe.memoryFootprint === "function" ? Bun.unsafe.memoryFootprint : process.memoryUsage.rss;
        const glob = new Bun.Glob("**/*");
        for (let i = 0; i < 1000; i++) Array.from(glob.scanSync());
        Bun.gc(true);
        const before = rss();
        for (let i = 0; i < 100000; i++) Array.from(glob.scanSync());
        Bun.gc(true);
        const growthMB = (rss() - before) / 1024 / 1024;
        if (growthMB > ${thresholdMB}) throw new Error("leaked " + growthMB.toFixed(2) + "MB");
      `,
      );
    },
    timeout,
  );

  test.concurrent(
    "scan",
    async () => {
      using dir = tempDir("glob-leak-scan", { "a.txt": "", "b.txt": "", "sub/c.txt": "" });
      await run(
        String(dir),
        /* ts */ `
        const rss = process.platform === "darwin" && typeof Bun.unsafe.memoryFootprint === "function" ? Bun.unsafe.memoryFootprint : process.memoryUsage.rss;
        const glob = new Bun.Glob("**/*");
        for (let i = 0; i < 1000; i++) await Array.fromAsync(glob.scan());
        Bun.gc(true);
        const before = rss();
        for (let i = 0; i < 100000; i++) await Array.fromAsync(glob.scan());
        Bun.gc(true);
        const growthMB = (rss() - before) / 1024 / 1024;
        if (growthMB > ${thresholdMB}) throw new Error("leaked " + growthMB.toFixed(2) + "MB");
      `,
      );
    },
    timeout,
  );

  test.concurrent(
    "scanSync does not leak GlobWalker struct",
    async () => {
      using dir = tempDir("glob-struct-leak-sync", { "a.txt": "" });
      await run(
        String(dir),
        /* ts */ `
        const rss = process.platform === "darwin" && typeof Bun.unsafe.memoryFootprint === "function" ? Bun.unsafe.memoryFootprint : process.memoryUsage.rss;
        const glob = new Bun.Glob("*.txt");
        for (let i = 0; i < 1000; i++) Array.from(glob.scanSync());
        Bun.gc(true);
        const before = rss();
        for (let i = 0; i < 100000; i++) Array.from(glob.scanSync());
        Bun.gc(true);
        const growthMB = (rss() - before) / 1024 / 1024;
        if (growthMB > ${thresholdMB}) throw new Error("leaked " + growthMB.toFixed(2) + "MB");
      `,
      );
    },
    timeout,
  );

  test.concurrent(
    "scan does not leak GlobWalker struct",
    async () => {
      using dir = tempDir("glob-struct-leak-async", { "a.txt": "" });
      await run(
        String(dir),
        /* ts */ `
        const rss = process.platform === "darwin" && typeof Bun.unsafe.memoryFootprint === "function" ? Bun.unsafe.memoryFootprint : process.memoryUsage.rss;
        const glob = new Bun.Glob("*.txt");
        for (let i = 0; i < 1000; i++) await Array.fromAsync(glob.scan());
        Bun.gc(true);
        const before = rss();
        for (let i = 0; i < 100000; i++) await Array.fromAsync(glob.scan());
        Bun.gc(true);
        const growthMB = (rss() - before) / 1024 / 1024;
        if (growthMB > ${thresholdMB}) throw new Error("leaked " + growthMB.toFixed(2) + "MB");
      `,
      );
    },
    timeout,
  );
});
