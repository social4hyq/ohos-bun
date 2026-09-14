/**
 * Self-obsoleting workaround registry.
 *
 * Workarounds accumulate as dead code because nobody remembers to remove
 * them once the upstream fix ships. This file is the antidote: every
 * workaround registers an `expectedToBeFixed` predicate that trips once the
 * fix is available, and configure fails with cleanup instructions.
 *
 * Add an entry here whenever you land a workaround that's waiting on an
 * upstream release (LLVM fix, macOS update, Zig release, vendored dep
 * bump, etc.). The entry is the reminder.
 *
 * ## Writing an `expectedToBeFixed` predicate
 *
 * Typically a version check: `cfg.clangVersion >= FIXED_IN_LLVM`,
 * macOS SDK version, a dep's commit hash, etc. When you know exactly
 * which release has the fix, use that. When you don't — fix merged
 * upstream but not released yet — pick your best guess for the likely
 * release. The check might trip on a version that turns out not to
 * have the fix; that's okay. The error message tells the dev to bump
 * the threshold, which takes 30 seconds. That's cheaper than leaving
 * the check blank and the workaround living forever.
 *
 *   - Use `applies` to gate the check to configs where the workaround is
 *     actually exercised — no point failing a Linux build for a
 *     macOS-only workaround.
 *   - Tool/OS detection: if you can't reliably detect (e.g. Apple clang
 *     vs LLVM clang have different version schemes), exclude the
 *     ambiguous case.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { BuildError } from "./error.ts";
import { satisfiesRange, toolchainOverride } from "./tools.ts";

/** Read a crate's locked version out of the repo's Cargo.lock. */
function lockedCrateVersion(cfg: Config, name: string): string | undefined {
  const lock = readFileSync(join(cfg.cwd, "Cargo.lock"), "utf8");
  const m = lock.match(new RegExp(`\\nname = "${name}"\\nversion = "([^"]+)"`));
  return m?.[1];
}

export interface Workaround {
  /** Short slug — shows up in the error message. */
  id: string;
  /** Upstream tracker reference (issue URL, PR number, etc.). */
  issue: string;
  /** One-line: what's being worked around. */
  description: string;
  /**
   * Gate the check to relevant configs. If false, `expectedToBeFixed` isn't
   * evaluated — the workaround isn't exercised on this config so there's
   * nothing to verify.
   */
  applies: (cfg: Config) => boolean;
  /**
   * Return true once the upstream fix is available in the current
   * toolchain/environment. Configure fails when this trips.
   */
  expectedToBeFixed: (cfg: Config) => boolean;
  /** What to remove once the fix ships. */
  cleanup: string;
}

