import { describe, expect, it } from "bun:test";
import { cpSync } from "fs";
import { bunEnv, bunRun, isCI, isWindows, runBunInstall, tmpdirSync } from "harness";
import { join } from "path";
describe("next-auth", () => {
  // This test OOMs on Windows.
  it.todoIf(isCI && isWindows)(
    "should be able to call server action multiple times using auth middleware #18977",
    async () => {
      const testDir = tmpdirSync("next-auth-" + Date.now());

      cpSync(join(import.meta.dir, "fixture"), testDir, {
        recursive: true,
        force: true,
        filter: src => {
          if (src.includes("node_modules")) {
            return false;
          }
          if (src.startsWith(".next")) {
            return false;
          }
          return true;
        },
      });

      if (process.platform === "openharmony") {
        const packageJsonPath = join(testDir, "package.json");
        const packageJson = await Bun.file(packageJsonPath).json();
        packageJson.resolutions = {
          ...packageJson.resolutions,
          next: "npm:@ohos-npm-ports/next@16.3.5-1",
        };
        await Bun.write(packageJsonPath, JSON.stringify(packageJson, null, 2));
      }

      console.log("running bun install");
      await runBunInstall(bunEnv, testDir, { savesLockfile: false });

      console.log("starting server");
      const result = await bunRun(join(testDir, "server.js"), {
        AUTH_SECRET: "I7Jiq12TSMlPlAzyVAT+HxYX7OQb/TTqIbfTTpr1rg8=",
      });

      console.log(result.stdout);
      console.log(result.stderr);
      if (process.platform === "openharmony") {
        // The OHOS Next port is based on Next 16 and emits these known
        // compatibility/deprecation warnings; unexpected stderr remains a
        // failure so runtime errors are not hidden.
        const knownWarning = /Mismatching @next\/swc version|`eslint` configuration|Invalid next\.config|Unrecognized key\(s\)|middleware.*deprecated|See more info here|To migrate automatically|@next\/codemod|Learn more:/;
        const unexpected = result.stderr
          .split("\n")
          .map(line => line.trim())
          .filter(line => line.length > 0 && !knownWarning.test(line));
        expect(unexpected).toEqual([]);
      } else {
        expect(result.stderr).toBe("");
      }
      expect(result.stdout).toBeDefined();
      const lines = result.stdout?.split("\n") ?? [];
      expect(lines[lines.length - 1]).toMatch(/request sent/);
      expect(result.exitCode).toBe(0);
    },
    90_000,
  );
});
