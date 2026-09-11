/* OHOS 内核行为探测器 — 用法:
 *   SDK=$HOME/.harmonybrew/opt/ohos-sdk
 *   $SDK/native/llvm/bin/aarch64-unknown-linux-ohos-clang -O1 -o probe ohos-probe.c
 *   binary-sign-tool sign -selfSign 1 -inFile probe -outFile probe.signed && ./probe.signed
 * 建议:裸内核(env -u LD_PRELOAD)与 LD_PRELOAD(libohos_compat.so) 各跑一遍对比。 */
/* OHOS kernel/OS behavior probe: verify each claimed deviation from
 * standard Linux semantics. Each test prints OK (standard) / DEV (deviant)
 * / ERR (unexpected failure). Build: aarch64-unknown-linux-ohos-clang. */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <time.h>
#include <pthread.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <pwd.h>
#include <netdb.h>
#include <poll.h>
#include <sys/eventfd.h>
#include <sched.h>

static void hdr(const char *name) { printf("== %s\n", name); }

/* 1. EPOLLONESHOT auto-clear: standard Linux re-arms after the event is
 * consumed; claimed OHOS deviation: stays disabled. */
static void t_oneshot(void) {
  hdr("epoll EPOLLONESHOT auto-clear (std: re-arms)");
  int p[2]; pipe(p);
  int ep = epoll_create1(0);
  struct epoll_event ev = {.events = EPOLLIN | EPOLLONESHOT, .data.fd = p[0]};
  epoll_ctl(ep, EPOLL_CTL_ADD, p[0], &ev);
  struct epoll_event out;
  write(p[1], "a", 1);
  int n1 = epoll_wait(ep, &out, 1, 200);
  write(p[1], "b", 1);
  int n2 = epoll_wait(ep, &out, 1, 200);
  printf("   first=%s second=%s -> %s\n",
         n1 == 1 ? "event" : n1 == 0 ? "timeout" : "err",
         n2 == 1 ? "event" : n2 == 0 ? "timeout" : "err",
         (n1 == 1 && n2 == 1) ? "OK standard" : "DEV oneshot-sticky");
  close(p[0]); close(p[1]); close(ep);
}

/* 2. dup pair + EPOLL_CTL_DEL on one copy: standard Linux — registration
 * is per open file description, DEL via any dup removes it for all.
 * The shim's skip_ctl_del claim: DEL is REQUIRED for correctness (not
 * that DEL is broken); probe the plain semantics for the record. */
static void t_dup_del(void) {
  hdr("dup pair: EPOLL_CTL_DEL via dup (std: removes for both)");
  int p[2]; pipe(p);
  int d = dup(p[0]);
  int ep = epoll_create1(0);
  struct epoll_event ev = {.events = EPOLLIN, .data.fd = p[0]};
  epoll_ctl(ep, EPOLL_CTL_ADD, p[0], &ev);
  struct epoll_event out;
  write(p[1], "a", 1);
  int n1 = epoll_wait(ep, &out, 1, 200);
  /* level-triggered: event still pending; DEL via the dup */
  int rd = epoll_ctl(ep, EPOLL_CTL_DEL, d, NULL);
  write(p[1], "b", 1);
  int n2 = epoll_wait(ep, &out, 1, 200);
  printf("   pre-del=%s del-via-dup=%s post-del=%s -> %s\n",
         n1 == 1 ? "event" : "none", rd == 0 ? "ok" : "err",
         n2 == 1 ? "STILL-REPORTS(broken)" : "silenced(ok)",
         n2 != 1 ? "OK standard" : "DEV del-not-honored");
  close(p[0]); close(p[1]); close(d); close(ep);
}

/* fork-guard: run fn in a child so SIGSYS/seccomp kills don't kill us. */
static void guarded(void (*fn)(void)) {
  pid_t pid = fork();
  if (pid == 0) { fn(); _exit(0); }
  int st = 0; waitpid(pid, &st, 0);
  if (WIFSIGNALED(st)) printf("   [child killed by signal %d]\n", WTERMSIG(st));
}

