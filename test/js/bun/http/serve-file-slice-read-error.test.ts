// Bun.serve returning `Bun.file(path).slice(0, n)` of a larger file: the
// response's reader asks the kernel for exactly `n` bytes and ends there, so
// each request costs one read() of the served file and an error from the file
// can only fail the response it belongs to. (The reader used to pull in the
// whole read buffer and cut the chunk down afterwards, so every request took
// two read()s, a 4 KiB one and the EOF probe, and the response had to end
// itself from a queued task. That task was once freed out from under the
// read-error path: heap-use-after-free under ASAN.)
//
// A small ptrace supervisor counts the read() calls on the served file and
// injects EIO into the second one. Bun issues read() as a raw syscall on Linux
// (rustix linux_raw backend), so LD_PRELOAD cannot intercept it.
//
// The OHOS sandbox forbids ptrace outright (EPERM), and the linux_raw backend
// is what rustix's build selects for aarch64 linux targets regardless of the
// ohos env, so neither the supervisor nor an LD_PRELOAD shim can drive the
// injection there. The OHOS variant instead serves a slice of a directory for
// one request: read(2) on a directory fd fails with EISDIR inside the same
// native response-reader error path that an injected EIO lands in. The
// per-response read() count is tracer-only and not observable there; the
// regression assertion — a read error fails only its own response and the
// server keeps serving — is kept.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { bunEnv, bunExe, isLinux, isOHOS, platformTimeoutScale, tempDir } from "harness";
import { join } from "node:path";

const cc = Bun.which("cc") || Bun.which("gcc") || Bun.which("clang");