export const workarounds: Workaround[] = [
  {
    id: "asan-dyld-shim",
    issue: "https://github.com/llvm/llvm-project/issues/182943",
    description:
      "macOS 26.4 Dyld.framework reimplemented dyld_shared_cache_iterate_text in Swift; " +
      "the _Block_copy allocation deadlocks ASAN init re-entrantly",
    applies: cfg => cfg.darwin && cfg.asan,
    expectedToBeFixed: cfg => {
      // Fix merged to LLVM main. Backport to release/22.x is
      // https://github.com/llvm/llvm-project/pull/188913 — lower this
      // threshold to the exact 22.1.x once it lands. Apple clang is
      // already excluded: resolveLlvmToolchain only accepts Homebrew
      // llvm (LLVM_VERSION_RANGE is >=21 <23), so cfg.clangVersion is
      // always LLVM clang's version here.
      const FIXED_IN_LLVM = "22.1.4";
      return cfg.clangVersion !== undefined && satisfiesRange(cfg.clangVersion, `>=${FIXED_IN_LLVM}`);
    },
    cleanup: `Delete scripts/build/shims/asan-dyld-shim.c, scripts/build/shims.ts, the emitShims() calls in bun.ts, registerShimRules in rules.ts, and this entry.`,
  },
  {
    id: "rust-lld-for-crosslang-lto",
    issue: "https://rustc-dev-guide.rust-lang.org/backend/updating-llvm.html",
    description:
      "rustc's bundled LLVM is newer than clang's, so clang's ld.lld can't read " +
      "-Clinker-plugin-lto bitcode (forward-compatible only). Link with rust-lld instead " +
      "(and compress ELF debug sections post-link via llvm-objcopy, since rust-lld lacks zlib).",
    applies: cfg => cfg.crossLangLto && cfg.rustLlvmVersion !== undefined && cfg.clangVersion !== undefined,
    expectedToBeFixed: cfg => {
      // Obsolete once clang's LLVM major catches up to (or passes) rustc's —
      // at that point clang's own ld.lld reads rustc's bitcode and the
      // rust-lld swap in resolveConfig() never fires.
      const clangMajor = Number(cfg.clangVersion!.split(".")[0]);
      const rustMajor = Number(cfg.rustLlvmVersion!.split(".")[0]);
      return clangMajor >= rustMajor;
    },
    cleanup:
      `Delete the rust-lld swap block in resolveConfig() (config.ts), findRustLld() and its call ` +
      `in resolveLlvmToolchain() (tools.ts), the rustLld/rustLlvmVersion fields on Toolchain/Config, ` +
      `and this entry.`,
  },
  {
    id: "darwin-cross-stack-size",
    issue:
      "https://github.com/llvm/llvm-project/blob/main/lld/MachO/Driver.cpp (OPT_stack_size in unimplemented warnings)",
    description:
      "ld64.lld parses `-stack_size` but doesn't implement it (\"is not yet implemented. Stay " +
      'tuned..."), so darwin cross links keep the 8 MB default main-thread stack instead of the ' +
      "18 MB JSC needs. shims/macho-postlink.c patches LC_MAIN.stacksize after the link instead.",
    applies: cfg => cfg.darwin && cfg.crossTarget !== undefined,
    expectedToBeFixed: cfg => {
      // Not implemented as of LLVM 21 (lld/MachO/Driver.cpp keeps
      // OPT_stack_size in the "unimplemented, warn and ignore" list).
      // Re-test when the toolchain moves to LLVM 23: link a darwin cross
      // build and check whether `ld64.lld ... -stack_size 0x1200000` still
      // prints "is not yet implemented". If it does, bump this threshold.
      // (A configure-time probe that spawned ld64.lld was tried first and
      // reverted: the rust/cpp split steps configure on machines whose
      // ld64.lld doesn't behave like the link machine's, and a probe that
      // misfires there fails the whole lane.)
      const FIXED_IN_LLVM = "23.0.0";
      return cfg.clangVersion !== undefined && satisfiesRange(cfg.clangVersion, `>=${FIXED_IN_LLVM}`);
    },
    cleanup:
      `Drop the --stack-size argument from machoPostlinkCommand() in scripts/build/shims.ts and ` +
      `this entry. Keep macho-postlink.c itself — it still owns the entitlements embedding and ` +
      `the post-edit re-sign.`,
  },
  {
    id: "rust-lld-musl-crt-zlib",
    issue: "https://github.com/rust-lang/rust/issues/data-compression-not-enabled",
    description:
      "rust-lld is built without LLVM_ENABLE_ZLIB. Alpine's musl CRT objects ship with " +
      "ELFCOMPRESS_ZLIB debug sections, which rust-lld rejects at input parse time. " +
      "Decompress them via objcopy and prepend a -B search path.",
    // Only exercised when the rust-lld swap actually fired on a musl link.
    applies: cfg => cfg.linux && cfg.abi === "musl" && cfg.rustLld !== undefined && cfg.ld === cfg.rustLld,
    expectedToBeFixed: cfg => {
      // Obsolete the same instant the rust-lld swap above is — once clang's
      // ld.lld (built with zlib) reads rustc's bitcode, we never select
      // rust-lld and the compressed CRTs are a non-issue.
      const clangMajor = Number(cfg.clangVersion!.split(".")[0]);
      const rustMajor = Number(cfg.rustLlvmVersion!.split(".")[0]);
      return clangMajor >= rustMajor;
    },
    cleanup:
      `Delete needsMuslCrtDecompress(), MUSL_CRT_OBJECTS, the shim_crt_decompress rule, and the ` +
      `musl block in emitShims() (scripts/build/shims.ts), and this entry.`,
  },
  {
    id: "android-posix-spawn-setsid-const",
    issue: "https://github.com/rust-lang/libc/pull/5104",
    description:
      "The libc crate doesn't expose POSIX_SPAWN_SETSID for target_os = android, so the " +
      "linux+android cfg arm in spawn_sys hardcodes 0x80 (the value glibc/musl/bionic share).",
    // Cleanup is a source-code change, not a build-config change — once
    // Cargo.lock's libc has the constant, the local 0x80 can go regardless
    // of which target is being built. Gate to android so the threshold-bump
    // hint doesn't bother host-only builds.
    applies: cfg => cfg.abi === "android",
    expectedToBeFixed: cfg => {
      // PR #5104 targets `main` with `stable-nominated`; a 0.2.x cherry-pick
      // follows. Best guess for the first 0.2.x with it — bump if the
      // constant isn't actually there yet.
      const FIXED_IN_LIBC = "0.2.187";
      const v = lockedCrateVersion(cfg, "libc");
      return v !== undefined && satisfiesRange(v, `>=${FIXED_IN_LIBC}`);
    },
    cleanup:
      `In src/spawn_sys/posix_spawn.rs (Attr::set) and src/spawn_sys/spawn_process.rs ` +
      `(options.detached block), replace the local 0x80 with libc::POSIX_SPAWN_SETSID, ` +
      `drop the explanatory comments, and delete this entry.`,
  },
  {
    id: "ohos-native-tls",
    issue: "https://github.com/llvm/llvm-project (no tracked issue — undocumented target default)",
    description:
      "clang defaults aarch64-linux-ohos to emulated TLS (-femulated-tls), routing every " +
      "__thread/thread_local access through a software __emutls_get_address lookup instead of a " +
      "native TP-register access. OHOS's musl fully supports native TLS (verified with a minimal " +
      "-fno-emulated-tls test program); the default looks inherited from Android's historical NDK " +
      "clang config rather than a real OHOS limitation. Without the override, mismatched TLS access " +
      "reliably SIGSEGVs inside mimalloc's per-thread heap pointer at startup.",
    applies: cfg => cfg.abi === "ohos",
    expectedToBeFixed: () => {
      // No version signal to check against — this is an undocumented
      // per-target default, not a tracked bug with a fix release. Re-test
      // by dropping -fno-emulated-tls from globalFlags (flags.ts) and
      // running `clang -### -c -x c /dev/null -o /dev/null --target=
      // aarch64-linux-ohos 2>&1 | grep -o -- '-f\\(no-\\)\\?emulated-tls'`
      // whenever the LLVM pin bumps; flip this to a real check once a
      // fixed version is known.
      return false;
    },
    cleanup:
      `Delete the -fno-emulated-tls entry in globalFlags (scripts/build/flags.ts) and this entry.`,
  },
  {
    id: "ohos-compat-shim-embed",
    issue: "https://gitee.com/openharmony (no tracked issue — application-sandbox seccomp policy)",
    description:
      "The OHOS app sandbox's seccomp filter SIGSYS-kills several Linux syscalls the kernel and " +
      "OpenHarmony itself otherwise support (close_range, fchmodat2, ...) instead of returning " +
      "ENOSYS/EPERM, and a few libc calls assume a traditional /etc/passwd-backed uid or writable " +
      "P_tmpdir. shims/ohos_compat_shim.c interposes the libc-symbol level of these (both the named " +
      "function and bun's own internal syscall()/close_range() callers, since it's linked directly " +
      "into the executable rather than LD_PRELOAD'd) and falls back to a userspace-safe path. " +
      "Canonical source lives in the standalone ../ohos-compat-shim repo, synced in as-needed — " +
      "diff before resyncing to confirm no bun-side customization has drifted.",
    applies: cfg => cfg.abi === "ohos",
    expectedToBeFixed: () => {
      // Sandbox policy, not a toolchain/library version — no reliable
      // signal to check. Re-test by removing the shim and running the
      // pipe-idle/close_range-triggering smoke test (`bun-profile
      // --revision` forks and hits close_range during its crash-handler
      // self-registration) on a newer OHOS SDK/device; flip to a real
      // check only if a future SDK exposes a queryable capability flag.
      return false;
    },
    cleanup:
      `Delete scripts/build/shims/ohos_compat_shim.c, the needsOhosCompatShim block in shims.ts ` +
      `(registerShimRules + emitShims), and this entry.`,
  },
  {
    id: "ohos-openat2-uncatchable-sigsys",
    issue: "https://gitee.com/openharmony (no tracked issue — application-sandbox seccomp policy)",
    description:
      "Unlike close_range (ohos-compat-shim-embed above), the OHOS app sandbox's seccomp filter " +
      "SIGSYS-kills openat2 in a way no libc-symbol interposition can catch: rustix's openat2 " +
      "backend issues the syscall via its own inline-asm trampoline, never touching a named libc " +
      "symbol a linked-in shim could interpose. src/sys/linux_syscall.rs short-circuits both " +
      "openat2_beneath and openat2_in_root to return ENOSYS on OHOS before ever attempting the " +
      "real syscall. Zero fallout elsewhere: both call sites (src/install/bin.rs and sys/lib.rs's " +
      "openat2_in_root) already treat ENOSYS/EPERM/EINVAL as \"openat2 unavailable on this kernel\" " +
      "for pre-5.6-kernel compatibility, so the existing fallback path (plain openat) just runs.",
    applies: cfg => cfg.abi === "ohos",
    expectedToBeFixed: () => {
      // Sandbox policy, not a toolchain/library version — no reliable
      // signal to check. Re-test by removing the two #[cfg(target_env =
      // "ohos")] short-circuits and running `bun install` on a newer OHOS
      // SDK/device; flip to a real check only if a future SDK exposes a
      // queryable capability flag.
      return false;
    },
    cleanup:
      `Remove the #[cfg(target_env = "ohos")] short-circuit blocks from openat2_beneath and ` +
      `openat2_in_root in src/sys/linux_syscall.rs, and this entry.`,
  },
  {
    id: "ohos-codesign-required",
    issue: "https://gitee.com/openharmony (no tracked issue — platform ELF execution policy)",
    description:
      "OHOS refuses to exec or dlopen an ELF without a valid HarmonyOS codesign section — a " +
      "native addon .node/.so from bun install, or a `bun build --compile` standalone executable, " +
      "is otherwise just an unsigned ELF and gets Permission denied. src/ohos_sign is a from-scratch " +
      "in-process implementation (no external binary-sign-tool fork) of OHOS's fs-verity-style ELF " +
      "code-signing format (SHA-256 + Merkle tree + descriptor), wired in at three points: " +
      "sys::dlopen() signs lazily before every dlopen (has_codesign() short-circuits the already-" +
      "signed case), PackageInstaller.rs/isolated_install/Installer.rs sign every .so/.node right " +
      "after `bun install` places it, and build_command.rs signs (with the appended-payload-safe " +
      "strip variant) right after writing a --compile output binary.",
    applies: cfg => cfg.abi === "ohos",
    expectedToBeFixed: () => {
      // Platform execution policy, not a toolchain/library version — no
      // reliable signal to check. Re-test by removing the ensure_signed()
      // call in sys::dlopen and running an unsigned .node addon on a newer
      // OHOS SDK/device; flip to a real check only if a future SDK adds an
      // opt-out or a queryable capability flag.
      return false;
    },
    cleanup:
      `Delete src/ohos_sign/, its "src/ohos_sign" workspace member entry and the three ` +
      `target-conditional dependency blocks (src/sys, src/install, src/runtime Cargo.toml), the ` +
      `ensure_signed()/ohos_sign::has_codesign() branch in sys::dlopen() (src/sys/lib.rs), the ` +
      `#[cfg(target_env = "ohos")] block calling ohos_sign_native_binaries() in ` +
      `src/install/PackageInstaller.rs and src/install/isolated_install/Installer.rs, the ` +
      `#[cfg(target_env = "ohos")] signing block in src/runtime/cli/build_command.rs, and this entry.`,
  },
  {
    id: "ohos-statx-rejects-socket-stdio",
    issue: "https://gitee.com/openharmony (no tracked issue — kernel statx(2) behavior)",
    description:
      "The HongMeng kernel's statx(2) rejects an AF_UNIX socket fd with EBADF even when it's a " +
      "genuinely open fd — verified via /proc/self/fd showing it as a live socket entry at the " +
      "exact moment statx rejects it. This bites any process whose stdio is a socketpair rather " +
      "than a plain FIFO (notably a bun process spawned by Node's child_process — Node's libuv " +
      "backs pipe-mode stdio with a socketpair on this platform, not pipe(2)). A plain shell `|` " +
      "(a real FIFO) never hits this. Every fs.fstatSync()/node:fs stat call on such a socket fd " +
      "(including bun's own startup isatty-style probing of fd 1/2) got the raw EBADF instead of " +
      "falling back to plain fstat(2), which handles any fd type correctly.",
    applies: cfg => cfg.abi === "ohos",
    expectedToBeFixed: () => {
      // Kernel behavior, not a toolchain/library version — no reliable
      // signal to check. Re-test by removing the EBADF arm from the
      // statx_impl fallback match in src/sys/lib.rs and calling
      // fs.fstatSync() on a socketpair-backed stdio fd (e.g. spawn bun
      // from Node with stdio: "pipe") on a newer OHOS SDK/device.
      return false;
    },
    cleanup:
      `Remove the "cfg!(target_env == "ohos") && errno == EBADF" arm from statx_impl's fallback ` +
      `match in src/sys/lib.rs, and this entry.`,
  },
  {
    id: "ohos-pwritev2-preadv2-espipe-socket",
    issue: "https://gitee.com/openharmony (no tracked issue — kernel pwritev2(2)/preadv2(2) behavior)",
    description:
      "The HongMeng kernel's pwritev2(fd, iov, 1, -1, RWF_NOWAIT) (and the read-side preadv2) " +
      "rejects an AF_UNIX socket fd with ESPIPE even though offset == -1 means 'do not seek, " +
      "behave like plain writev()/readv()' per Linux semantics — a real FIFO on this same kernel " +
      "is unaffected. This is the actual root cause of the js/bun/shell test-harness failure " +
      "bucket documented in project_ohos_bun_shell_pipe_output_loss: bun's shell IOWriter " +
      "(src/io/PipeWriter.rs's write_to_blocking_pipe) uses write_nonblocking() as its fast path " +
      "for any pollable fd (FIFO or socket alike — bun's Linux FileType classification does not " +
      "distinguish the two, only kqueue platforms do), so a bun process whose stdout/stderr is a " +
      "socketpair (spawned via Node's child_process, or scripts/runner.node.mjs, or any OHOS-hosted " +
      "orchestrator) gets ESPIPE on every write attempt with no existing fallback arm — the error " +
      "propagated up as a real write failure, silently swallowed by the shell builtin's error path " +
      "(state=Err, exit code 1, no message), producing the exact symptom: instant test completion, " +
      "captured stdout/stderr empty. Verified via inline diagnostics (temporary eprintln! at each " +
      "layer of is_pollable → try_write → write_to_blocking_pipe → write_nonblocking) showing " +
      "'errno: 29 (ESPIPE)' from pwritev2 on the socket-backed fd, immediately fixed by adding an " +
      "ESPIPE fallback arm. Fixed as a **per-call** fallback (no linux::RWFFlagSupport::disable()), " +
      "unlike the existing EOPNOTSUPP/ENOSYS/EPERM/EACCES arms — those indicate the kernel lacks " +
      "RWF_NOWAIT support entirely (safe to disable globally), but this kernel's real pipes take " +
      "the fast path fine, so disabling it process-wide would needlessly lose that fast path for " +
      "every FIFO write for the rest of the process's life.",
    applies: cfg => cfg.abi === "ohos",
    expectedToBeFixed: () => {
      // Kernel behavior, not a toolchain/library version — no reliable
      // signal to check. Re-test by removing the ESPIPE arms from
      // read_nonblocking/write_nonblocking in src/sys/lib.rs and running
      // test/js/bun/shell/commands/basename.test.ts spawned via Node's
      // child_process with stdio: "pipe" on a newer OHOS SDK/device.
      return false;
    },
    cleanup:
      `Remove the "libc::ESPIPE if cfg!(target_env = \"ohos\")" arms from both ` +
      `read_nonblocking and write_nonblocking in src/sys/lib.rs, and this entry.`,
  },
  {
    id: "ohos-inotify-attrib-before-create",
    issue: "https://gitee.com/openharmony (no tracked issue — kernel inotify(7) event ordering)",
    description:
      "The HongMeng kernel's inotify occasionally delivers IN_ATTRIB for a brand-new file " +
      "*before* the IN_CREATE event for the same name, in the same read() batch — verified via " +
      "inline tracing (a single read() on the inotify fd returned both events together, ATTRIB " +
      "first). ext4 on mainline Linux always delivers IN_CREATE first for a plain " +
      "fs.writeFileSync()-style create+write+close. This broke Node's fs.watch() 'rename' vs " +
      "'change' classification (src/runtime/node/path_watcher.rs): the classifier only looked at " +
      "the single event being dispatched, so the spurious leading ATTRIB got classified as " +
      "'change' and dispatched to the listener before the real CREATE (which should have been " +
      "'rename') ever arrived — reproduced in both plain and {recursive:true} fs.watch(), so not " +
      "a recursive-walk artifact. Fixed by scanning the rest of the already-in-memory read() " +
      "batch for a rename-worthy event on the same (watch descriptor, filename) before falling " +
      "back to 'change'; gated to OHOS so other platforms' classification is untouched. Known " +
      "residual: two js/node/test cases (test-fs-watch-recursive-sync-write.js, " +
      "test-fs-watch-recursive-symlink.js) still fail because their ATTRIB/CREATE pair lands in " +
      "*separate* read() calls, which same-batch lookahead cannot see — closing that gap would " +
      "need a short cross-read coalescing window, deliberately not done here (adds dispatch " +
      "latency for every fs.watch() consumer on this platform, not just the pathological case).",
    applies: cfg => cfg.abi === "ohos",
    expectedToBeFixed: () => {
      // Kernel behavior, not a toolchain/library version — no reliable
      // signal to check. Re-test by removing the `batch_has_rename_event`
      // OHOS-gated lookahead in src/runtime/node/path_watcher.rs and running
      // test/js/node/test/sequential/test-fs-watch.js plus the
      // test/js/node/test/parallel/test-fs-watch-recursive-*.js cluster on a
      // newer OHOS SDK/device.
      return false;
    },
    cleanup:
      "Remove `batch_has_rename_event` and its call site in " +
      "src/runtime/node/path_watcher.rs's thread_main, and this entry.",
  },
  {
    id: "ohos-fstat-eacces-on-memfd",
    issue: "https://gitee.com/openharmony (no tracked issue — kernel fstat(2)/statx(2) behavior)",
    description:
      "The HongMeng kernel's fstat(2) (via statx internally) returns EACCES for a memfd_create()'d " +
      "fd, even though pread(2)/write(2) on that exact same fd work correctly — confirmed by a " +
      "from-scratch libc-only repro (memfd_create + write + pread round-trips fine; fstat on the " +
      "same fd fails with errno 13). This broke src/sys/file.rs's File::read_to_end() for any " +
      "memfd-backed fd, used by bun's internal (non-JS) synchronous spawn helper " +
      "(src/spawn/process.rs's sync::spawn, used by `bun pm version`'s git integration, the " +
      "security scanner, and other CLI-only child-process capture) for its Linux memfd-based " +
      "'.buffer' stdio path — read_to_end_with_array_list()'s SizeHint::UnknownSize branch called " +
      "self.get_end_pos()? (an fstat-based capacity hint) with the `?` operator, so the fstat " +
      "failure aborted the whole read before the pread() that would have succeeded ever ran. " +
      "Symptom: the child process runs and exits normally (status looks fine), but its captured " +
      "stdout is always empty — verified with a raw async-signal-safe write() probe inserted right " +
      "before execve() in the vfork child (src/jsc/bindings/bun-spawn.cpp's posix_spawn_bun): the " +
      "probe's own bytes land in the memfd correctly, so the write side was never the problem — " +
      "only the parent's post-wait read-back was. Same root-cause family as " +
      "ohos-statx-rejects-socket-stdio (socket fd → EBADF) and " +
      "ohos-pwritev2-preadv2-espipe-socket (socket fd → ESPIPE): this kernel's statx/fstat and " +
      "RWF_NOWAIT fast paths disagree with mainline Linux for several non-regular-file fd kinds, " +
      "each with a different wrong errno.",
    applies: cfg => cfg.abi === "ohos",
    expectedToBeFixed: () => {
      // Kernel behavior, not a toolchain/library version — no reliable
      // signal to check. Re-test by reverting the `.unwrap_or(0)` fallback
      // in src/sys/file.rs's read_to_end_with_array_list back to `?` and
      // running test/cli/install/bun-pm-version.test.ts on a newer OHOS
      // SDK/device — the "git integration > fails when git working
      // directory is not clean" case is the most direct repro.
      return false;
    },
    cleanup:
      "Revert the `.unwrap_or(0)` fallback in src/sys/file.rs's " +
      "read_to_end_with_array_list back to the `?` operator on " +
      "self.get_end_pos(), and this entry.",
  },
  {
    id: "ohos-waiter-thread-default",
    issue: "https://gitee.com/openharmony (no tracked issue — kernel pidfd/epoll notification behavior)",
    description:
      "The HongMeng kernel's pidfd + shared-epoll child-exit notification path never resolves: " +
      "a child zombies but the epoll loop thread never wakes for it, so anything waiting on " +
      "`Bun.spawn`/internal spawn to detect process exit hangs until the caller's own timeout " +
      "kills it. `SHOULD_USE_WAITER_THREAD` (src/spawn_sys/lib.rs) already existed upstream as a " +
      "fallback flag for Linux hosts without pidfd support, routing child-exit detection through " +
      "a dedicated waiter thread instead of the shared epoll loop — just needed defaulting to " +
      "true on OHOS instead of false. Verified: test/cli/install/bun-pm-why.test.ts went from " +
      "13/28 failing (each hanging to its own timeout boundary) to 28/28 clean; a sleep-child " +
      "CPU-sampling probe confirmed the waiter thread genuinely blocks on wait4() rather than " +
      "busy-polling (no utime/stime growth across a 2s idle window).",
    applies: cfg => cfg.abi === "ohos",
    expectedToBeFixed: () => {
      // Kernel behavior, not a toolchain/library version — no reliable
      // signal to check. Re-test by flipping SHOULD_USE_WAITER_THREAD's
      // OHOS default back to false in src/spawn_sys/lib.rs and running
      // test/cli/install/bun-pm-why.test.ts on a newer OHOS SDK/device.
      return false;
    },
    cleanup:
      'Change `AtomicBool::new(cfg!(target_env = "ohos"))` back to ' +
      "`AtomicBool::new(false)` for SHOULD_USE_WAITER_THREAD in " +
      "src/spawn_sys/lib.rs, and this entry.",
  },
  {
    id: "ohos-no-orphans-wait-signalfd-skip",
    issue: "https://gitee.com/openharmony (no tracked issue — kernel signalfd behavior under --no-orphans)",
    description:
      "src/spawn/process.rs's wait_linux_signalfd path (used only for `--no-orphans`'s " +
      "ParentDeathWatchdog machinery) hangs on this kernel the same way the default pidfd/epoll " +
      "path does (see ohos-waiter-thread-default) — skipped on OHOS in favor of a poll+wait4 loop " +
      "plus independent pidfd/ppid-polling for parent-death detection. Real and independently " +
      "verified, but turned out NOT to be the actual cause of no-orphans.test.ts's hangs (see " +
      "ohos-proc-children-fallback for that) — kept because it's still a genuine gap the default " +
      "signalfd path would hit on this kernel.",
    applies: cfg => cfg.abi === "ohos",
    expectedToBeFixed: () => {
      // Kernel behavior, not a toolchain/library version — no reliable
      // signal to check. Re-test by removing the OHOS skip around
      // wait_linux_signalfd in src/spawn/process.rs and running
      // test/cli/run/no-orphans.test.ts on a newer OHOS SDK/device.
      return false;
    },
    cleanup:
      "Remove the OHOS-specific skip of wait_linux_signalfd (and its " +
      "poll+wait4/pidfd-polling replacement) in src/spawn/process.rs, and " +
      "this entry.",
  },
  {
    id: "ohos-spawn-fork-not-vfork-pwd",
    issue: "https://gitee.com/openharmony (no tracked issue — SELinux/vfork shared-address-space behavior)",
    description:
      "src/jsc/bindings/bun-spawn.cpp's posix_spawn_bun (the fork/exec funnel every spawn goes " +
      "through) needs two OHOS-specific behaviors, both previously discovered and fixed on the " +
      "ohos-aarch64 reference branch but never ported to this from-scratch rebuild: (1) use " +
      "fork() instead of vfork() — this kernel's SELinux policy makes vfork's shared-address-space " +
      "child fragile (self-pipe exec-failure detection + a fork fallback if vfork itself fails); " +
      "(2) after chdir() in the child, explicitly sync $PWD in the child's env (drop any stale/ " +
      "caller-set PWD, append the correct one) — see project_ohos_bun_spawn_cwd_getcwd_bug: " +
      "chdir()-then-exec() leaves the exec'd binary's own getcwd() broken (EACCES) for EL2-sandbox " +
      "paths, and shells/tools trust an inherited $PWD over calling getcwd() themselves. Verified " +
      "the PWD fix independently (bash -c 'pwd; echo $PWD' clean, no EACCES); did not fix " +
      "no-orphans.test.ts's hangs (that was ohos-proc-children-fallback) despite being the most " +
      "likely-looking candidate at the time.",
    applies: cfg => cfg.abi === "ohos",
    expectedToBeFixed: () => {
      // Kernel/SELinux behavior, not a toolchain/library version — no
      // reliable signal to check. Re-test by reverting to vfork() and
      // removing the PWD-sync block in posix_spawn_bun
      // (src/jsc/bindings/bun-spawn.cpp) and running Bun.spawn({cwd:
      // "..."}) followed by a child that shells out and reads $PWD, on a
      // newer OHOS SDK/device.
      return false;
    },
    cleanup:
      "Revert posix_spawn_bun's OHOS branch (fork()-not-vfork(), the " +
      "PWD-sync-after-chdir block, cgroup-skip, pthread_setcancelstate " +
      "skip) in src/jsc/bindings/bun-spawn.cpp, and this entry.",
  },
  {
    id: "ohos-proc-children-fallback",
    issue: "https://gitee.com/openharmony (no tracked issue — kernel missing CONFIG_PROC_CHILDREN)",
    description:
      "src/io/ParentDeathWatchdog.rs's list_child_pids_linux() enumerates a process's children via " +
      "/proc/<pid>/task/<tid>/children — a Linux procfs feature gated on the kernel config " +
      "CONFIG_PROC_CHILDREN, which this kernel doesn't have. The function didn't distinguish " +
      "'read failed because the feature is absent' from 'read succeeded and the list is genuinely " +
      "empty', so it silently returned 0 children on every call. This was the true root cause of " +
      "no-orphans.test.ts's two hangs (not PR_SET_CHILD_SUBREAPER, which works correctly on this " +
      "kernel — confirmed via a PR_GET_CHILD_SUBREAPER read-back showing value=1): " +
      "kill_subreaper_adoptees() could never find the escaped setsid daemon it was supposed to " +
      "kill, so it kept the spawned process's inherited stderr pipe open forever, hanging the " +
      "test's `Promise.all([...stderr.text(), proc.exited])` even though proc.exited itself " +
      "resolved quickly. Fixed by tracking whether any /proc/<pid>/task/<tid>/children read ever " +
      "actually succeeded; if none did across the whole scan, fall back to a full /proc walk " +
      "matching each process's own /proc/<pid>/stat ppid field. Verified: no-orphans.test.ts's two " +
      "30s-timeout hangs resolved, file time 60+s -> 3.42s, no PPID=1 daemon leftover after the run.",
    applies: cfg => cfg.abi === "ohos",
    expectedToBeFixed: () => {
      // Kernel-config behavior, not a toolchain/library version — no
      // reliable signal to check from userspace (CONFIG_PROC_CHILDREN
      // isn't queryable without root or a matching /proc/config.gz). Re-test
      // by reading /proc/self/task/<tid>/children directly on a newer OHOS
      // SDK/device and checking it actually returns data, or by removing
      // the children_file_usable fallback in
      // src/io/ParentDeathWatchdog.rs's list_child_pids_linux() and running
      // test/cli/run/no-orphans.test.ts.
      return false;
    },
    cleanup:
      "Remove the children_file_usable tracking + list_child_pids_by_scan() " +
      "fallback in src/io/ParentDeathWatchdog.rs's list_child_pids_linux(), " +
      "and this entry.",
  },
  {
    id: "ohos-standalone-graph-elf-lookup",
    issue: "https://gitee.com/openharmony (no tracked issue — OHOS dynamic linker maps the ELF header non-executable)",
    description:
      "src/standalone_graph/StandaloneModuleGraph.rs's elf::get_data() -- called unconditionally " +
      "by every `bun build --compile` standalone executable at startup to locate its own embedded " +
      "`.bun` payload -- used the default (non-OHOS) implementation, which resolves an exported " +
      "symbol (Bun__getStandaloneModuleGraphELFVaddr) plus a PIE load-bias lookup via " +
      "find_loaded_module. This never resolves on OHOS: the dynamic linker here maps the ELF " +
      "header non-executable (`r--p`), which the default lookup path doesn't anticipate. Replaced " +
      "with an OHOS-specific implementation: open /proc/self/exe, parse ELF section headers " +
      "directly to locate `.bun` by name, mmap(MAP_PRIVATE) that byte range; when /proc/self/exe " +
      "open fails (hmdfs can deny it), fall back to parsing /proc/self/maps for the PIE load base " +
      "(matching the first file-backed mapping at file offset 0 -- can't match on exec permission " +
      "since OHOS maps it r--p, not r-xp). Also added ftruncate(fd, 0) before rewriting a cloned " +
      "executable's ELF data in inject() (clears COW/reflink state left by copy_file_range, " +
      "otherwise a later write can land on stale disk pages) and fsync() after writing (the " +
      "subsequent move_file_z_with_handle copy uses copy_file_range, which reads from disk, not " +
      "page cache). Both real, verified gaps (confirmed via a direct diff against the fork's own " +
      "ohos-aarch64 reference branch, down to only rustfmt-level residue), but do NOT fix the " +
      "still-open Footer/Banner compile+spawn hang tracked in test/expectations.txt -- that one is " +
      "a separate, unresolved SIGKILL-vs-codesign-verification race.",
    applies: cfg => cfg.abi === "ohos",
    expectedToBeFixed: () => {
      // Kernel/linker behavior, not a toolchain/library version — no
      // reliable signal to check. Re-test by reverting elf::get_data() to
      // the default (non-OHOS) implementation and running
      // test/bundler/bundler_compile.test.ts's ELF-section-lookup cases on
      // a newer OHOS SDK/device.
      return false;
    },
    cleanup:
      "Delete the `#[cfg(target_env = \"ohos\")] mod imp` block in " +
      "StandaloneModuleGraph.rs's `mod elf`, and the ftruncate/fsync calls " +
      "in inject(), and this entry.",
  },
  {
    id: "ohos-pipewriter-idle-busy-spin",
    issue: "https://gitee.com/openharmony (no tracked issue — kernel EPOLLONESHOT/CTL_DEL behavior)",
    description:
      "src/io/PipeWriter.rs's PosixPipeWriter::on_poll(), on an empty-buffer/non-hangup EPOLLOUT " +
      "wake, did nothing OHOS-specific -- the epoll registration stayed armed and kept re-firing " +
      "EPOLLOUT forever with nothing to write, pinning the event-loop thread (and, as a downstream " +
      "consequence, mimalloc's scavenger thread) at ~100% CPU even while fully idle. A pipe-idle " +
      "probe (spawn a child, drain 50 written chunks, sample /proc/<pid>/stat over an 11s idle " +
      "window) measured 16.45s of CPU time in that window before the fix. Two-layer fix, both " +
      "load-bearing (a prior attempt on the ohos-aarch64 reference branch to delete just this code " +
      "was reverted after real-device A/B testing showed the busy-spin came back): (1) force- " +
      "unregister the poll registration on an empty-buffer wake -- this kernel doesn't honor " +
      "EPOLLONESHOT auto-disarm, so an armed registration re-fires the same wake indefinitely; (2) " +
      "a same-fd wake-streak counter with a small sleep backoff, since some kernels here keep " +
      "delivering EPOLLOUT even after CTL_DEL succeeds (unregister alone isn't fully reliable). " +
      "Verified fixed: 16.45s -> 0.04s over the same window, zero threads with >0.01s CPU delta " +
      "across 5 samples.",
    applies: cfg => cfg.abi === "ohos",
    expectedToBeFixed: () => {
      // Kernel behavior, not a toolchain/library version — no reliable
      // signal to check. Re-test by removing the force-unregister +
      // wake-streak backoff from PosixPipeWriter::on_poll() in
      // src/io/PipeWriter.rs and running the pipe-idle CPU probe (spawn a
      // child that writes then goes idle, sample /proc/<pid>/stat
      // utime+stime over an 11s window) on a newer OHOS SDK/device.
      return false;
    },
    cleanup:
      "Remove the two `#[cfg(target_env = \"ohos\")]` blocks (force- " +
      "unregister + wake-streak backoff) from PosixPipeWriter::on_poll() " +
      "in src/io/PipeWriter.rs, and this entry.",
  },
  {
    id: "ohos-ld-preload-node",
    issue: "https://gitee.com/openharmony (no tracked issue — app-sandbox uid has no /etc/passwd entry)",
    description:
      "A `node`-like child exec'd by bun (Bun.spawn/Bun.$/bun run scripts) gets the app-sandbox " +
      "uid's real dynamic-musl libc, not the ohos-compat-shim symbols linked directly into bun's " +
      "own executable (see ohos-compat-shim-embed), so its os.userInfo() throws ENOENT (uids like " +
      "20020101 have no /etc/passwd record). Fixed by compiling ohos_compat_shim.c a second way " +
      "(-shared -fPIC, scripts/build/shims.ts's shim_cc_so rule) into a standalone " +
      "libohos_compat_preload.so next to the executable, and injecting LD_PRELOAD=<path> onto " +
      "node-like children (argv0 basename match: node/nodejs/nodeNN/npm/npx/corepack/yarn/pnpm/ " +
      "pnpx) in src/runtime/api/bun/ohos_ld_preload.rs, called from both js_bun_spawn_bindings.rs " +
      "and shell/subproc.rs. Needed an explicit -fvisibility=default override in the shim_cc_so " +
      "rule -- globalFlags' -fvisibility=hidden (correct default for every other translation unit " +
      "in this build) hides getpwuid_r from the .so's dynamic symbol table otherwise, silently " +
      "defeating the whole interposition (caught via llvm-nm -D showing a local `t` symbol instead " +
      "of global `T`). Escape hatch: BUN_OHOS_NO_LD_PRELOAD_NODE=1.",
    applies: cfg => cfg.abi === "ohos",
    expectedToBeFixed: () => {
      // Sandbox/kernel behavior (no /etc/passwd for app-sandbox uids), not a
      // toolchain/library version — no reliable signal to check. Re-test by
      // removing the LD_PRELOAD injection and running `Bun.spawnSync` (or
      // `Bun.$`) against the real installed node binary's
      // `os.userInfo()` on a newer OHOS SDK/device.
      return false;
    },
    cleanup:
      "Delete src/runtime/api/bun/ohos_ld_preload.rs, its two call sites in " +
      "js_bun_spawn_bindings.rs and shell/subproc.rs, the shim_cc_so rule " +
      "and libohos_compat_preload.so build edge in scripts/build/shims.ts, " +
      "and this entry.",
  },
];

/**
 * Check every workaround. Throws if any is obsolete on the current config.
 * Call from configure.ts after Config is fully resolved.
 */
export function checkWorkarounds(cfg: Config): void {
  // Expiry thresholds are written against the pinned toolchains. With an
  // explicitly supplied one (BUN_TOOLCHAIN_LLVM / BUN_TOOLCHAIN_RUST), which may
  // be newer than the pin, an expired workaround is reported, not fatal.
  const overridden = toolchainOverride.llvm !== undefined || toolchainOverride.rust !== undefined;
  for (const w of workarounds) {
    if (!w.applies(cfg)) continue;
    if (!w.expectedToBeFixed(cfg)) continue;

    const title = `Workaround '${w.id}' is obsolete — upstream fix is available`;
    const hint =
      `${w.description}\n` +
      `  Tracked: ${w.issue}\n\n` +
      `${w.cleanup}\n\n` +
      `If the issue still reproduces, bump the threshold in expectedToBeFixed() in scripts/build/workarounds.ts instead.`;
    if (overridden) {
      console.warn(`note: ${title} (with the overridden toolchain)\n${hint}\n`);
      continue;
    }
    throw new BuildError(title, { hint });
  }
}