/* 3. openat2 availability (claimed SIGSYS under OHOS seccomp). */
static void t_openat2(void) {
  hdr("openat2 syscall (std: works or ENOSYS)");
  int fd = syscall(SYS_openat2, AT_FDCWD, "/proc/self/exe", O_RDONLY, 0, 0);
  if (fd >= 0) { printf("   ok -> OK standard\n"); close(fd); }
  else printf("   errno=%d (%s) -> %s\n", errno, strerror(errno),
              errno == ENOSYS ? "ENOSYS" : errno == EPERM ? "DEV seccomp-blocked" : "DEV other");
}

/* 4. pidfd_open availability (spawn_sys waiter-thread claim). */
static void t_pidfd(void) {
  hdr("pidfd_open (std: works or ENOSYS)");
  int fd = syscall(SYS_pidfd_open, getpid(), 0);
  if (fd >= 0) { printf("   ok -> OK standard\n"); close(fd); }
  else printf("   errno=%d -> %s\n", errno, errno == ENOSYS ? "ENOSYS" : "DEV unavailable");
}

/* 5. statx on socket fd (claimed EBADF on OHOS). */
#ifndef SYS_statx
#define SYS_statx 291
#endif
#ifndef AT_EMPTY_PATH
#define AT_EMPTY_PATH 0x1000
#endif
static void t_statx_sock(void) {
  hdr("statx on socket fd (std: works)");
  int s[2]; socketpair(AF_UNIX, SOCK_STREAM, 0, s);
  unsigned long long stx[32] = {0};
  long r = syscall(SYS_statx, s[0], "", AT_EMPTY_PATH, 0x7ff, stx);
  printf("   statx=%ld errno=%d -> %s\n", r, errno,
         r == 0 ? "OK standard" : "DEV failed");
  close(s[0]); close(s[1]);
}
static void t_statx_sock_g(void) { guarded(t_statx_sock); }

/* 6. /proc/<pid>/children (ParentDeathWatchdog fallback claim). */
static void t_proc_children(void) {
  hdr("/proc/self/children (std: exists with CONFIG_PROC_CHILDREN)");
  FILE *f = fopen("/proc/self/children", "r");
  if (f) { char buf[64] = {0}; size_t n = fread(buf, 1, 63, f);
           printf("   exists, read %zu bytes -> OK standard\n", n); fclose(f); }
  else printf("   errno=%d -> DEV missing\n", errno);
}

/* 7. getpwuid_r on own uid (no passwd db on OHOS?). */
static void t_pwuid(void) {
  hdr("getpwuid_r(getuid()) (std desktop: passwd entry)");
  struct passwd pw, *r = NULL; char buf[1024];
  int e = getpwuid_r(getuid(), &pw, buf, sizeof buf, &r);
  printf("   rc=%d entry=%s name=%s -> %s\n", e, r ? "yes" : "no",
         r ? pw.pw_name : "-", r && r->pw_name[0] ? "OK has-entry" : "DEV no-entry");
}

/* 8. link() vs linkat() (claimed EPERM on link, linkat works). */
static void t_link(void) {
  hdr("link() vs linkat() (std: both work)");
  const char *a = "/data/storage/el2/base/tmp/opencode/lk.a", *b = "/data/storage/el2/base/tmp/opencode/lk.b";
  FILE *f = fopen(a, "w"); fputc('x', f); fclose(f);
  unlink(b);
  int r1 = link(a, b);
  printf("   link=%d errno=%d\n", r1, r1 ? errno : 0);
  unlink(b);
  int r2 = linkat(AT_FDCWD, a, AT_FDCWD, b, 0);
  printf("   linkat=%d errno=%d -> %s\n", r2, r2 ? errno : 0,
         (r1 == 0 && r2 == 0) ? "OK both" : "DEV link-restricted");
  unlink(a); unlink(b);
}

/* 9. splice pipe->pipe (std: works). */
static void t_splice(void) {
  hdr("splice pipe->pipe (std: works)");
  int a[2], b[2]; pipe(a); pipe(b);
  write(a[1], "xyz", 3);
  long n = splice(a[0], NULL, b[1], NULL, 3, 0);
  printf("   moved=%ld errno=%d -> %s\n", n, n < 0 ? errno : 0,
         n == 3 ? "OK standard" : "DEV failed");
  close(a[0]); close(a[1]); close(b[0]); close(b[1]);
}