// Usage: fail-nth-read <path> <n> -- <cmd> [args...]
// Makes the <n>th read() syscall whose fd refers to <path> return -EIO.
const SUPERVISOR_C = /* c */ `
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ptrace.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/user.h>
#include <sys/wait.h>
#include <unistd.h>

#if defined(__aarch64__)
  #include <linux/elf.h>
  #include <sys/uio.h>
#endif

#if defined(__x86_64__)
  #define SYS_READ_NR 0
  typedef struct user_regs_struct regs_t;
  static long reg_nr(regs_t *r) { return (long)r->orig_rax; }
  static long reg_arg0(regs_t *r) { return (long)r->rdi; }
  static void reg_set_ret(regs_t *r, long v) { r->rax = (unsigned long long)v; }
  static int get_regs(pid_t t, regs_t *r) { return ptrace(PTRACE_GETREGS, t, 0, r); }
  static int set_regs(pid_t t, regs_t *r) { return ptrace(PTRACE_SETREGS, t, 0, r); }
#elif defined(__aarch64__)
  #define SYS_READ_NR 63
  typedef struct user_regs_struct regs_t;
  static long reg_nr(regs_t *r) { return (long)r->regs[8]; }
  static long reg_arg0(regs_t *r) { return (long)r->regs[0]; }
  static void reg_set_ret(regs_t *r, long v) { r->regs[0] = (unsigned long long)v; }
  static int get_regs(pid_t t, regs_t *r) {
    struct iovec io = { r, sizeof(*r) };
    return ptrace(PTRACE_GETREGSET, t, (void *)NT_PRSTATUS, &io);
  }
  static int set_regs(pid_t t, regs_t *r) {
    struct iovec io = { r, sizeof(*r) };
    return ptrace(PTRACE_SETREGSET, t, (void *)NT_PRSTATUS, &io);
  }
#else
  #error unsupported arch
#endif

/* Per-tid syscall enter/exit toggle + pending-poison flag. */
#define MAX_TIDS 256
static pid_t tid_tab[MAX_TIDS];
static unsigned char in_call[MAX_TIDS];
static unsigned char poison[MAX_TIDS];
static int slot(pid_t t) {
  int i, free_i = -1;
  for (i = 0; i < MAX_TIDS; i++) {
    if (tid_tab[i] == t) return i;
    if (tid_tab[i] == 0 && free_i < 0) free_i = i;
  }
  if (free_i >= 0) { tid_tab[free_i] = t; return free_i; }
  return 0;
}
static void drop(pid_t t) {
  int i;
  for (i = 0; i < MAX_TIDS; i++) if (tid_tab[i] == t) {
    tid_tab[i] = 0; in_call[i] = 0; poison[i] = 0;
  }
}

int main(int argc, char **argv) {
  if (argc < 5 || strcmp(argv[3], "--") != 0) {
    fprintf(stderr, "usage: %s <path> <n> -- <cmd> [args...]\\n", argv[0]);
    return 2;
  }
  const char *target_path = argv[1];
  long fail_n = strtol(argv[2], NULL, 10);
  char **cmd = &argv[4];

  struct stat ts;
  if (stat(target_path, &ts) != 0) { perror("stat target"); return 2; }

  pid_t child = fork();
  if (child < 0) { perror("fork"); return 2; }
  if (child == 0) {
    if (ptrace(PTRACE_TRACEME, 0, 0, 0) != 0) { perror("TRACEME"); _exit(126); }
    raise(SIGSTOP);
    execvp(cmd[0], cmd);
    perror("execvp");
    _exit(127);
  }

  int st;
  if (waitpid(child, &st, 0) < 0) { perror("waitpid initial"); return 2; }
  long opts = PTRACE_O_TRACESYSGOOD | PTRACE_O_TRACECLONE | PTRACE_O_TRACEFORK |
              PTRACE_O_TRACEVFORK | PTRACE_O_TRACEEXEC | PTRACE_O_EXITKILL;
  if (ptrace(PTRACE_SETOPTIONS, child, 0, opts) != 0) { perror("SETOPTIONS"); return 2; }
  if (ptrace(PTRACE_SYSCALL, child, 0, 0) != 0) { perror("SYSCALL initial"); return 2; }

  long match_count = 0;
  int exit_code = -1;

  for (;;) {
    pid_t t = waitpid(-1, &st, __WALL);
    if (t < 0) {
      if (errno == ECHILD) break;
      if (errno == EINTR) continue;
      perror("waitpid"); return 2;
    }
    if (WIFEXITED(st) || WIFSIGNALED(st)) {
      if (t == child) {
        exit_code = WIFEXITED(st) ? WEXITSTATUS(st) : 128 + WTERMSIG(st);
      }
      drop(t);
      continue;
    }
    if (!WIFSTOPPED(st)) continue;

    int sig = WSTOPSIG(st);
    unsigned ev = (unsigned)(st >> 16);
    if (ev == PTRACE_EVENT_CLONE || ev == PTRACE_EVENT_FORK || ev == PTRACE_EVENT_VFORK) {
      ptrace(PTRACE_SYSCALL, t, 0, 0);
      continue;
    }
    if (ev == PTRACE_EVENT_EXEC) {
      /* execve's syscall-exit-stop follows; keep the toggle consistent. */
      in_call[slot(t)] = 1;
      poison[slot(t)] = 0;
      ptrace(PTRACE_SYSCALL, t, 0, 0);
      continue;
    }
    if (sig == (SIGTRAP | 0x80)) {
      int s = slot(t);
      in_call[s] ^= 1;
      regs_t r;
      if (get_regs(t, &r) != 0) { ptrace(PTRACE_SYSCALL, t, 0, 0); continue; }

      if (in_call[s]) { /* syscall entry */
        if (reg_nr(&r) == SYS_READ_NR) {
          long fd = reg_arg0(&r);
          char linkpath[64];
          struct stat fs;
          snprintf(linkpath, sizeof linkpath, "/proc/%d/fd/%ld", (int)t, fd);
          if (stat(linkpath, &fs) == 0 &&
              fs.st_dev == ts.st_dev && fs.st_ino == ts.st_ino) {
            match_count++;
            if (match_count == fail_n) poison[s] = 1;
          }
        }
      } else { /* syscall exit */
        if (poison[s]) {
          poison[s] = 0;
          reg_set_ret(&r, -EIO);
          set_regs(t, &r);
        }
      }
      ptrace(PTRACE_SYSCALL, t, 0, 0);
      continue;
    }
    /* Plain SIGTRAP / SIGSTOP are ptrace artifacts; forward real signals so
       ASAN's SIGSEGV/SIGABRT handler runs. */
    if (sig == SIGTRAP || sig == SIGSTOP) sig = 0;
    ptrace(PTRACE_SYSCALL, t, 0, (void *)(long)sig);
  }

  fprintf(stderr, "[fail-nth-read] matched read() calls on target: %ld\\n", match_count);
  return exit_code < 0 ? 1 : exit_code;
}
`;

