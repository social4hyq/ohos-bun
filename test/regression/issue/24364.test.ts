import { expect, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("react-tailwind template passes tsc --noEmit", async () => {
  // Read template files from source
  // `src/cli` is a committed symlink → `runtime/cli`; Windows git agents
  // (no SeCreateSymbolicLinkPrivilege / core.symlinks=false) write a
  // 12-byte text file instead of a directory link, so go to the canonical
  // path directly.
  const templateDir = join(import.meta.dir, "../../../src/runtime/cli/init/react-tailwind");
  const buildTs = readFileSync(join(templateDir, "build.ts"), "utf8");
  const tsconfigJson = readFileSync(join(templateDir, "tsconfig.json"), "utf8");

  // Create temp directory with template files
  using dir = tempDir("issue-24364", {
    "build.ts": buildTs,
    "tsconfig.json": tsconfigJson,
  });

  // The template pulls in npm's `bun` meta-package through bun-plugin-tailwind
  // and TypeScript's native loader needs an OHOS implementation. Both community
  // ports are drop-in overrides; keep the upstream package names for other OSes.
  if (process.platform === "openharmony") {
    await Bun.write(
      join(String(dir), "package.json"),
      JSON.stringify(
        {
          name: "issue-24364",
          private: true,
          overrides: {
            bun: "npm:@ohos-ports/bun@1.4.2-beta.0",
            typescript: "npm:@ohos-npm-ports/typescript@7.0.2-3",
          },
        },
        null,
        2,
      ),
    );
  }

  // Install typescript and bun types
  await using install = Bun.spawn({
    cmd: [bunExe(), "add", "-d", "typescript", "@types/bun", "@types/react", "bun-plugin-tailwind"],
    cwd: String(dir),
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [, , installExitCode] = await Promise.all([install.stdout.text(), install.stderr.text(), install.exited]);
  expect(installExitCode).toBe(0);

  // Run tsc --noEmit (use bunExe() x for cross-platform compatibility)
  await using tsc = Bun.spawn({
    cmd: [bunExe(), "x", "tsc", "--noEmit"],
    cwd: String(dir),
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([tsc.stdout.text(), tsc.stderr.text(), tsc.exited]);

  expect(stderr).toBe("");
  expect(stdout).toBe("");
  expect(exitCode).toBe(0);
});
