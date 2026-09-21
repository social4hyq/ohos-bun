#!/bin/sh
# Reap orphaned OHOS bun-test processes.
#
# Test infrastructure leaked as orphans (PPID 1) can outlive the run that
# spawned them when a test file is killed, times out, or crashes before its
# `afterAll` runs. On OHOS those orphans keep running: each orphaned verdaccio
# registry spins a core indefinitely, so a single bad run can wedge the box
# (see `test/harness.ts` VerdaccioRegistry.stop for the fixed normal path).
#
# This scans /proc for reparented test processes and terminates them. Run it
# standalone, or from a `trap ... EXIT` wrapper (scripts/run-baseline.sh).
#
# Usage: scripts/ohos/reap-test-procs.sh [--dry-run]
# Always exits 0: cleanup is best-effort and must never mask a test failure.
set -u

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
fi

SELF=$$

# Match only processes that are unambiguously test leftovers, so a stray
# reparented process is never killed. verdaccio only ever comes from the test
# registries; the `bun-profile install/patch/add` children are the test's own
# bun subprocesses (a running build's bun is a plain `bun`, not `bun-profile`).
matches() {
  case "$1" in
    *verdaccio*|*sleep-4ever*|*Bun.sleepSync*|*harness_start*|*bun-dev-test-*) return 0 ;;
  esac
  # A plain `bun install` is indistinguishable from a user's own install, so
  # only match bun children whose cmdline carries the tests' sandbox tmpdir
  # prefix — never a bare bin/bun + subcommand.
  case "$1" in
    *bun-dev-test-*bun*install*|*bun-dev-test-*bun*patch*|*bun-dev-test-*bun*add*) return 0 ;;
  esac
  return 1
}

reap() {
  signal=$1
  found=0
  for stat in /proc/[0-9]*/stat; do
    [ -r "$stat" ] || continue
    pid=${stat#/proc/}
    pid=${pid%/stat}
    [ "$pid" = "$SELF" ] && continue
    # /proc/<pid>/stat is `pid (comm) state ppid ...`; comm may contain spaces
    # or parentheses, so drop everything through the last ')' and read PPID
    # (field 3 of the remainder, i.e. field 2 after the cut).
    rest=$(sed 's/.*) //' "$stat" 2>/dev/null) || continue
    ppid=$(printf '%s\n' "$rest" | cut -d ' ' -f2)
    [ "$ppid" = "1" ] || continue
    cmd=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null) || continue
    [ -n "$cmd" ] || continue
    matches "$cmd" || continue
    found=1
    if [ "$DRY_RUN" = 1 ]; then
      printf 'would kill pid=%s: %s\n' "$pid" "$cmd"
    else
      printf 'reaping pid=%s: %s\n' "$pid" "$cmd"
      kill "-$signal" "$pid" 2>/dev/null || true
    fi
  done
  return 0
}

reap TERM
if [ "$DRY_RUN" = 1 ]; then
  exit 0
fi

# Killing a parent reparents its children to PID 1, so newly-orphaned children
# only become visible on the next pass.
sleep 2
reap TERM
sleep 1
# Anything that ignored SIGTERM.
reap KILL

exit 0
