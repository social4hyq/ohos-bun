#!/bin/sh
# 全量基线复跑 — r42 口径
# 用法：cd /storage/Users/currentUser/HarmonyPC/Software/ohos-bun && bash scripts/run-baseline.sh
# 产物：logs/baseline-$(date +%Y-%m-%d)/
set -u; set -o pipefail

export TMPDIR=/data/storage/el2/base/tmp
OUT="logs/baseline-$(date +%Y-%m-%d)"
BUN="$(brew --prefix bun)/bin/bun"
mkdir -p "$OUT/iso"

# 清理历史 vendored test 残骸（T06 教训）
rm -rf test/js/node/test/.tmp.* 2>/dev/null

run_batch() {
  name=$1; shift
  echo "=== $name $(date '+%H:%M:%S') ===" | tee -a "$OUT/SUMMARY.txt"
  CI=1 BUN_TEST_NO_SECRETS=1 node scripts/runner.node.mjs \
    --exec-path="$BUN" --ignore-expectations=OPENHARMONY --retries=1 \
    --results-json="$OUT/$name.json" "$@" \
    --exclude=integration/bun-types --exclude=internal/source-lints \
    > "$OUT/$name.log" 2>&1
  echo "=== $name $(date '+%H:%M:%S') exit=$? ===" | tee -a "$OUT/SUMMARY.txt"
}

echo "=== 基线开始 $(date) ===" | tee "$OUT/SUMMARY.txt"
echo "bun $(BUN=$BUN && $BUN --version)" | tee -a "$OUT/SUMMARY.txt"

run_batch B1 --include=js/bun --exclude=js/bun/terminal --exclude=js/bun/repl/repl
run_batch B2 --include=regression --include=napi --include=internal --include=v8 --include=config
run_batch B3 --include=cli --include=bundler --exclude=cli/install/bun-security-scanner-matrix-without-node-modules
run_batch B4 --include=js/web --include=js/third_party --include=js/first_party --include=js/sql --include=js/valkey --include=js/deno --include=snippets --include=runners --include=scripts --include=snapshots --include=js/junit-reporter --include=js/workerd --include=package-json-lint --exclude=js/valkey
run_batch B5 --include=js/node --exclude=js/node/test
run_batch B6 --include=js/node/test
run_batch B7 --include=integration

echo "=== ALL DONE $(date) ===" | tee -a "$OUT/SUMMARY.txt"

# 快速摘要
python3 -c "
import os, json, glob
outdir='$OUT'
for b in sorted(glob.glob(outdir+'/B?.json')):
    name=os.path.basename(b).replace('.json','')
    try:
        d=json.load(open(b))
        t=d.get('total',0); p=d.get('pass',0); f=d.get('fail',0)
        print(f'{name}: total={t} pass={p} fail={f} ({100*p/t:.1f}% pass)' if t else f'{name}: 无数据')
    except: print(f'{name}: json 解析失败')
" | tee -a "$OUT/SUMMARY.txt"
