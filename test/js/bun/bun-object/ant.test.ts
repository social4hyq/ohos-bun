import { describe, expect, test } from "bun:test";
import { isLinux, tempDir } from "harness";
import { createConnection, createServer } from "node:net";

describe("Bun.ant", () => {
  test("is an object", () => {
    expect(typeof Bun.ant).toBe("object");
  });

  test("setDumpable returns a boolean", () => {
    const result = Bun.ant.setDumpable(false);
    expect(result).toBe(isLinux);
    // restore the default so other tests in this process aren't affected.
    Bun.ant.setDumpable(true);
  });

  test("getPeerUid/getPeerPid return null for an invalid fd", () => {
    expect(Bun.ant.getPeerUid(-1)).toBeNull();
    expect(Bun.ant.getPeerPid(-1)).toBeNull();
  });

  test.skipIf(!isLinux)("getPeerUid/getPeerPid report the real peer over a unix socket", async () => {
    using dir = tempDir("bun-ant-peercred", {});
    const path = `${String(dir)}/peer.sock`;
    const { promise, resolve } = Promise.withResolvers<void>();

    const server = createServer(sock => {
      const fd = (sock as any)._handle.fd;
      expect(Bun.ant.getPeerUid(fd)).toBe(process.getuid!());
      expect(Bun.ant.getPeerPid(fd)).toBe(process.pid);
      server.close();
      sock.end();
      resolve();
    });
    server.listen(path, () => {
      createConnection({ path });
    });
    await promise;
  });

  test.skipIf(!isLinux)("memoryPressureLevel returns a PSI-derived level or null", () => {
    const level = Bun.ant.memoryPressureLevel();
    expect([1, 2, 4, null]).toContain(level);
  });

  test("CellSegmenter is not implemented", () => {
    // The Ink terminal-cell segmenter is an undocumented, version-pinned
    // wire protocol private to Anthropic's internal Bun build; Claude Code
    // already falls back to its classic renderer when this is absent.
    expect(Bun.ant.CellSegmenter).toBeUndefined();
  });
});