/* 10. resolv.conf presence + getaddrinfo (c-ares claim). */
static void t_resolv(void) {
  hdr("/etc/resolv.conf + getaddrinfo(localhost)");
  FILE *f = fopen("/etc/resolv.conf", "r");
  printf("   resolv.conf=%s\n", f ? "present" : "MISSING");
  if (f) fclose(f);
  struct addrinfo hint = {.ai_family = AF_INET}, *res = NULL;
  int rc = getaddrinfo("localhost", NULL, &hint, &res);
  printf("   getaddrinfo(localhost)=%d (%s) -> %s\n", rc, gai_strerror(rc),
         rc == 0 ? "OK" : "DEV failed");
  if (res) freeaddrinfo(res);
}

/* 11. tmpfile() (shim interposes it — /tmp absence claim). */
static void t_tmpfile(void) {
  hdr("tmpfile() (std: works)");
  FILE *f = tmpfile();
  printf("   %s -> %s\n", f ? "ok" : strerror(errno), f ? "OK standard" : "DEV failed");
  if (f) fclose(f);
}

/* 12. getcwd after rmdir of cwd (std: ENOENT). */
static void t_getcwd_rmdir(void) {
  hdr("getcwd after rmdir(cwd) (std: ENOENT)");
  const char *d = "/data/storage/el2/base/tmp/opencode/gone";
  mkdir(d, 0755); chdir(d); rmdir(d);
  char buf[256];
  char *g = getcwd(buf, sizeof buf);
  printf("   getcwd=%s errno=%d -> %s\n", g ? g : "NULL", errno,
         !g && errno == ENOENT ? "OK standard(ENOENT)" : "other");
  chdir("/data/storage/el2/base/tmp/opencode");
}

/* 13. memfd_create (std: works or ENOSYS). */
static void t_memfd(void) {
  hdr("memfd_create (std: works or ENOSYS)");
  int fd = syscall(SYS_memfd_create, "probe", 0);
  if (fd >= 0) { printf("   ok -> OK standard\n"); close(fd); }
  else printf("   errno=%d -> %s\n", errno, errno == ENOSYS ? "ENOSYS" : "DEV failed");
}

static void t_openat2_g(void) { guarded(t_openat2); }
static void t_pidfd_g(void) { guarded(t_pidfd); }
static void t_memfd_g(void) { guarded(t_memfd); }

/* 14. pidfd + epoll combination (spawn_sys waiter-thread claim:
 * "pidfd+epoll path hangs on device"). Correct test: child exits after
 * 200ms; parent epoll_waits on the child's pidfd — std: EPOLLIN on exit. */
static void t_pidfd_epoll_body(void) {
  int ep = epoll_create1(0);
  pid_t pid = fork();
  if (pid == 0) { usleep(200000); _exit(42); }
  int pfd = (int)syscall(SYS_pidfd_open, pid, 0);
  if (pfd < 0) { printf("   pidfd_open errno=%d, skip\n", errno); return; }
  struct epoll_event ev = {.events = EPOLLIN, .data.u64 = 0};
  int rc = epoll_ctl(ep, EPOLL_CTL_ADD, pfd, &ev);
  if (rc != 0) { printf("   epoll_ctl(pidfd) errno=%d -> DEV cannot-register\n", errno); return; }
  struct epoll_event out;
  int n = epoll_wait(ep, &out, 1, 1000);
  int exited = 0; waitpid(pid, &exited, 0);
  printf("   epoll_wait=%s (child exit captured=%d) -> %s\n",
         n == 1 ? "event" : n == 0 ? "TIMEOUT(hang)" : "err", WEXITSTATUS(exited),
         n == 1 ? "OK standard" : "DEV pidfd-epoll-hangs");
  close(pfd); close(ep);

}
static void t_pidfd_epoll(void) { guarded(t_pidfd_epoll_body); }

