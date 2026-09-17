# 交接手册：bun 1.4.2 鸿蒙适配 ohos-minimal 重做（Claude → Codex）

写于 2026-09-15 23:5x，Claude 额度耗尽前的交接。接手方：codex（通过 herdr 拉起）。

## 任务背景（一定要看完再动手）

总任务：在 fork `/storage/Users/currentUser/HarmonyPC/Software/ohos-bun` 的 `ohos-minimal` 分支上，从**干净的上游 `bun-v1.4.2` tag** 出发，重新做一遍鸿蒙（OpenHarmony/OHOS）适配——不是照抄 `Patches/bun/` 里现役 tap formula 用的 106 个老补丁，而是每遇到一个失败，先从根因出发自己设计最小修法，写完再对照老补丁交叉验证查漏。**老补丁只作参考，永远不照搬**——这是贯穿整个任务的最高优先级纪律，来自用户明确指令。

完整方案见 plan 文件：`/storage/Users/currentUser/.claude/plans/snoopy-moseying-walrus.md`（如果 codex 环境读不到这个路径，向用户要一份拷贝）。里面有完整的分阶段计划（Phase A 编译→B smoke→C 全量基线→D 真机长跑坑→E 登记发布）、最小化选层准则、四条反模式禁令。**开工前务必通读一遍**，本文档只是当前进度快照，不重复方案细节。

当前进度：Phase A/B/C 已基本跑通（见下方"当前状态"），主要在 Phase C/D 的收尾——挖真机测试失败、根因分析、最小修复或正确隔离。

## 关键约定（不遵守会直接犯错）

1. **构建走本机直构，不是 formula**（这是本任务明确批准的迭代期例外，见 plan 文件"迭代方式"一节；最终产物仍要走 formula）。构建目录 `build/ohos-minimal`；增量构建每次约 10-13 分钟（20 核）。
2. **测试用例可以改 npm 包版本/加 resolutions**——用户明确确认过这一点，不算"改测试绕 bug"。但**不能为了让测试通过而弱化断言逻辑本身**。
3. **不修改测试用例绕过真实 bug**：结构性/环境性问题走 `test/expectations.txt` 整文件隔离，或者如果只有单个 test 坏了、文件其余部分是好的，用 `it.skipIf(process.platform === "openharmony")`/`it.todoIf(...)` 之类的单测跳过（并写清楚原因注释）——**不要为了绕过一个真 bug 去改测试断言的期望值本身**。
4. **`test/expectations.txt` 文件顶部有清晰的使用规范**：整文件隔离条目会让整个文件的其余测试也不跑，只有"文件跑不起来"（挂起/崩溃/trips LeakSanitizer）才该整文件隔离；单个测试坏了就在文件内 skip 那一个测试。这次会话里刚纠正过一次这个错误（process.test.js 原本整文件隔离，实际只有 1/174 该跳过，已改成文件内 skipIf）。
5. **A/B 对照生产 bun**：`/storage/Users/currentUser/.harmonybrew/bin/bun`（symlink 进 Cellar，版本会随其他并发会话/自动化漂移，运行前 `bun --version` 确认）。用来区分"真回归"（生产过、dev 挂）vs"跨平台既有 bug"（两边都挂，本移植任务不用管）。
6. **grep 交替模式在本机不可靠**：`grep -E "a|b"` 偶尔假阴性返回空，即使加了 `-E`。任何"没找到"的结论先用单模式retry一次再下结论。
7. **TMPDIR**：每次 Bash 调用前先 `export TMPDIR=/data/storage/el2/base/tmp && export TMPPREFIX="$TMPDIR/zsh"`（commit/heredoc 用得到，否则报 read-only file system）。
8. **裸调用 `bun test`/`bun <file>` 缺环境变量陷阱**：需要 `BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING=1`、`BUN_GARBAGE_COLLECTOR_LEVEL=1`（`bun:internal-for-testing` 模块）、`--timeout=90000`（真实 CI runner 用这个值，裸测默认 5000ms 太短会产生假失败）。
9. **plain script 风格的 `node/test/parallel/*.js` 文件**（没有 `test()` 调用的）要用 `bun <path>` 直接跑，不能 `bun test <path>`（后者会假报"0 tests"）。
10. **zsh 变量名禁用 `status`**（只读变量，赋值静默失败终止脚本）。
11. **Bash 工具裸跑其实是 zsh**，bash 专属语法要 `bash -c '...'` 包一层。

