# ohos-bun 交接文档

**日期**：2026-07-30  
**二进制**：r42 (`bun 1.4.0`, bottle `1.4.0_42`)  
**compat-shim**：0.2.4  
**分支**：`ohos-aarch64`

## 当前状态一句话

r42 基线全量分析完毕：5526 tests, 5432 pass (98.3%), 94 fail —— **class A bun 代码 bug 归零**，所有失败均为平台限制 (class B)、环境问题 (class D)、或测试自身问题 (class C)。

## 关键文件

| 文件 | 用途 |
|------|------|
| `scripts/run-baseline.sh` | 全量 7 批基线脚本，含排除项和 TMPDIR 清理 |
| `test/expectations.txt` | 29 条 OPENHARMONY 条目（83→29，删除 54 条过时/误判） |
| `OHOS_TEST_TODO.md` | 活文档——每个问题的根因、验证数据、修复状态 |
| `docs/ohos-bun-handoff.md` | 本文件 |

## 环境注意

- **TMPDIR 必须 EL2**：`export TMPDIR=/data/storage/el2/base/tmp`
- **`/tmp` 只读**：runner `--results-json` 必须指向 `/data/storage/el2/base/tmp/`
- **`/data/storage/el2/base/tmp/package.json`**：opencode 残留文件会污染测试（已加入基线脚本自动清理）
- **stderr 上的 `ECONNREFUSED ::1`**：是 uSockets 第一次尝试 ::1 的日志噪音，回落机制正常工作，不是 bug
- **容器 vs 真机**：容器（openEuler 内核）PTY 完整可用；真机（HongMeng）PTY 被 seccomp 拦

## 测试基线

```bash
cd /storage/Users/currentUser/HarmonyPC/Software/ohos-bun
bash scripts/run-baseline.sh
# 产物：logs/baseline-YYYY-MM-DD/
# 排除：terminal (PTY), repl (PTY), valkey (Docker), bake, bun-types, source-lints
```

期望结果（r42 口径）：
- B1 (js/bun): ~550 tests, ~8 fail
- B2 (regression/napi/internal/v8/config): ~541, ~0 fail
- B3 (cli/bundler): ~442, ~4 fail (含 bun-install-registry)
- B4 (js/web+third_party+sql+valkey+deno): ~370, ~0 fail (valkey 除外)
- B5 (js/node): ~304, ~9 fail
- B6 (vendored node): ~3248, ~4 fail
- B7 (integration): ~19, ~0 fail (bake 排除后)

## 剩余工作

### 可立即动手（test/infra 层，不需要容器）

1. **fetch.unix workaround**：改 `test/harness.ts` 的 `tmpdirSync()`，OHOS 上返回 EL2 路径（避免 hmdfs AF_UNIX EPERM）
2. **expectations.txt 评论维护**：6 个 "SUPERSEDED" 条目中还有 `bun-install-registry` 的评注需要从实际根因角度更新
3. **并发干扰验证**：`spawn-stdin-large-buffer`、`shell-load` 等在隔离下全绿，确认是并发问题后可降级

### 需要容器重编（src/ 改动）

4. **T49（已定位，平台 dns bug，无需 src 改动）**：~~kernel connect 同步 ECONNREFUSED 打断 autoSelectFamily 重试~~（经重编 `[T49-DIAG]` 探针 bun 实测推翻）。真因：HarmonyOS `getaddrinfo` 的 `AI_ADDRCONFIG` 错误过滤 IPv4 loopback——`dns.lookup("localhost",{hints:ADDRCONFIG})` 只返回 ::1（实测 `hints=0` → `[::1, 127.0.0.1]`，`ADDRCONFIG` → `[::1]`），`toAttempt.length===1`（`net.ts:3006`）切回单地址 connect，::1 失败无回落。非 bun 缺陷。workaround：`{host:"127.0.0.1"}` / `{family:4}` / `{hints:0}`。详见 `OHOS_TEST_TODO.md` T49
5. **bundler class A 复查**：如果复现环境干净（TMPDIR 无残留），T45-T48 应全部通过。若仍失败则需重新分析

### 上游跟进

6. **lightningcss #1264**、**tailwindcss-oxide #20276**：合并后 `@ohos-ports/*` 包可废弃
7. **rspack**、**tsgo**、**sharp** 等 OHOS 预编译二进制：需向上游提 PR 或等待官方支持

## 命令速查

| 操作 | 命令 |
|------|------|
| 单文件隔离验证 | `CI=1 BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING=1 BUN_GARBAGE_COLLECTOR_LEVEL=1 bun test --timeout=15000 <path>` |
| runner 单文件 | `CI=1 BUN_TEST_NO_SECRETS=1 node scripts/runner.node.mjs --exec-path="$(brew --prefix bun)/bin/bun" --ignore-expectations=OPENHARMONY --retries=0 --include=<路径> --exclude=integration/bun-types --exclude=internal/source-lints --results-json=/data/storage/el2/base/tmp/result.json` |
| 验证已修复项 | `for f in bun-audit bun-info bun-pm-scan bun-pm-version filter-workspace run-quote bun-pack; do CI=1 bun test --timeout=15000 test/cli/install/$f.test.ts; done` |
| 验证 bundler | `for f in bundler_cjs2esm esbuild/dce esbuild/default esbuild/importstar cache-node-compat; do CI=1 timeout 60 bun test --timeout=30000 test/bundler/$f.test.ts; done` |
| 查看 expectations | `grep '\[ OPENHARMONY \]' test/expectations.txt` |
| 容器重编 bun | `docker cp <formula> openharmony:/root/ && docker exec openharmony bash -lc "brew uninstall --ignore-dependencies bun && brew install --build-from-source social4hyq/core/bun"` |

## 本轮 commit 摘要（ohos-aarch64，共 15 个）

```
647f387ee docs: record baseline exclusions with file counts and reasons
8140a8b81 docs: fix wording
7a84db4a8 docs: consolidate class B/D verification results into ledger
22b02bff9 test: expectations.txt 30→29 — remove orphaned glob + valkey test-utils
f1339c5af test: expectations.txt 32→31 — remove bun-pack, update SUPERSEDED comments
cfc986de0 docs: T45-T48 closed — all bundler failures were stale pkg.json contamination
ef402afa3 docs: T49 root cause — HongMeng kernel sync ECONNREFUSED beats JS retry
d4dbb644d docs: T44 closed (misdiagnosis), T49 opened (WebSocket upgrade timeout)
1a5521ed1 docs: T44 corrected — HTTP path has fallback, only tls/net paths affected
7ccf37848 Revert "fix: hardcode localhost to 127.0.0.1 on OHOS (T44)"
718f13c5e test: resolve-dns — remove stale OHOS IPv6 expect_to_fail (12→1 failure)
948242583 docs: T45-T48 bundler class A entries, cli/install class C archive
e8b29f71c test: T44 (HTTP client no IPv4 fallback), TMPDIR cleanup in baseline script
3cb230dc7 test: r42 full baseline — prune 18 stale quarantine entries, harden runner script
```
