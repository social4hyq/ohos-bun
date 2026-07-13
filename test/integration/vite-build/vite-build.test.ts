import { expect, test } from "bun:test";
import fs from "fs";
import { bunExe, bunEnv as env, isASAN, tmpdirSync } from "harness";
import path from "path";

const ASAN_MULTIPLIER = isASAN ? 3 : 1;

test(
  "vite build works",
  async () => {
    const testDir = tmpdirSync();

    fs.cpSync(path.join(import.meta.dir, "the-test-app"), testDir, { recursive: true, force: true });

    const { exited: installExited } = Bun.spawn({
      cmd: [bunExe(), "install", "--ignore-scripts"],
      cwd: testDir,
      env,
    });

    expect(await installExited).toBe(0);

    if (process.platform === "openharmony") {
      // bun's install-time auto-sign pass (PackageInstaller.rs
      // ohos_sign_native_binaries) computes each package's node_modules path
      // assuming a flat, non-isolated layout. In a tree this large bun falls
      // back to its isolated-install (.bun store) layout for hoisting
      // conflicts, so optional native bindings resolved deep in the graph
      // (like rolldown's) land outside the path the signer scans and are
      // left unsigned — dlopen then fails with Permission denied.
      const rolldownBinding = path.join(
        testDir,
        "node_modules/@rolldown/binding-openharmony-arm64/rolldown-binding.openharmony-arm64.node",
      );
      if (fs.existsSync(rolldownBinding)) {
        await Bun.$`binary-sign-tool sign -selfSign 1 -inFile ${rolldownBinding} -outFile ${rolldownBinding}.signed && cp ${rolldownBinding}.signed ${rolldownBinding} && chmod +x ${rolldownBinding}`;
      }
    }

    const { stdout, stderr, exited } = Bun.spawn({
      cmd: [bunExe(), "node_modules/vite/bin/vite.js", "build"],
      cwd: testDir,
      stdout: "pipe",
      stderr: "inherit",
      env,
    });

    expect(await exited).toBe(0);

    const out = await stdout.text();
    expect(out).toContain("done");
  },
  120_000 * ASAN_MULTIPLIER,
);