## 本机直构环境变量（每次构建/跑 dev 二进制前必须 export）

```bash
export BUN_TOOLCHAIN_RUST=/storage/Users/currentUser/HarmonyPC/Software/ohos-bun/rust
export PATH="/storage/Users/currentUser/.harmonybrew/opt/lld@21/bin:/storage/Users/currentUser/.harmonybrew/opt/llvm@21/bin:$BUN_TOOLCHAIN_RUST/bin:$PATH"
export LD_LIBRARY_PATH="/storage/Users/currentUser/.harmonybrew/opt/openssl@3/lib:/storage/Users/currentUser/.harmonybrew/opt/icu4c@78/lib"
export SSL_CERT_FILE="/storage/Users/currentUser/.harmonybrew/etc/ca-certificates/cert.pem"
export CURL_CA_BUNDLE="$SSL_CERT_FILE"
export CARGO_HTTP_CAINFO="$SSL_CERT_FILE"
export TMPDIR=/data/storage/el2/base/tmp
```

构建命令（增量，~10-13 分钟）：
```bash
cd /storage/Users/currentUser/HarmonyPC/Software/ohos-bun
nohup ninja -C build/ohos-minimal bun-profile -j 20 > logs/rebuild-<描述>-$(date +%Y%m%d-%H%M%S).log 2>&1 &
```
**注意**：`nohup ... &` 会真正脱离父 shell，工具层面的"后台任务完成通知"如果是包在这个命令外层的 wrapper 脚本上，那个通知只代表 wrapper 脚本（几秒内）执行完、不代表 ninja 真的编译完。判断编译是否真的结束要 `ps -ef | grep ninja` 或轮询 `grep -E "Finished|error\[|error:" logs/xxx.log`，产物是 `build/ohos-minimal/bun-profile`（约 264MB）。

跑 dev 二进制：
```bash
export LD_LIBRARY_PATH="/storage/Users/currentUser/.harmonybrew/opt/openssl@3/lib:/storage/Users/currentUser/.harmonybrew/opt/icu4c@78/lib"
/storage/Users/currentUser/HarmonyPC/Software/ohos-bun/build/ohos-minimal/bun-profile <args>
```

真实 CI runner（更贴近实际门禁行为，比裸 `bun test` 准）：
```bash
export PATH="/storage/Users/currentUser/.harmonybrew/opt/lld@21/bin:$PATH"
export LD_LIBRARY_PATH="/storage/Users/currentUser/.harmonybrew/opt/openssl@3/lib:/storage/Users/currentUser/.harmonybrew/opt/icu4c@78/lib"
BUN="$(pwd)/build/ohos-minimal/bun-profile-wrapped.sh"
CI=true BUN_TEST_NO_SECRETS=1 node scripts/runner.node.mjs \
  --exec-path="$BUN" --ignore-expectations=OPENHARMONY \
  <test-file-path-without-test/-prefix>
```

## 当前状态（截至交接时刻）

分支 `ohos-minimal`，最近提交（新到旧）：
```
4b9cc8e899 test: narrow process.test.js quarantine to per-test skip
c2e7519d6a docs: record round 11 findings (env.rs OperatingSystem enum + StandaloneModuleGraph.rs regression)
7e3d589cbb fix: add OpenHarmony to bun_core::env.rs OperatingSystem enum
6cc2225d29 docs: round 10 TODO update - P2 list closed out, major self-correction documented
2d726ec490 test: quarantine create-jsx.test.ts's tailwindcss native binding gap
2005e423cd fix(test): wire community rspack-binding port; correct earlier rollup misdiagnosis
1035eebe02 docs: round 9 TODO update - Bun.Terminal/PTY fix summary
7c6e587e72 fix(pty): port 3 dropped OHOS Bun.Terminal/PTY fixes (openpty, epoll rearm, exit ordering)
```

**未提交的改动**（工作区里，与本任务无关，别动）：`packages/bun-plugin-svelte/bun.lock`、`scripts/ci-remap-server/bun.lock`、`test/harness.ts` 三个文件是本会话开始前就存在的未提交修改，不是这次工作产生的，不清楚来源（可能是构建脚本自动改的 lockfile，或者别的并发会话）。commit 前先 `git status`/`git diff` 确认不要意外带上。

