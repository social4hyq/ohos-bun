#!/bin/sh
# Export the OHOS delta (fork tip vs upstream tag) as one patch per file
# for the homebrew-core tap (Patches/bun@1.4/, mirroring the source tree).
#
# Method proven in docs/bun-upstream-feasibility.md §6 (v1.4.0 replay):
# per-file `git diff --no-renames --binary <tag> <tip> -- <path>` applied
# onto the tag reproduces the fork tree bit-exactly. Patch files carry an
# mbox-style one-line header (tap convention) generated here; hunks are
# never hand-edited. The replay at the end applies the series with
# `git apply --index` and requires the replayed tree to equal the fork
# tip bit-for-bit. git apply, not patch(1): toybox patch silently no-ops
# on new-file (/dev/null) diffs, and this series creates files.
#
# Usage: scripts/export-ohos-patches.sh <out-dir> [fork-tip] [upstream-tag]
#
# After a bun version bump: merge the new upstream tag into ohos-aarch64
# (Release SOP), re-run this script, refresh Patches/bun@1.4/ + the
# formula revision in one commit.
set -eu

OUT_DIR="${1:?usage: export-ohos-patches.sh <out-dir> [fork-tip] [upstream-tag]}"
FORK_TIP="${2:-3565953f0eaa7b437c20e0e287896eade1405a21}"
UPSTREAM_TAG="${3:-bun-v1.4.2}"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="${BUN_REPLAY_DIR:-/data/storage/el2/base/tmp/opencode/bun-patch-replay}"

# Fork-only paths that never enter the patch series (test infra, docs,
# fork CI), plus files proven unnecessary for the OHOS product build
# (cargo tests/, the cpu_model vendored shim that OHOS never compiles,
# the windows event-loop parity stub, and template/lockfiles nothing
# reads). The equivalence check at the bottom excludes the same set, so
# it still asserts the replayed tree equals the fork tip on every path
# the patch series covers.
GIT_EXCLUDES=":(exclude)test :(exclude)OHOS_TEST_STATUS.md :(exclude).github :(exclude).webkit-version :(exclude).gitignore :(exclude)scripts/ohos :(exclude)scripts/run-baseline.sh :(exclude)scripts/update-ohos-test-durations.mjs :(exclude)scripts/runner.node.mjs :(exclude)scripts/utils.mjs :(exclude)src/ohos_sign/tests :(exclude)scripts/build/shims/cpu_model :(exclude)src/io/windows_event_loop.rs :(exclude)packages/bun-plugin-svelte/bun.lock :(exclude)src/runtime/cli/init/react-shadcn/bun.lock :(exclude)src/runtime/cli/init/react-tailwind/bun.lock"

rm -rf "$SCRATCH"
git -C "$REPO" worktree add --detach "$SCRATCH" "$UPSTREAM_TAG" >/dev/null 2>&1
cleanup() { git -C "$REPO" worktree remove --force "$SCRATCH" >/dev/null 2>&1 || rm -rf "$SCRATCH"; }
trap cleanup EXIT

# 1. Export: one patch per changed file, path-mirrored under OUT_DIR.
#    Plain git diff output, no mbox headers — same format as the official
#    Patches/ files (e.g. Patches/openssh/auth.c.patch). OUT_DIR is
#    cleared first so stale files cannot survive a rerun.
mkdir -p "$OUT_DIR"
find "$OUT_DIR" -mindepth 1 -delete
git -C "$REPO" diff --name-only "$UPSTREAM_TAG" "$FORK_TIP" -- $GIT_EXCLUDES | while IFS= read -r f; do
  mkdir -p "$OUT_DIR/$(dirname "$f")"
  git -C "$REPO" diff --no-renames --binary "$UPSTREAM_TAG" "$FORK_TIP" -- "$f" > "$OUT_DIR/$f.patch"
done
COUNT=$(find "$OUT_DIR" -name '*.patch' | wc -l)
printf 'exported %s per-file patches\n' "$COUNT"

# 2. Replay, then prove equivalence against the fork tip. --index stages
# each patch: without it new files stay untracked and invisible to the
# final `git diff`.
find "$OUT_DIR" -name '*.patch' | sort | while IFS= read -r p; do
  git -C "$SCRATCH" apply --index --whitespace=nowarn "$p"
done
LEFT=$(git -C "$SCRATCH" diff --name-only "$FORK_TIP" -- $GIT_EXCLUDES | tee "$SCRATCH/.residual" | wc -l)
if [ "$LEFT" -ne 0 ]; then
  printf 'EQUIVALENCE FAILURE: %s files differ:\n' "$LEFT" >&2
  cat "$SCRATCH/.residual" >&2
  exit 1
fi
rm "$SCRATCH/.residual"
printf 'equivalence: replayed tree == fork tree (%s) outside excluded paths\n' "$FORK_TIP"
