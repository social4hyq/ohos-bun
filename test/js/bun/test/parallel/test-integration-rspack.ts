import { expect } from "bun:test";
import { bunEnv, bunExe, tmpdirSync } from "harness";
import { join } from "path";

const cwd = tmpdirSync();
console.log([0, cwd]);

let proc = Bun.spawn({
  // Pinned: rsbuild 2.0.x bundles mimalloc v3 inside @rspack/binding-win32-arm64-msvc.
  // Two static mimalloc instances in one process deterministically segfault in ntdll
  // during ExitProcess on Windows arm64 (FLS / process-detach cleanup). Tracked
  // separately; this test exists to guard the napi TSFN finalizer, not rsbuild HEAD.
  cmd: [bunExe(), "create", "rsbuild@1", "app", "--template", "solid-ts"],
  stdio: ["ignore", "inherit", "inherit"],
  cwd,
  env: bunEnv,
});
await proc.exited;
console.log([1]);
expect(proc.signalCode).toBeNull();
expect(proc.exitCode).toBe(0);

if (process.platform === "openharmony") {
  // rsbuild@1's ^1.7.1 range currently floats @rspack/core to 1.7.12, whose
  // upstream @rspack/binding has no OHOS build at all (own JS platform
  // switch in binding.js has no openharmony branch, so even an optional-
  // dependency-level override would never be reached). The community port
  // @ohos-ports/rspack-binding is a real-machine-verified OHOS build, but
  // only published for 1.7.11; rspack's own runtime rejects a core/binding
  // version mismatch, so core must be pinned to the exact matching release
  // too. The scaffolded app's package.json has no override slot, so patch
  // one in before install.
  const pkgPath = join(cwd, "app", "package.json");
  const pkg = await Bun.file(pkgPath).json();
  pkg.resolutions = {
    ...pkg.resolutions,
    "@rspack/core": "1.7.11",
    "@rspack/binding": "npm:@ohos-ports/rspack-binding@1.7.11-beta.1",
  };
  await Bun.write(pkgPath, JSON.stringify(pkg, null, 2));
}

proc = Bun.spawn({
  cmd: [bunExe(), "install"],
  stdio: ["ignore", "inherit", "inherit"],
  cwd: join(cwd, "app"),
  env: bunEnv,
});
await proc.exited;
console.log([2]);
expect(proc.signalCode).toBeNull();
expect(proc.exitCode).toBe(0);

proc = Bun.spawn({
  cmd: [bunExe(), "--bun", "run", "build"],
  stdio: ["ignore", "inherit", "inherit"],
  cwd: join(cwd, "app"),
  env: bunEnv,
});
await proc.exited;
console.log([3]);
expect(proc.signalCode).toBeNull();
expect(proc.exitCode).toBe(0);