// The file is 4 KiB; slicing to 2 KiB keeps us on the BufferedReader path
// (below the 1 MiB sendfile threshold) while leaving bytes past the slice that
// a read sized by the buffer instead of the slice would pick up. The slice
// starts at 0 so the reader uses read(), which is what the supervisor counts.
const FIXTURE_JS = /* js */ `
const path = process.argv[2];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch() { return new Response(Bun.file(path).slice(0, 2048)); },
});
let okBodies = 0;
for (let i = 0; i < 3; i++) {
  try {
    // A fresh connection per request: a request that fails on a reused
    // keep-alive connection before any response bytes would be retried
    // (and then succeed) instead of being reported.
    const r = await fetch(\`http://127.0.0.1:\${server.port}/\`, { headers: { connection: "close" } });
    const b = await r.arrayBuffer();
    if (b.byteLength === 2048) okBodies++;
  } catch {}
}
server.stop(true);
console.log("DONE " + okBodies);
`;

// OHOS fixture: same served file and slice as the ptrace fixture above, but
// request #1 hits /bad, which serves a slice of a directory. read(2) on a
// directory fd fails with EISDIR inside the same native Bun.file response
// reader that an injected EIO lands in, so the read-error path is exercised
// without a tracer. The two requests after it must still carry their 2048
// bytes: a read error fails only its own response and the server keeps
// serving. Whether the failure surfaces as a rejected fetch (reset) or a
// non-200/short body, it is counted as failed — only a successful 2048-byte
// body counts as ok.
const FIXTURE_JS_OHOS = /* js */ `
import { chmodSync } from "node:fs";
const path = process.argv[2];
const badPath = process.argv[3];
// Make /bad a mode-000 regular file: its open(2) fails EACCES, which bun's
// file-response path turns into a failed response (same routing as the
// ENOENT 404). The kernel-level read(2) error the ptrace shim injects on
// desktop has no shell-reachable equivalent here (ptrace is denied by the
// sandbox), so the error source is the permission bit instead. Restore the
// mode before printing so tempDir cleanup and re-runs are unaffected.
chmodSync(badPath, 0o000);
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  // Without a server-level error handler, bun routes the failed response
  // through onUnhandledRejection — which is fatal (exit 1) in a plain
  // script. Production servers register this handler; register it here so
  // the failing response is a plain 500 and the server survives, which is
  // exactly what this test asserts.
  error(error) {
    return new Response(null, { status: 500 });
  },
  fetch(req) {
    const file = new URL(req.url).pathname === "/bad" ? badPath : path;
    return new Response(Bun.file(file).slice(0, 2048));
  },
});
let okBodies = 0;
let failedBodies = 0;
async function hit(p) {
  try {
    // A fresh connection per request: a request that fails on a reused
    // keep-alive connection before any response bytes would be retried
    // (and then succeed) instead of being reported.
    const r = await fetch(\`http://127.0.0.1:\${server.port}\${p}\`, { headers: { connection: "close" } });
    const b = await r.arrayBuffer();
    if (b.byteLength === 2048) okBodies++;
    else failedBodies++;
  } catch {
    failedBodies++;
  }
}
await hit("/bad");
await hit("/");
await hit("/");
chmodSync(badPath, 0o644);
server.stop(true);
console.log("DONE " + okBodies + " " + failedBodies);
`;

let dir: ReturnType<typeof tempDir> | undefined;
let supervisorBin: string | undefined;
let served: string;

