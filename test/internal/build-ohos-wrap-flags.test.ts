import { expect, test } from "bun:test";
import type { Config } from "../../scripts/build/config.ts";
import { linkerFlags } from "../../scripts/build/flags.ts";

test.each(["linux", "ohos", "darwin", "freebsd", "windows"])("execve retry link flags for %s", os => {
  const cfg = { os, linux: os === "linux", ohos: os === "ohos" } as Config;
  for (const symbol of ["execve", "pthread_create"]) {
    const flag = `-Wl,--wrap=${symbol}`;
    const enabled = linkerFlags.some(entry => {
      if (entry.when && !entry.when(cfg)) return false;
      return Array.isArray(entry.flag) ? entry.flag.includes(flag) : entry.flag === flag;
    });
    expect(enabled).toBe(os === "linux" || os === "ohos");
  }
});