/* 15. linkat variants (fs.link fix uses which flags?). */
static void t_linkat_flags(void) {
  hdr("linkat with AT_SYMLINK_FOLLOW (fs.link path)");
  const char *a = "/data/storage/el2/base/tmp/opencode/lf.a", *b = "/data/storage/el2/base/tmp/opencode/lf.b";
  FILE *f = fopen(a, "w"); fputc('x', f); fclose(f);
  unlink(b);
  int r = linkat(AT_FDCWD, a, AT_FDCWD, b, AT_SYMLINK_FOLLOW);
  printf("   linkat(AT_SYMLINK_FOLLOW)=%d errno=%d -> %s\n", r, r ? errno : 0,
         r == 0 ? "OK works" : "DEV also-denied");
  unlink(a); unlink(b);
}

/* 16. ONESHOT on unix socket + eventfd (pipe 已验证标准)。 */
static void t_oneshot_sock_evt(void) {
  hdr("EPOLLONESHOT on unix socket + eventfd (std: re-arms)");
  int s[2]; socketpair(AF_UNIX, SOCK_STREAM, 0, s);
  int ep = epoll_create1(0);
  struct epoll_event ev = {.events = EPOLLIN | EPOLLONESHOT, .data.fd = s[0]};
  epoll_ctl(ep, EPOLL_CTL_ADD, s[0], &ev);
  struct epoll_event out;
  write(s[1], "a", 1);
  int n1 = epoll_wait(ep, &out, 1, 200);
  write(s[1], "b", 1);
  int n2 = epoll_wait(ep, &out, 1, 200);
  printf("   socket: first=%s second=%s\n", n1 == 1 ? "event" : "none", n2 == 1 ? "event" : "none");
  close(s[0]); close(s[1]); close(ep);
#ifdef SYS_eventfd2
  int efd = (int)syscall(SYS_eventfd2, 0, 0);
#else
  int efd = eventfd(0, 0);
#endif
  if (efd >= 0) {
    ep = epoll_create1(0);
    ev.events = EPOLLIN | EPOLLONESHOT; ev.data.fd = efd;
    epoll_ctl(ep, EPOLL_CTL_ADD, efd, &ev);
    unsigned long long one = 1;
    write(efd, &one, 8);
    int m1 = epoll_wait(ep, &out, 1, 200);
    write(efd, &one, 8);
    int m2 = epoll_wait(ep, &out, 1, 200);
    printf("   eventfd: first=%s second=%s -> %s\n", m1 == 1 ? "event" : "none",
           m2 == 1 ? "event" : "none",
           (m1 == 1 && m2 == 1) ? "OK standard" : "DEV oneshot-sticky");
    close(efd); close(ep);
  } else printf("   eventfd unavailable\n");
}

/* 17. pidfd+epoll spawn 压力:20 轮,统计 timeout。 */
static void t_pidfd_stress(void) {
  hdr("pidfd+epoll spawn x20 (std: 每轮退出事件)");
  int timeouts = 0, events = 0;
  for (int i = 0; i < 20; i++) {
    pid_t pid = fork();
    if (pid == 0) { usleep(10000 + (i % 5) * 5000); _exit(7); }
    int pfd = (int)syscall(SYS_pidfd_open, pid, 0);
    int ep = epoll_create1(0);
    struct epoll_event ev = {.events = EPOLLIN};
    epoll_ctl(ep, EPOLL_CTL_ADD, pfd, &ev);
    struct epoll_event out;
    int n = epoll_wait(ep, &out, 1, 2000);
    if (n == 1) events++; else timeouts++;
    close(pfd); close(ep);
    int st; waitpid(pid, &st, 0);
  }
  printf("   events=%d/20 timeouts=%d -> %s\n", events, timeouts,
         timeouts == 0 ? "OK standard" : "DEV pidfd-epoll-hangs");
}

