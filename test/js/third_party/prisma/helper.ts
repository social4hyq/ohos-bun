import fs from "fs";
import { bunEnv, bunExe, isLinux } from "harness";
import path from "path";
const cwd = import.meta.dir;

// OHOS: prisma's platform probe cannot classify openharmony (no
// /etc/os-release, no ldconfig, uname quirks) and falls back to downloading a
// debian-openssl-1.1.x x64 engine that can never load on this aarch64 musl
// device. Pin the official linux-musl-arm64 engine instead — the prisma CDN
// publishes it as a first-class binaryTarget, and OHOS's musl libc loads
// alpine-musl products (same precedent as opentui-core). The device also
// requires signed ELF for dlopen, so sign the downloaded engine and point the
// generated client at it via PRISMA_QUERY_ENGINE_LIBRARY (an official
// prisma mechanism), bypassing the broken platform detection.
const OHOS_ENGINE_TARGET = "linux-musl-arm64-openssl-3.0.x";

function ohosSignedEngine(type: string): string | undefined {
  if (process.platform !== "openharmony") return undefined;
  const clientDir = path.join(cwd, "prisma", type, "client");
  const engine = path.join(clientDir, `libquery_engine-${OHOS_ENGINE_TARGET}.so.node`);
  if (!fs.existsSync(engine)) return undefined;
  // The device requires signed ELF for dlopen — sign the downloaded engine
  // IN PLACE: the generated client's own engine search (config.dirname) finds
  // it by target name, so no process-global env var is needed (a global would
  // cross-wire the sqlite and postgres clients).
  const selfsign = Bun.which("selfsign");
  const result = selfsign
    ? Bun.spawnSync([selfsign, engine, "--force"])
    : (() => {
        const bst = Bun.which("binary-sign-tool");
        if (!bst) throw new Error("no ELF signer on PATH (selfsign / binary-sign-tool)");
        return Bun.spawnSync([bst, "sign", "-selfSign", "1", "-inFile", engine, "-outFile", engine]);
      })();
  if (!result.success) {
    throw new Error("ELF signing failed: " + result.stderr.toString("utf8"));
  }
  fs.chmodSync(engine, 0o755);
  // The generated client resolves its runtime target via prisma's platform
  // probe, which misclassifies openharmony as "debian-openssl-1.1.x". Give
  // the signed musl engine that name too, so resolution finds a loadable
  // file regardless of which target name the client asks for. Both files
  // are the same signed aarch64 musl engine; generate() only ever fetched
  // the correct architecture.
  // NOTE: byte-copy, not copyfile — OHOS denies copyfile(2) on signed ELFs,
  // and also denies overwriting an existing signed ELF in place, so unlink
  // the previous copy first, write fresh bytes, then sign the new file.
  const debian = path.join(clientDir, "libquery_engine-debian-openssl-1.1.x.so.node");
  fs.rmSync(debian, { force: true });
  fs.writeFileSync(debian, fs.readFileSync(engine));
  selfsignSelf(debian);
  fs.chmodSync(debian, 0o755);
  return engine;
}

// Re-sign an ELF in place with whichever signer is on PATH.
function selfsignSelf(file: string) {
  const selfsign = Bun.which("selfsign");
  if (selfsign) {
    const r = Bun.spawnSync([selfsign, file, "--force"]);
    if (!r.success) throw new Error("selfsign failed: " + r.stderr.toString("utf8"));
    return;
  }
  const bst = Bun.which("binary-sign-tool");
  if (!bst) throw new Error("no ELF signer on PATH (selfsign / binary-sign-tool)");
  const r = Bun.spawnSync([bst, "sign", "-selfSign", "1", "-inFile", file, "-outFile", file]);
  if (!r.success) throw new Error("ELF signing failed: " + r.stderr.toString("utf8"));
}

export async function generateClient(type: string, env: Record<string, string>) {
  generate(type, env);

  // This should run the first time on a fresh db
  try {
    migrate(type, env);
  } catch (err: any) {
    if (err.message.indexOf("Environment variable not found:") !== -1) throw err;
  }

  // Sign the downloaded engine in place AND mirror it under the runtime
  // target name the client resolves (prisma's broken platform probe calls
  // itself "debian-openssl-1.1.x" on openharmony; the real CDN engine for
  // that deprecated target no longer downloads, so the musl-arm64 file must
  // answer to both names — see ohosSignedEngine).
  ohosSignedEngine(type);

  return (await import(`./prisma/${type}/client`)).PrismaClient;}
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
        ...env,
      },
    },
  );
  if (!result.success) throw new Error(result.stderr.toString("utf8"));

}

export function generate(type: string, env: Record<string, string>) {
  const schema = path.join(cwd, "prisma", type, "schema.prisma");

  let content = fs
    .readFileSync(schema)
    .toString("utf8")
    // only affect linux
    .replace(
      "%binaryTargets%",
      isLinux
        ? 'binaryTargets = ["native", "debian-openssl-1.1.x", "debian-openssl-3.0.x", "linux-musl", "linux-musl-openssl-3.0.x"]'
        : "",
    );

  // Inject into a throwaway sibling schema (never the tracked file): the
  // engine download follows binaryTargets from the schema passed to
  // `prisma generate`, and `output = "client"` resolves relative to that
  // schema's directory, so the client lands in the same place.
  let schemaForGenerate = schema;
  let injectedSchema: string | undefined;
  if (process.platform === "openharmony" && !content.includes("binaryTargets")) {
    // Pin the musl-arm64 engine target explicitly: prisma's native platform
    // detection misclassifies openharmony (see ohosSignedEngine above), and
    // the CLI's arch detection defaults to x64, so the implicitly downloaded
    // engine could never load.
    content = content.replace(
      /(provider\s*=\s*"prisma-client-js")/,
      `$1\n  binaryTargets = ["${OHOS_ENGINE_TARGET}"]`,
    );
    injectedSchema = path.join(path.dirname(schema), "schema.ohos-tmp.prisma");
    fs.writeFileSync(injectedSchema, content);
    schemaForGenerate = injectedSchema;
  }

  try {
    const result = Bun.spawnSync([bunExe(), "prisma", "generate", "--schema", schemaForGenerate], {
      cwd,
      env: {
        ...bunEnv,
        NODE_ENV: undefined,
        ...env,
      },
    });
    if (!result.success) throw new Error(result.stderr.toString("utf8"));
  } finally {
    if (injectedSchema && fs.existsSync(injectedSchema)) fs.unlinkSync(injectedSchema);
  }
}
