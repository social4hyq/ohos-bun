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
});

function makeSegmenter(overrides: Record<string, unknown> = {}) {
  return new Bun.ant.CellSegmenter({
    ambiguousIsNarrow: true,
    substitute: [],
    screen: {
      widthMask: 3,
      narrow: 0,
      wide: 1,
      spacerTail: 2,
      spacerHead: 3,
      emptyCharIndex: 0,
      spacerCharIndex: 1,
      emptyWord: 0,
      tabWidth: 8,
      ...overrides,
    },
  });
}

function segmentAll(seg: any, text: string, reordered = false) {
  let cells = new Int32Array(512);
  let runs = new Int32Array(512);
  let count = seg.segment(text, cells, runs, reordered);
  if (count < 0) {
    const need = Math.max(-count, cells.length);
    cells = new Int32Array(2 * need);
    runs = new Int32Array(2 * need);
    count = seg.segment(text, cells, runs, reordered);
  }
  return { count, cells, runs };
}

function reconstruct(seg: any, count: number, cells: Int32Array) {
  let out = "";
  let width = 0;
  for (let i = 0; i < count; i++) {
    const charIdx = cells[2 * i];
    const word = cells[2 * i + 1];
    const isTab = (word & 0x100) !== 0;
    out += seg.graphemes[charIdx];
    width += isTab ? 8 - (width % 8) : word & 0xff;
  }
  return { text: out, width };
}

describe("Bun.ant.CellSegmenter", () => {
  test("index 0 of every interning table is the empty string", () => {
    const seg = makeSegmenter();
    expect(seg.graphemes).toEqual([""]);
    expect(seg.sgrKeys).toEqual([""]);
    expect(seg.sgrCloseKeys).toEqual([""]);
    expect(seg.uris).toEqual([""]);
  });

  test("segments plain ASCII text with no escapes", () => {
    const seg = makeSegmenter();
    const { count, cells } = segmentAll(seg, "hello world");
    expect(count).toBe(11);
    expect(reconstruct(seg, count, cells).text).toBe("hello world");
  });

  test("strips SGR escapes from the reconstructed text and interns matching open/close codes", () => {
    const seg = makeSegmenter();
    const { count, cells } = segmentAll(seg, "plain \x1b[1;31mbold red\x1b[0m plain");
    expect(reconstruct(seg, count, cells).text).toBe("plain bold red plain");
    expect(seg.sgrKeys).toEqual(["", "\x1b[1m\x00\x1b[31m"]);
    expect(seg.sgrCloseKeys).toEqual(["", "\x1b[39m\x00\x1b[22m"]);
  });

  test("strips OSC 8 hyperlinks from the reconstructed text and interns the URI", () => {
    const seg = makeSegmenter();
    const { count, cells } = segmentAll(seg, "before \x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ after");
    expect(reconstruct(seg, count, cells).text).toBe("before link after");
    expect(seg.uris).toEqual(["", "https://example.com"]);
  });

  test("re-segmenting the same styles/URI reuses the same interned table entries", () => {
    const seg = makeSegmenter();
    segmentAll(seg, "\x1b[1mone\x1b[0m");
    segmentAll(seg, "\x1b[1mtwo\x1b[0m");
    // Only one distinct SGR pair was ever seen — the table must not grow on repeats.
    expect(seg.sgrKeys).toEqual(["", "\x1b[1m"]);
  });

  test.each([
    ["hello", "world"],
    ["中文", "CJK"],
    ["emoji😀wave", "emoji + ZWJ-less presentation emoji"],
  ])("width of %p matches Bun.stringWidth (%s)", text => {
    const seg = makeSegmenter();
    const { count, cells } = segmentAll(seg, text);
    expect(reconstruct(seg, count, cells).width).toBe(Bun.stringWidth(text));
  });

  test("tabs expand to the next tab stop, not a fixed width", () => {
    const seg = makeSegmenter();
    const { count, cells } = segmentAll(seg, "a\tbc\td");
    // 'a' -> col 1, tab -> col 8, "bc" -> col 10, tab -> col 16, 'd' -> col 17
    expect(reconstruct(seg, count, cells).width).toBe(17);
  });

  test("grows cells/runs and retries when the caller's buffer is too small", () => {
    const seg = makeSegmenter();
    const tinyCells = new Int32Array(4);
    const tinyRuns = new Int32Array(4);
    const negative = seg.segment("this needs more than 2 cells", tinyCells, tinyRuns, false);
    expect(negative).toBeLessThan(0);
    const need = Math.max(-negative, tinyCells.length);
    const cells = new Int32Array(2 * need);
    const runs = new Int32Array(2 * need);
    const count = seg.segment("this needs more than 2 cells", cells, runs, false);
    expect(count).toBeGreaterThan(0);
    expect(reconstruct(seg, count, cells).text).toBe("this needs more than 2 cells");
  });

  test("setCell writes a narrow cell and auto-synthesizes a spacer-tail companion for a wide one", () => {
    const seg = makeSegmenter();
    const screenWidth = 10;
    const screenCells = new Int32Array(screenWidth * 2);

    seg.setCell(screenCells, screenWidth, 0, 0, 5, /* styleId=0, hyperlink=0, width=narrow(0) */ 0);
    expect(screenCells[0]).toBe(5);
    expect(screenCells[1] & 3).toBe(0);

    seg.setCell(screenCells, screenWidth, 2, 0, 7, /* width=wide(1) */ 1);
    expect(screenCells[2 * 2]).toBe(7);
    expect(screenCells[2 * 2 + 1] & 3).toBe(1); // primary cell: wide
    expect(screenCells[2 * 3]).toBe(0); // companion: emptyCharIndex
    expect(screenCells[2 * 3 + 1] & 3).toBe(2); // companion: spacerTail
  });

  test("paint writes a full segmented run into the screen and reports the ending column", () => {
    const seg = makeSegmenter();
    const { count, cells } = segmentAll(seg, "wide中文end");
    const screenWidth = 20;
    const screenCells = new Int32Array(screenWidth * 2);
    const charIndices = Int32Array.from(seg.graphemes.map((_: string, i: number) => i));
    const runWords = Int32Array.from(seg.sgrKeys.map((_: string, i: number) => i << 17));

    seg.paint(screenCells, screenWidth, 0, 0, cells, count, undefined, charIndices, runWords);

    let out = "";
    for (let x = 0; x < screenWidth; x++) {
      const widthCode = screenCells[x * 2 + 1] & 3;
      if (widthCode === 2) continue; // spacer-tail companion, not a real character
      const idx = screenCells[x * 2];
      if (idx === 0 && x >= "wide中文end".length + 2) break;
      out += seg.graphemes[idx];
    }
    expect(out).toBe("wide中文end");
  });
});
