import fs from "fs";
import { bunEnv, bunExe, isLinux, isOHOS } from "harness";
import path from "path";
const cwd = import.meta.dir;

// @prisma/get-platform's platform detection only special-cases
// os.platform() === "linux"; on this fork process.platform === "openharmony",
// so it falls through every branch to a hardcoded glibc default. Bypass
// detection entirely via Prisma's own documented PRISMA_QUERY_ENGINE_LIBRARY
// / PRISMA_SCHEMA_ENGINE_BINARY env vars, pointed at the native OHOS build
// published as @ohos-npm-ports/prisma-engines.
const OHOS_PRISMA_ENV = isOHOS
  ? (() => {
      const engines = require("@ohos-npm-ports/prisma-engines");
      return {
        PRISMA_QUERY_ENGINE_LIBRARY: engines.queryEngineLibraryPath,
        PRISMA_SCHEMA_ENGINE_BINARY: engines.schemaEngineBinaryPath,
      };
    })()
  : {};
// `new PrismaClient()` in prisma.test.ts itself runs in *this* bun process
// (not the generate/migrate subprocesses spawned below), so the query engine
// override also has to land in this process's own env, not just the spawned
// children's.
if (isOHOS) Object.assign(process.env, OHOS_PRISMA_ENV);

export async function generateClient(type: string, env: Record<string, string>) {
  generate(type, env);

  // This should run the first time on a fresh db
  try {
    migrate(type, env);
  } catch (err: any) {
    if (err.message.indexOf("Environment variable not found:") !== -1) throw err;
  }

  return (await import(`./prisma/${type}/client`)).PrismaClient;
}
export function migrate(type: string, env: Record<string, string>) {
  const result = Bun.spawnSync(
    [
      bunExe(),
      "x",
      "prisma",
      "migrate",
      "dev",
      "--name",
      "init",
      "--schema",
      path.join(cwd, "prisma", type, "schema.prisma"),
    ],
    {
      cwd,
      env: {
        ...bunEnv,
        NODE_ENV: undefined,
        ...(isOHOS ? OHOS_PRISMA_ENV : {}),
        ...env,
      },
    },
  );
  if (!result.success) throw new Error(result.stderr.toString("utf8"));
}

export function generate(type: string, env: Record<string, string>) {
  const schema = path.join(cwd, "prisma", type, "schema.prisma");

  const content = fs
    .readFileSync(schema)
    .toString("utf8")
    // only affect linux
    .replace(
      "%binaryTargets%",
      isLinux
        ? 'binaryTargets = ["native", "debian-openssl-1.1.x", "debian-openssl-3.0.x", "linux-musl", "linux-musl-openssl-3.0.x"]'
        : "",
    );

  fs.writeFileSync(schema, content);

  const result = Bun.spawnSync([bunExe(), "prisma", "generate", "--schema", schema], {
    cwd,
    env: {
      ...bunEnv,
      NODE_ENV: undefined,
      ...(isOHOS ? OHOS_PRISMA_ENV : {}),
      ...env,
    },
  });
  if (!result.success) throw new Error(result.stderr.toString("utf8"));
}