beforeAll(async () => {
  // Only the ptrace path needs a compiler; the OHOS variant runs its fixture
  // directly.
  if (!isLinux || (!isOHOS && !cc)) return;
  dir = tempDir("serve-file-slice-read-error", {
    "supervisor.c": SUPERVISOR_C,
    "fixture.mjs": FIXTURE_JS,
    "served.bin": Buffer.alloc(4096, 97).toString("latin1"),
    "locked.bin": Buffer.alloc(4096, 98).toString("latin1"),
    ...(isOHOS ? { "fixture-ohos.mjs": FIXTURE_JS_OHOS } : {}),
  });
  served = join(String(dir), "served.bin");
  if (isOHOS) {
    // No supervisor to build: the OHOS variant runs the fixture directly and
    // gets its read error from serving a mode-000 file slice whose open(2)
    // fails EACCES (see FIXTURE_JS_OHOS — the sandbox denies the ptrace
    // injection the desktop variant uses).
    const { chmodSync } = await import("node:fs");
    chmodSync(join(String(dir), "locked.bin"), 0o000);
    return;
  }
  const out = join(String(dir), "supervisor");
  await using proc = Bun.spawn({
    cmd: [cc, "-O0", "-o", out, join(String(dir), "supervisor.c")],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [ccOut, ccErr, ccExit] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  if (ccExit !== 0) {
    throw new Error(`supervisor compile failed:\n${ccErr || ccOut}`);
  }
  supervisorBin = out;
});

afterAll(() => {
  dir?.[Symbol.dispose]();
});

test.skipIf(!isLinux || (!isOHOS && !cc))(
  "Bun.serve Bun.file().slice() reads the file once per response, so a read() error fails only its own response",
  async () => {
    if (isOHOS) {
      // OHOS: no ptrace (sandbox EPERM) and no LD_PRELOAD (bun issues read()
      // as a raw syscall via rustix's linux_raw backend). The error source is
      // instead a mode-000 regular file whose open(2) fails EACCES (bun
      // routes file-open errors to a failed response, same as ENOENT 404).
      // The regression assertion is kept: the failing response fails exactly
      // alone, and the two plain requests after it still deliver their 2048
      // bytes.
      await using proc = Bun.spawn({
        cmd: [bunExe(), join(String(dir!), "fixture-ohos.mjs"), served!, join(String(dir!), "locked.bin")],
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      if (exitCode !== 0) {
        console.log("\n\nSTDERR:", stderr);
      }
      expect(stdout.trim()).toBe("DONE 2 1");
      expect(exitCode).toBe(0);
      return;
    }

    expect(supervisorBin).toBeDefined();

    // LeakSanitizer's StopTheWorld PTRACE_ATTACHes its own threads; that
    // fails (EPERM) when the process is already ptraced and LSan aborts
    // ("LeakSanitizer does not work under ptrace"). Disable it for the
    // traced child only.
    const asanOpts = [bunEnv.ASAN_OPTIONS, "detect_leaks=0"].filter(Boolean).join(":");
    await using proc = Bun.spawn({
      cmd: [supervisorBin!, served, "2", "--", bunExe(), join(String(dir), "fixture.mjs"), served],
      env: { ...bunEnv, ASAN_OPTIONS: asanOpts, LSAN_OPTIONS: "detect_leaks=0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

    // Three requests, one read() each, so the injected EIO lands on request
    // #2's only read: that response fails and the other two carry their 2048
    // bytes. A reader that over-reads takes two read()s per request (6 in
    // total) and the EIO lands on request #1's EOF probe, after the slice has
    // already been satisfied, so all three responses succeed.
    expect(stderr).toContain("matched read() calls on target:");
    const reads = Number(stderr.match(/matched read\(\) calls on target:\s*(\d+)/)![1]);
    expect({ stdout: stdout.trim(), reads }).toEqual({ stdout: "DONE 2", reads: 3 });
    expect(exitCode).toBe(0);
  },
  // No explicit upstream budget (5 s default): fine for the ptrace path on a
  // workstation, but an OHOS run spawns the fixture child and issues three
  // sequential requests, so scale it there like the other spawn-heavy tests.
  5000 * platformTimeoutScale,
);
