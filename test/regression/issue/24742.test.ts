// On NixOS, autoPatchelfHook rewrites bun's PT_INTERP to a /nix/store/... path.
// `bun build --compile` then copies that patched binary, producing output that
// only runs on the same Nix generation. We now detect store-path interpreters
// and rewrite them back to the standard FHS path.
//
// https://github.com/oven-sh/bun/issues/24742

import { expect, test } from "bun:test";
import { chmodSync, closeSync, cpSync, existsSync, openSync, readSync } from "fs";
import { bunEnv, bunExe, isLinux, isMusl, isOHOS, tempDir } from "harness";
import { join } from "path";

const patchelf = Bun.which("patchelf");

const ldso =
  process.arch === "arm64"
    ? isMusl
      ? "/lib/ld-musl-aarch64.so.1"
      : "/lib/ld-linux-aarch64.so.1"
    : isMusl
      ? "/lib/ld-musl-x86_64.so.1"
      : "/lib64/ld-linux-x86-64.so.2";

const ldsoBasename = ldso.split("/").pop()!;
const fakeNixInterp = `/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-glibc-2.40-1/lib/${ldsoBasename}`;

// Read PT_INTERP path from an ELF64 LE binary, seeking to the segment's
// actual p_offset. Seeks matter: patchelf that cannot fit a longer
// interpreter in place (OHOS builds pack the ELF tightly) rewrites the
// segment at the file tail, far beyond the first page a head-only read
// covers.
function readInterp(path: string): string | null {
  const fd = openSync(path, "r");
  try {
    const ehdr = Buffer.alloc(64);
    if (readSync(fd, ehdr, 0, 64, 0) < 64 || ehdr.readUInt32BE(0) !== 0x7f454c46) return null;
    const e_phoff = Number(ehdr.readBigUInt64LE(32));
    const e_phnum = ehdr.readUInt16LE(56);
    for (let i = 0; i < e_phnum; i++) {
      const ph = Buffer.alloc(56);
      readSync(fd, ph, 0, 56, e_phoff + i * 56);
      if (ph.readUInt32LE(0) !== 3 /* PT_INTERP */) continue;
      const p_offset = Number(ph.readBigUInt64LE(8));
      const p_filesz = Number(ph.readBigUInt64LE(32));
      const region = Buffer.alloc(p_filesz);
      readSync(fd, region, 0, p_filesz, p_offset);
      const nul = region.indexOf(0);
      return region.subarray(0, nul === -1 ? region.length : nul).toString("utf8");
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

// Mirror of `hostUsesNixStoreInterpreter()` in src/elf.zig. After #29290 the
// normalization is skipped on Nix/Guix hosts — this assertion only holds on
// non-Nix hosts. (The #29290 test covers the NixOS-host branch.)
function hostLooksNix(): boolean {
  if (!isLinux) return false;
  if (existsSync("/etc/NIXOS")) return true;
  if (existsSync("/gnu/store")) return true;
  try {
    const selfInterp = readInterp(bunExe());
    if (selfInterp && (selfInterp.startsWith("/nix/store/") || selfInterp.startsWith("/gnu/store/"))) {
      return true;
    }
  } catch {}
  return false;
}

// OHOS: patchelf itself works (the rewritten interpreter lives at the file
// tail -- readInterp above seeks there), but `bun build --compile`'s FHS
// normalization of the output is corrupted by the standalone payload append
// (PT_INTERP p_filesz is updated to the short FHS path while the bytes at
// p_offset end up overwritten by payload). Pure Nix scenario, not applicable
// to OHOS deployment; tracked for a future fix in the compile path.
test.skipIf(isOHOS || !isLinux || !patchelf || !existsSync(ldso) || hostLooksNix())(
  "bun build --compile normalizes /nix/store interpreter (#24742)",
  async () => {
    using dir = tempDir("nix-interp", {
      "in.js": `console.log("hello from compiled");`,
    });
    const cwd = String(dir);

    // Simulate a NixOS-installed bun: copy the real binary, then patchelf it.
    const fakeNixBun = join(cwd, "fake-nix-bun");
    cpSync(bunExe(), fakeNixBun);
    chmodSync(fakeNixBun, 0o755);

    {
      const r = Bun.spawnSync({
        cmd: [patchelf!, "--set-interpreter", fakeNixInterp, fakeNixBun],
        stderr: "pipe",
      });
      expect(r.stderr.toString()).toBe("");
      expect(r.exitCode).toBe(0);
    }
    expect(readInterp(fakeNixBun)).toBe(fakeNixInterp);

    // Build using the patched binary as the template via --compile-executable-path.
    // (We run the real bunExe(); only the *source* of the copy is the Nix-patched one.)
    const out = join(cwd, "out");
    {
      const r = Bun.spawnSync({
        cmd: [
          bunExe(),
          "build",
          "--compile",
          "--compile-executable-path",
          fakeNixBun,
          join(cwd, "in.js"),
          "--outfile",
          out,
        ],
        env: bunEnv,
        cwd,
        stderr: "pipe",
        stdout: "pipe",
      });
      const stderr = r.stderr.toString();
      expect(stderr).not.toContain("error:");
      expect(r.exitCode).toBe(0);
    }

    // The compiled output's interpreter must be the standard FHS path,
    // not the /nix/store path baked into fake-nix-bun.
    const interp = readInterp(out);
    expect(interp).toBe(ldso);

    // And it must actually run on a stock system.
    {
      const r = Bun.spawnSync({ cmd: [out], env: bunEnv, stderr: "pipe", stdout: "pipe" });
      expect(r.stdout.toString().trim()).toBe("hello from compiled");
      expect(r.exitCode).toBe(0);
    }
  },
  180_000,
);