/* 18. 多线程父进程 execve EAGAIN(c-bindings 重试的根因)。 */
static volatile int spinners_stop = 0;
static void *spinner(void *arg) {
  (void)arg;
  while (!spinners_stop) sched_yield();
  return NULL;
}
static void t_execve_eagain(void) {
  hdr("execve from 4-thread parent x100 (dlsym 重试的根因)");
  pthread_t th[4];
  for (int i = 0; i < 4; i++) pthread_create(&th[i], NULL, spinner, NULL);
  int eagain = 0, ok = 0, other = 0;
  char self[512];
  ssize_t n = readlink("/proc/self/exe", self, sizeof self - 1);
  self[n] = 0;
  for (int i = 0; i < 100; i++) {
    pid_t pid = fork();
    if (pid == 0) {
      char *argv[] = {self, "-x", NULL};
      execve(self, argv, NULL);
      _exit(errno == EAGAIN ? 91 : 90);
    }
    int st; waitpid(pid, &st, 0);
    if (WIFEXITED(st)) {
      int c = WEXITSTATUS(st);
      if (c == 0) ok++; else if (c == 91) eagain++; else other++;
    } else other++;
  }
  spinners_stop = 1;
  for (int i = 0; i < 4; i++) pthread_join(th[i], NULL);
  printf("   ok=%d eagain=%d other=%d -> %s\n", ok, eagain, other,
         eagain == 0 ? "OK no-eagain(bare)" : "DEV eagain-reproduced(重试必要)");
}

/* 19. poll() on pipe (std: POLLIN)。 */
static void t_poll_pipe(void) {
  hdr("poll() on pipe (std: POLLIN)");
  int p[2]; pipe(p);
  write(p[1], "a", 1);
  struct pollfd pf = {.fd = p[0], .events = POLLIN};
  int n = poll(&pf, 1, 200);
  printf("   poll=%s revents=%d -> %s\n", n == 1 ? "event" : "none", pf.revents,
         (n == 1 && (pf.revents & POLLIN)) ? "OK standard" : "DEV failed");
  close(p[0]); close(p[1]);
}

/* 20. 长 shebang 脚本 exec(spawn_process 的 128 字节读取是 bun 侧;内核限 256)。 */
static void t_shebang(void) {
  hdr("长 shebang 脚本 exec(解释器路径 ~180 字符)");
  char longpath[512] = "/data/storage/el2/base/tmp/opencode/dd/";
  mkdir("/data/storage/el2/base/tmp/opencode/dd", 0755);
  while (strlen(longpath) < 185) strcat(longpath, "d");
  mkdir(longpath, 0755);
  strcat(longpath, "/probe");
  unlink(longpath);
  if (symlink("/data/storage/el2/base/tmp/opencode/ohos-probe.signed", longpath) != 0) {
    printf("   建长路径失败 errno=%d\n", errno);
    return;
  }
  char scriptpath[512];
  snprintf(scriptpath, sizeof scriptpath, "/data/storage/el2/base/tmp/opencode/s.sh");
  FILE *f = fopen(scriptpath, "w");
  fprintf(f, "#!%s\n", longpath);
  fclose(f);
  chmod(scriptpath, 0755);
  pid_t pid = fork();
  if (pid == 0) {
    char *argv[] = {scriptpath, NULL};
    execve(scriptpath, argv, NULL);
    _exit(91);
  }
  int st; waitpid(pid, &st, 0);
  printf("   exec=%s -> %s\n", WIFEXITED(st) && WEXITSTATUS(st) == 0 ? "ok" : "fail",
         WIFEXITED(st) && WEXITSTATUS(st) == 0 ? "OK standard" : "DEV shebang-issue");
  unlink(scriptpath);
}

int main(int argc, char **argv) {
  if (argc > 1 && !strcmp(argv[1], "-x")) return 0; /* execve EAGAIN probe target */
  alarm(120); /* 防失控 */
  setvbuf(stdout, NULL, _IONBF, 0);
  t_oneshot(); t_oneshot_sock_evt(); t_dup_del(); t_openat2_g(); t_pidfd_g();
  t_statx_sock_g(); t_proc_children(); t_pwuid(); t_link(); t_splice();
  t_resolv(); t_tmpfile(); t_getcwd_rmdir(); t_memfd_g();
  t_pidfd_epoll(); t_linkat_flags(); t_pidfd_stress(); t_execve_eagain();
  t_poll_pipe(); t_shebang();
  printf("== done\n");
}
