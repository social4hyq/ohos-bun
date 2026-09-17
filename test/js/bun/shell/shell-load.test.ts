import { describe, expect, test } from "bun:test";
import { bunRun, isCI, isOHOS, isWindows } from "harness";
import path from "path";
describe("shell load", () => {
  // windows process spawning is a lot slower
  test.concurrent.skipIf(isCI && isWindows)(
    "immediate exit",
    async () => {
      // OHOS process startup is substantially slower than Linux. Calibrate the
      // stress size to stay within this test's 90s budget (20 batches = 2,000
      // immediate-exit children on the device), without weakening assertions.
      const outer = isOHOS ? 20 : process.platform === "darwin" ? 100 : 300;
      const { stdout, stderr, exitCode } = await bunRun(
        path.join(import.meta.dir, "./shell-immediate-exit-fixture.js"),
        { SHELL_LOAD_OUTER: String(outer) },
      );
      expect(stderr).toBe("");
      const expectedBatches = Math.floor((outer - 1) / 10) + 1;
      expect(stdout.split("\n").filter(Boolean)).toEqual(Array.from({ length: expectedBatches }, (_, i) => `Ran: ${i + 1}`));
      expect(exitCode).toBe(0);
    },
    {
      timeout: 1000 * 90,
    },
  );
});