`build/ohos-minimal/bun-profile` 当前是**最新状态**（包含上面全部 8 个 commit 的改动，最后一次成功构建验证过 `7e3d589cbb` 那批修复，之后 `c2e7519d6a`/`4b9cc8e899` 是纯文档/测试断言改动，没有 Rust 代码变化，**不需要重新构建**就能验证——但如果不确定，先 `git log -1 --format=%H` 对照，再决定要不要重编）。

### 完整的进度详情

`logs/todo-round-1-followup-20260915-121104.md` 是本会话累积的详细轮次记录（round 1 到 round 11），每轮记录了具体发现、根因、修法、验证结果。**这是最重要的进度文档，开工前通读一遍，尤其是最后几轮（round 9/10/11）**。

关键的、跨轮次的重要发现（也已写入跨会话记忆库，见下）：

1. **本仓至少有三个互相独立的 `OperatingSystem`-like 枚举**，每个都要单独接线 OHOS：
   - `src/install_types/resolver_hooks.rs`（npm install 期 os/cpu 匹配）——已修，commit `e914078f95`
   - `process.platform` 的直接消费者——已修（更早会话，见记忆 `project_ohos_bun_process_platform_fix`）
   - `src/bun_core/env.rs`（release URL / CompileTarget 体系）——刚修完，commit `7e3d589cbb`
   - 另外还发现一个**第四个、低优先级**的 `bun_analytics::OperatingSystem`（`src/analytics/lib.rs`，crash report/`/bun:info` 用）：**故意没修**，因为它是 `#[cfg(target_os=...)]` 门控的，OHOS 的 `target_os` 仍报 `linux`，所以它会静默落进 `Linux` 分支——不算错，只是不够精确（不会区分 OHOS/真 Linux），没有任何测试断言它，非功能性 bug，遵循最小化原则没有动它。**如果之后发现有测试依赖它区分平台，再回头处理**。
   - **下次 upstream tag merge（bun-v1.4.2 → 更新版本）如果引入第五个同构枚举，默认假设它也需要单独接线，不要以为"前几个都处理过了这个也该好了"**——`env.rs` 这次的教训就是：加变体后编译通过 ≠ 所有消费点都正确处理了新变体（`StandaloneModuleGraph.rs` 的一处 match 缺 OHOS 臂但没有触发穷尽性编译错误，机制原因未查明，纯靠真机冒烟测试发现的回归）。

2. **`bun install`（不带 `--force`/`--no-cache`）有一个非确定性的、跟平台无关的 bug**：resolve 阶段成功但 materialize 阶段偶发空转，0 个包落盘，不报错。生产 bun（无任何本会话改动）同样复现。排查"装包失败"类问题时，**先重跑 2-3 次排除这个可能性，别一上来就当逻辑 bug 深挖**——本会话为了追一个实际是这个假 bug 的"rollup os 匹配问题"多烧了一整轮调试。详见记忆 `environment_bun_install_flaky_materialize_noop`。

3. **Bun.Terminal/PTY 三处真实修复**（commit `7c6e587e72`）：openpty dlopen fallback 加 `libc.so`、epoll rearm watchdog（补 HongMeng 内核 EPOLL 边缘触发丢事件的坑）、`deferred_exit` 排序修正。大面积 PTY 测试失败降到零星 flaky（`bun-security-scanner-matrix-with-node-modules.test.ts` 51 pass/13 fail，残留问题见 `test/expectations.txt` 对应条目注释，未继续深挖）。

## 立即要做的下一步（被打断时正在做的事）

刚才在跑一批 bundler compile-target 相关测试（检查 `env.rs` 的 OperatingSystem 改动 + `StandaloneModuleGraph.rs` ELF 臂修复有没有引入新回归），后台命令是：

```bash
cd /storage/Users/currentUser/HarmonyPC/Software/ohos-bun && \
export LD_LIBRARY_PATH="/storage/Users/currentUser/.harmonybrew/opt/openssl@3/lib:/storage/Users/currentUser/.harmonybrew/opt/icu4c@78/lib" && \
export BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING=1 && \
export BUN_GARBAGE_COLLECTOR_LEVEL=1 && \
export TMPDIR=/data/storage/el2/base/tmp && \
BIN=/storage/Users/currentUser/HarmonyPC/Software/ohos-bun/build/ohos-minimal/bun-profile && \
"$BIN" test \
  test/bundler/bun-build-compile-sourcemap.test.ts \
  test/bundler/bun-build-compile.test.ts \
  test/bundler/bundler_compile.test.ts \
  test/bundler/bundler_compile_autoload.test.ts \
  test/bundler/bundler_compile_splitting.test.ts \
  test/bundler/compile-argv.test.ts \
  test/bundler/compile-sourcemap-internal.test.ts \
  test/bundler/compile-asset-bunfs.test.ts \
  test/bundler/compile-elf-segment-layout.test.ts \
  test/bundler/compile-node-compile-cache.test.ts \
  --timeout=90000
```

