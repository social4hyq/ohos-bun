import { describe, test } from "bun:test";
import { cwdScope, isWindows, rmScope, tempDirWithFiles } from "harness";

describe.if(!isWindows)("unix socket", () => {
  test("valid", () => {
    // On OHOS, the repo checkout's filesystem can't hold AF_UNIX socket
    // files (EPERM); chdir into a tmpdir-backed directory that can, matching
    // the "allows" tests below.
    const isOHOS = process.platform === "openharmony";
    const tempdir = isOHOS ? tempDirWithFiles("bun-listen-valid", { "foo.txt": "bar" }) : undefined;
    using cwd = isOHOS ? cwdScope(tempdir!) : undefined;
    using rm = isOHOS ? rmScope(tempdir!) : undefined;

    using server = Bun.listen({
      unix: Math.random().toString(32).slice(2, 15) + ".sock",
      socket: {
        open() {},
        close() {},
        data() {},
        drain() {},
      },
    });
    server.stop();
  });

  describe("allows", () => {
    const permutations = [
      {
        unix: Math.random().toString(32).slice(2, 15) + ".sock",
        port: 0,
        hostname: "",
      },
      {
        unix: Math.random().toString(32).slice(2, 15) + ".sock",
        hostname: undefined,
      },
      {
        unix: Math.random().toString(32).slice(2, 15) + ".sock",
        hostname: null,
      },
      {
        unix: Math.random().toString(32).slice(2, 15) + ".sock",
        hostname: false,
      },
    ];

    for (const args of permutations) {
      test(`${JSON.stringify(args)}`, async () => {
        const tempdir = tempDirWithFiles("test-socket", {
          "foo.txt": "bar",
        });
        using cwd = cwdScope(tempdir);
        using rm = rmScope(tempdir);
        for (let i = 0; i < 100; i++) {
          using server = Bun.listen({
            ...args,
            unix: args.unix.startsWith("unix://") ? "unix://" + i + args.unix.slice(7) : i + args.unix,
            socket: {
              open() {},
              close() {},
              data() {},
              drain() {},
            },
          });
          server.stop();
        }
      });
    }
  });
});