**这个跑丢了**——离开时进程（PID 61832）已经从 `ps -ef` 里消失，但输出文件是空的（0 字节），没能确认它是正常结束还是被杀/崩溃。**第一件事：重新跑一遍这批测试**，逐个看结果，尤其关注 `compile-elf-segment-layout.test.ts`（直接测 ELF 段布局，`StandaloneModuleGraph.rs` 改动最相关）。已知单独验证过 `bun build --compile hello.ts` 能正常跑（打印 "hi" 不是 help 文本），但这批完整测试套件还没跑完确认过。

已完成的验证（不用重复）：
- `process.test.js`：169 pass / 4 skip / 1 todo / 0 fail
- `bun build --compile hello.ts` 手动验证：正确运行，打印 "hi"
- `process.release.sourceUrl`：正确输出 `bun-openharmony-aarch64.zip`
- `sourcemap-simd.test.ts` ×6（spawn-waiter-thread 回归探针）：全过，无崩溃
- `bun-pm-why.test.ts`：28/28 全过

## 之后的方向（按标准指令"继续深挖"，没有用户提出新的具体要求）

1. 先确认上面那批 bundler compile 测试全过，如果有新失败，按方案里的"选对修复层"准则处理。
2. 跑完这批后，回到更大范围的基线扫描——检查 `test/expectations.txt` 里还有哪些条目值得重新审视（有些可能因为这次的 `env.rs`/Terminal 修复而已经变好，需要摘除或收窄；参考 round 10 对 `process.test.js`/PTY 类条目的处理方式）。
3. `docs/ohos-ports-pending-packages.md` 提到的候选包（rspack 已修，sharp/canvas/tsgo 待定）如果有余力可以按 CLAUDE.md 规则 4/5（先查上游原生适配，再查 `@ohos-ports`/`@ohos-npm-ports` 社区 port）逐个碰。
4. Phase D（"测试测不出但真机必需"那一类）目前还没有系统性跑过一遍——pipe-idle CPU 探针、`.node` 自签名回归、node 子进程 `os.userInfo()`（虽然记忆里说 r51+ 已修，但那是老 fork 的说法，这个新分支要重新验证一遍）——参考 plan 文件 Phase D 清单，逐项确认。
5. 每完成一批修复记得：commit（带 `Co-Authored-By`/`Claude-Session` 尾注，如果 codex 有自己的署名规范就用 codex 的）、更新 `logs/todo-round-1-followup-20260915-121104.md`（继续 round 12...）、更新跨会话记忆库（见下）。

## 跨会话记忆系统

路径：`/storage/Users/currentUser/.claude/projects/-storage-Users-currentUser-HarmonyPC-Workspace/memory/`，索引 `MEMORY.md`。**这是 Claude Code 专属的记忆系统，codex 大概率读不到/不会自动用**——如果 codex 环境没有对应机制，至少要把这次交接期间的新发现追加进 `logs/todo-round-1-followup-20260915-121104.md`（这个文件在 git 仓库里，任何 agent 都能读到），保证下一个接手的 agent（不管是 Claude 还是 codex）能看到。

如果 codex 恰好也能读这个路径（同一台机器、同一个用户），相关记忆文件：
- `project_ohos_bun_env_rs_operatingsystem_third_enum.md`——这次修的三个枚举里最新一个的完整细节
- `project_ohos_bun_terminal_pty_fixes.md`——PTY 三处修复
- `environment_bun_install_flaky_materialize_noop.md`——install 非确定性 bug
- `project_ohos_bun_npm_os_matching_fix.md`——os/cpu 匹配修复 + 之前的误诊纠正
- `feedback_redesign_dont_copy_old_patches.md`——最高优先级的协作纪律
- `feedback_dont_modify_tests.md`——测试修改边界

## 出问题找谁

用户偏好简体中文交流。这个任务是用户在 plan mode 里明确批准过的长期任务，遇到需要用户决策的分叉（比如"这个包到底要不要专门 port"这种范围性问题）可以问，但常规的"继续挖下一个失败"不需要每次确认——"继续深挖"是标准的、已经重复确认过很多次的指令。
