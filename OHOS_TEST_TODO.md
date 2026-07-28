# OHOS 测试待办台账

本文件由 2026-07-26/27 的真机全量回归产生，替代此前依赖 `test/expectations.txt` 整文件 quarantine 的"通过率"统计。方法论、口径、`--ignore-expectations` 用法见 `OHOS_TEST_STATUS.md` 本轮追加条目。

**这是活文档**：每条从这里开始，修复后更新"状态"列并注明 commit；不要删行,只改状态（除非确认是误判要整行移除）。

## 分类图例

- **A** 真实 bun 缺陷（值得修）
- **B** OHOS 平台硬限制（不可修，需明确记录证据）
- **C** 测试自身问题（超时预算/路径假设/fixture 缺陷,可在 test/ 内修）
- **D** 缺外部服务/凭证/网络（不算 OHOS 限制，环境问题）
- **E** `expectations.txt` 里已有条目，本轮复核后确认依然成立（非陈旧）
- **F** 尚未深挖，只有失败现象,没有根因结论

层级：`test` / `scripts` / `rust` / `n/a`（第三方包或外部服务，不归我们改）

---

## 全量基线口径（`--ignore-expectations=OPENHARMONY`，2026-07-26）

| 批次 | Total | Pass | Fail | Flaky |
|---|---|---|---|---|
| B1 js/bun | 563 | 545 | 18 | 0 |
| B2 regression/napi/internal/v8/config | 541 | 530 | 11 | 0 |
| B3 cli/bundler | 442 | 421 | 19 | 2 |
| B4 web/third_party/sql/valkey/deno | 370 | 352 | 15 | 3 |
| B5 js/node(非vendored) | 304 | 294 | 9 | 1 |
| B6 js/node/test(vendored) | 3248 | 3220 | 28 | 0 |
| B7 integration/bake | 47 | 28 | 17 | 2 |
| **合计** | **5515** | **5390** | **117\*** | **8** |

\* 跨批次子串误命中去重后，唯一失败文件 123 个；对全部 123 个做 `--retries=0` 单文件隔离复测后，**118 个确认真实失败，5 个是并发/资源争抢导致的假阳性**（隔离后转过）：

```
test/js/node/module/sourcemap-simd.test.ts
test/js/valkey/reliability/connection-failures.test.ts
test/js/valkey/reliability/protocol-handling.test.ts
test/js/valkey/unit/list-operations.test.ts
test/js/web/fetch/fetch.tls.test.ts
```

下面的台账只覆盖这 **118 个确认失败**，按根因簇分组。原始数据：`logs/baseline-2026-07-26/`（各批 `b*.json`/`b*.log`，隔离复测 `iso/`，`iso/all-fail-evidence.tsv` 是逐文件 error+stdout 尾部的程序化提取）。

---

## T01 — EL2 沙盒下子进程 `getcwd()` 内核级失效；bun 没有像 shell 一样用 `$PWD` 兜底（已修复并真机验证）

**状态：已修复，2026-07-27 真机验证通过。** 两个 commit：
- `6a5df2ea5`（`src/runtime/api/bun/js_bun_spawn_bindings.rs`）——覆盖 `Bun.spawn`/`Bun.spawnSync` 公开 JS API。单独验证时发现**不够**：`bun pm pack`/`bun-publish`/`bun-run-bunfig` 等走的是 `PackageManagerLifecycle.rs`/`run_command.rs` 内部直接拼 `SpawnOptions` 的路径，完全绕过这个 JS binding，改完之后这批文件依然复现。
- `e39db04d6`（`src/jsc/bindings/bun-spawn.cpp`，`83409d5cd` 的修正版）——挪到所有 spawn 调用共用的最底层漏斗 `posix_spawn_bun`（chdir 之后、execve 之前），一次性覆盖所有调用点。**中间踩了一个自己的 bug**：`newEnvp` 数组最初声明在会在 `execve()` 之前就关闭的嵌套 `if` 块里，导致栈内存被后续的 `closeRangeOrLoop()` 覆盖，产生了一个新症状 `EFAULT: bad address in system call argument, posix_spawn`（真机复测抓到，简单的一次性 `Bun.spawnSync` 手测看不出来,因为中间调用栈太浅、内存还没被覆盖——`bun pm pack` 真实的生命周期脚本调用链更深,才暴露问题）。修正后（`newEnvp`/`pwdBuf` 提到和 `startChild()` 其余局部变量同级的外层作用域）真机复测：9 个受影响文件 + 2 个 install 步骤，**11/11 全部通过**，多次嵌套 spawn 压力测试也无 EFAULT。

以下是根因分析全过程（保留作记录，修复已落地不需要再验证一遍）：

**这不是噪音，根因已定位（2026-07-27，真机验证，多轮排除法）**：`environment_tmp.md`/`ohos_shell_init_getcwd.md` 里此前记的"纯噪音不影响功能"结论在本轮被推翻——`shell-init: error retrieving current directory: getcwd: cannot access parent directories: Permission denied` 这行噪音**混进了测试断言比对的实际输出**，导致多个原本应该通过的用例失败。

### 排除过程（每一步都用真机最小复现验证，逐条排除错误假设）

1. **不是 bun 特有逻辑的问题**：写了一个完全不依赖 bun 的最小 C 程序（`fork()` + `chdir(EL2路径)` + `execlp("bash",...)`），同样复现 `getcwd` 报错——证明这是 OHOS 平台本身的行为，不是 bun 的 `posix_spawn`/`vfork` 实现选择的问题（最初怀疑的 `src/spawn_sys/posix_spawn.rs` 里 `darwin_spawn_np::posix_spawn_file_actions_addchdir_np` 路径其实整个只在 `#[cfg(target_os = "macos")]` 下编译，OHOS 根本不会走到那段代码——这个假设被证伪了）。
2. **不是容器可复现的问题**：同样的复现脚本在 OpenHarmony 容器里完全正常（EL2 和 hmdfs 路径都没问题）——**只有真机的沙盒模型会触发**，容器测试永远发现不了这个 bug。
3. **不是 fork/vfork、不是 chdir 调用方式**：排除了"双重 chdir"、"`open`+`fchdir` 代替 `chdir(path)`"、"chdir 前先用其他 exec 建立身份再 chdir"、"chdir 后 sleep 500ms 等竞态"——全部无效,仍然复现。
4. **不是"chdir 是谁调用的"**：`process.chdir(EL2路径)` 后不带 `cwd` 参数直接 spawn（不 chdir，只 exec）→ 正常；同一个二进制先 chdir 再 `getcwd()`（还没 exec）→ 正常；**唯独"chdir 之后紧跟着 exec 到别的程序"** 这个序列会失败——无论中间插了几次 exec 都一样。
5. **真正的分水岭，也是修复方向**：`bash -c "cd <EL2路径> && pwd"`（bash 自己的 `cd` builtin,`pwd` 是 builtin 不 fork/exec）完全正常；`bash -c "cd <EL2路径> && exec bash -c pwd"`（bash 自己 `cd` 后再 exec 到一个全新进程）**同样失败**——但如果在 chdir 之后、exec 之前手动 `setenv("PWD", dir, 1)`，**整个链路就正常了**；反过来显式 `unsetenv("PWD")` 则必现失败。

### 结论

OHOS 真机上，一个 EL2 沙盒路径经过 `chdir()` 之后再 `exec()` 到任何其他程序，新程序自己调用内核 `getcwd()` 系统调用**本身就是坏的**（`EACCES: cannot access parent directories`）——这是 HarmonyOS 沙盒（大概率是 EL2 的 DAC/token 模型在 `execve()` 边界上对父目录遍历权限的重新计算有 bug）层面的限制，不是 bun 的错。**但** bash 之类的 shell 会先用 `stat($PWD)` 和 `stat(".")` 对比,如果一致就直接信任 `$PWD` 字符串,完全不必调用那个坏掉的 `getcwd()` 系统调用——这就是为什么 shell 自己 `cd` 从来没事。**bun 的 `Bun.spawn({cwd})` 只做了 `chdir()`，没有同步更新子进程环境里的 `PWD`**，子进程继承的是父进程的旧 `PWD`（对不上新 cwd），触发 shell 的 stat 校验失败,退回到那个坏掉的内核调用，于是复现。

### 修复方向（未动手，需要下一轮排期）

`Bun.spawn`/`Bun.spawnSync` 设置 `cwd` 选项时，同步把子进程环境里的 `PWD` 设成同一个值（和真实 shell `cd` 的行为对齐，属于通用正确性修复，不是 OHOS-only hack，其他平台也不会因此变差）。目前 `cwd` 在 `src/spawn_sys/spawn_process.rs:719`（`actions.chdir(&options.cwd)`）设置,但传入 `spawn_process_posix`（`spawn_process.rs:637`）的 `envp` 是调用方在更上层已经拍平成 C 数组的，需要往上找到 env 还是结构化 map/vec 的那一层（JS binding 把 `options.env`/`options.cwd` 转成 envp 的地方）,在那里"如果设置了 cwd 且 env 里没有显式覆盖 PWD,则注入/覆盖 PWD=cwd",而不是在 `spawn_process.rs`/`bun-spawn.cpp` 里事后拼接 C 数组（更容易出错）。改完要在容器里重编 bun bottle 验证,再用下面的真机最小复现回归。

### 真机最小复现（留档，改完直接照抄验证）

```c
// 复现：chdir 后 exec，PWD 没更新 —— getcwd 报 EACCES
if (chdir(dir) != 0) { perror("chdir"); return 1; }
execlp("bash", "bash", "-c", "pwd", (char*)NULL);
// stderr: "shell-init: error retrieving current directory: getcwd: cannot access parent directories: Permission denied"

// 修复验证：chdir 后同步设 PWD 再 exec —— 完全正常
if (chdir(dir) != 0) { perror("chdir"); return 1; }
setenv("PWD", dir, 1);
execlp("bash", "bash", "-c", "pwd", (char*)NULL);
// stdout: "<dir>\n"，无错误
```

这个 bug 影响面极大：本工作区约定所有测试 fixture 临时目录都建在 `TMPDIR=/data/storage/el2/base/tmp` 下（`environment_tmp.md`），而 `tempDir()`/`tempDirWithFiles()`（`test/harness.ts:435`）正是靠 `os.tmpdir()` 建目录——只要测试用 `cwd: someTmpDir` 的方式 spawn 子进程（几乎所有 cli/install 测试的标准写法），子进程内部再跑什么 shell 命令去读自己的 cwd（`pwd`、`process.cwd()`、shell 脚本的 `$PWD` 展开等）都会撞上这个问题。真实用户在这台设备上用 bun 跑任何"spawn 一个 shell 到 EL2 目录"的场景（不限于测试)都会踩到,修复价值不止于让测试变绿。

| 文件 | 具体断言 | 分类 | 层级 | 状态 |
|---|---|---|---|---|
| `test/cli/install/bun-pack.test.ts` | `$npm_command`/`$npm_lifecycle_event is accurate` | A | rust | **已修复**（e39db04d6，真机验证）|
| `test/cli/install/bun-publish.test.ts` | 同上（publish 变体）| A | rust | **已修复** |
| `test/cli/install/bun-workspaces.test.ts` | `$npm_package_config_ works in root`（x2）| A | rust | **已修复** |
| `test/cli/install/bun-install-lifecycle-scripts.test.ts` | `stdout/stderr is inherited from root scripts`（x2×2 attempt）| A | rust | **已修复** |
| `test/cli/install/bun-run-bunfig.test.ts` | `run.shell=system/default > run.silent=true`（3+）| A | rust | **已修复** |
| `test/cli/install/bun-run.test.ts` | `toStartWith('error: "bash" exited with code 200')` 一个子用例 | A | rust | **已修复**（此文件另有 4 个不相关子失败,见 T02，未受影响）|
| `test/cli/run/filter-workspace.test.ts` | `elides output by default`/`respects --elide-lines`（噪音行改变了行数统计）| A | rust | **已修复** |
| `test/regression/issue/24314.test.ts` | `bun pm pack respects changes...from prepack/prepare scripts`（stderr 断言 not.toContain("error")）| A | rust | **已修复** |
| `test/regression/issue/10132.test.ts` | `bun run sets cwd for script, matching npm`（`pwd` 输出被污染）| A | rust | **已修复** |

（根因分析、排除过程、最小复现见上面；修复实现见 `e39db04d6`。上一轮全量基线（2026-07-26）跑的是旧二进制，这批文件的通过率会在下一次全量重跑里反映到数字上。）

---

## T02 — `bun run` 退出码/信号语义边缘用例（未深挖，与 T01 同文件不同断言）

| 文件 | 具体断言 | 分类 | 层级 | 状态 |
|---|---|---|---|---|
| `test/cli/install/bun-run.test.ts` | `invalid tsconfig.json is ignored`（x2 不同 describe 路径）、`exit code message works above 128`、`--silent > exit signal works` | F | rust? | 待查 |

---

## T03 — PTY / TTY 簇：两个独立根因，均已修复（`738701916` raw mode + `4c3bee75b` exit 回调竞争）

`terminal-*.test.ts` 是全新文件（历史 `OHOS_TEST_STATUS.md` 里从未出现过 `Bun.Terminal` 相关记录），说明这是本轮首次覆盖到。核心症状：`setRawMode` 抛 `Failed to set raw mode`,以及依赖 raw mode/SIGWINCH/作业控制信号的场景全部超时。`no-orphans.test.ts`/`tty-reopen-after-stdin-eof`/`tui-app-tty-pattern`/`18239` 症状不同但都在 TTY/PTY 子系统,怀疑共享底层 termios/PTY 分配逻辑,值得一起排查。

| 文件 | 症状 | 分类 | 层级 | 状态 |
|---|---|---|---|---|
| `test/js/bun/terminal/terminal.test.ts` | `setRawMode` can enable/disable/toggle 全部抛 `Failed to set raw mode` | A | rust | **已修**（T03a `738701916`）；文件剩 2 个审计摇摆用例 |
| `test/js/bun/terminal/terminal-spawn.test.ts` | 同样 `Failed to set raw mode`；`exit callback fires after close`/`pipeline producer exit...`超时或挂 | A | rust | **已修**（T03a + T03b `4c3bee75b`）|
| `test/js/bun/terminal/terminal-platform-gaps.test.ts` | `setRawMode is a no-op on Windows` 断言在这台机器上抛错（预期不抛）；`SIGWINCH`/CRLF 用例 90s 超时 | A | rust | **已修**（T03a）|
| `test/regression/issue/18239/18239.test.ts` | `TTY stdin buffering should work correctly` | A | rust | 待复测（T03a/b 后是否顺带转绿）|
| `test/regression/issue/tty-reopen-after-stdin-eof.test.ts` | 2 个子用例：reopen `/dev/tty`、`position` for char devices | — | — | **实测已通过**，移出 T03 簇 |
| `test/regression/issue/tui-app-tty-pattern.test.ts` | 读 piped stdin 后 reopen `/dev/tty` | — | — | **实测已通过**，移出 T03 簇 |
| `test/cli/run/no-orphans.test.ts` | Ctrl-Z stop 桥接 + `setsid` 场景 30s 超时（历史记录过 tpgid=0 异常,本轮换了新症状）| A | rust | 待复测（T03a/b 后是否顺带转绿）|

### 根因已定位：OHOS 拒绝在 PTY **master** 上做「排空/冲刷」型 `tcsetattr`（`738701916` 已修，验证中）

按上面"建议"做了独立 C 探针（完全脱离 bun），结论非常干净：

| fd 类型 | `TCSANOW` | `TCSADRAIN` | `TCSAFLUSH` |
|---|---|---|---|
| **PTY master** | ✅ rc=0 | ❌ `EACCES` | ❌ `EACCES` |
| PTY slave | ✅ | ✅ | ✅ |

**同一个 master fd 上 `TCSANOW` 完全成功**，且回读确认新 termios 真的生效（`ICANON=0`/`ECHO=0`）。所以不是"OHOS 不让配置 master"，而是**专门卡住了 drain/flush 那一步**——推测沙箱拦的是这两个变体内部发的 `TCSBRK`/`TIOCDRAIN` ioctl。

`ttySetMode()`（`src/jsc/bindings/wtf-bindings.cpp`，libuv `uv_tty_set_mode` 的移植）硬编码 `TCSADRAIN`，而 `Bun.Terminal` 正是拿 PTY master 调进来的 —— 于是真机上每一次 `setRawMode()` 必抛 `Failed to set raw mode`。

**修复**：只在 `TCSADRAIN` 返回 `EACCES` 时回退到 `TCSANOW`，而不是直接改成 `TCSANOW`——内核允许的地方保留 drain-then-apply 语义，只在本来就会彻底失败的 fd 上放弃它。代价是待发送输出可能被新设置重新解释，相比 `setRawMode` 完全不可用是划算的，而且这就是这个平台的 PTY master 唯一允许的做法。限定 `__OHOS__`，不动其他平台。

### 验证结果（`738701916`）：setRawMode 彻底修好，但暴露出**第二个独立根因**

直接命中核心症状的最小脚本：修复前 `RESULT: FAIL -> Failed to set raw mode`，修复后 `setRawMode(true)/(false)/toggle` **三次全部 OK**。

10 文件回归的用例级对比：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| `Failed to set raw mode` 出现次数 | 7 | **0** |
| 失败用例总数 | 13 | 11 |
| 转绿的用例 | — | **9 个**（4 个 setRawMode 子用例 + `drain fires when a second write flushes…` + `GAP: setRawMode is a no-op on Windows` + `SAME: output LF is translated to CRLF` + `write returns the full input length when the PTY buffer fills` + `.editor mode collects lines until Ctrl+D`）|
| 新跑到并失败的用例 | — | 7 个 |

**文件级数字（4 通过 / 6 失败）前后完全一样，但这是假象**：底下换了一整批。那 7 个"新失败"经核查在基线日志里**一次都没出现过**（`grep -c` = 0）——修复前它们根本没被执行到（前面的 `setRawMode` 抛错把文件后续用例挡住了），所以**不是回归，是新暴露的覆盖面**。

### T03 剩余部分：第二个根因（PTY 数据不流动，待查）

新暴露出来的失败集中在一个清晰的症状群：**PTY 里数据根本不流动**——

- `data callback > receives echoed output` —— 收不到回显
- `exit callback is called on close` —— 90s 超时（回调永不触发）
- `Bun.spawn with terminal option > creates subprocess with terminal attached` —— 90s 超时
- `subprocess sees correct terminal dimensions`、`SIGWINCH in child`
- REPL 三个用例（`error shows in terminal` / `multiline input with open brace` / `backspace deletes a whole multi-byte character`）—— REPL 完全依赖 PTY 收发
- `18239` TTY stdin buffering、`no-orphans` 的 Ctrl-Z/setsid

`setRawMode` 只是"能不能配置 termios"，这一批是"配置好之后数据能不能过去"，是**两个独立的问题**。

**已用独立 C 探针排除平台限制** —— 操作系统层面这台设备的 PTY 完全正常：

```
ioctl(master, TIOCSWINSZ) = 0        ioctl(master, TIOCGWINSZ) = 0  rows=24 cols=80
write(master) -> poll(slave)  = POLLIN,  read(slave)  = 18 字节，内容完整
write(slave)  -> poll(master) = POLLIN,  read(master) = 37 字节（含内核回显）
close(slave)  -> poll(master) = 0x10 (POLLHUP)
```

回显、窗口大小 ioctl、EOF/HUP 通知——失败用例依赖的每一条 PTY 能力都验证可用。平台限制（class B）排除。

**继续深挖后又推翻了一次自己的判断**（先记为 class A"bun 缺陷"，实测证明是 class C"测试预算"）：

| 条件 | 结果 |
|---|---|
| OS 层 PTY（独立 C 探针） | 完全正常 |
| `bun test` 整文件，**不带** runner 的注入变量 | **95 pass / 1 fail**（只 `handles Unicode characters` 挂）|
| 单独跑 `-t "receives echoed output"` | **通过** |
| 最小脚本，审计 ON，只等 100ms | **通过**（7 字节 `"hello\r\n"`）|
| 整文件 + `BUN_JSC_randomIntegrityAuditRate=1.0` | **精确复现 runner 报的那两个失败** |

决定性变量是 `scripts/runner.node.mjs::spawnBun()` 注入的 **`BUN_JSC_randomIntegrityAuditRate: "1.0"`**（100% 概率跑 JSC 完整性审计，代价极高，且**开销随堆大小增长**）。单独跑没事，跑到 96 个用例的大文件后半段时堆已经很大，单次审计慢到把测试里写死的 `Bun.sleep(100)` 撑爆。

**所以这一批的正确归类是 class C（测试自身预算），不是 bun 运行时缺陷。** 注意这不等于"方法学错误、可以忽略"——真实 CI 同样设这个变量，所以在 CI 上它们确实会失败；只是根因在"固定 100ms 预算对这个平台 + 审计开销不够"，而不是 PTY 功能坏了。

**试过超时倍数，实测无效，已撤销**。按 `hot.test.ts` 先例给 12 处等 PTY 数据的 `Bun.sleep` 加了 6x OHOS 倍数，A/B 各跑 4 遍：

| | run1 | run2 | run3 | run4 | 均值 |
|---|---|---|---|---|---|
| 带倍数 | 94/2 | 94/2 | 91/5 | 94/2 | ~93.2 pass |
| 原版 | 94/2 | 92/4 | 93/3 | 93/3 | ~93.0 pass |

差异完全落在噪声内，且**失败项每次都在换**（`receives echoed output` / `can write ANSI color codes` / `creates subprocess with terminal attached` / `handles Unicode characters` 轮流出现）。所以"等待预算不够"这个解释本身也不完整——真实情况是这批用例在审计开销下整体变成了**摇摆**，不是差那几十毫秒。既然没证明收益，改动已撤销，不往上游测试文件里加无效 churn。

**另有一个不是时序的真实问题**：`exit callback is called on close` 用的是 `await promise`（无固定 sleep），把测试超时放宽到 30s 仍然跑满 30s 不触发。单独跑是 0ms 立即触发；先造 N 个 Terminal 再测则**间歇性**丢失（N=30 四次里三次 OK 一次超时，非单调，排除资源耗尽）。GC 假设也已证伪（显式丢引用 + 强制 `Bun.gc(true)` 后回调照常触发）。这是 exit 回调投递路径上的一个偶发竞争 —— **已定位并修复，见下节 T03b**。

### T03b 根因已定位并修复：exit 通知在 `init_terminal` 期间触发就被永久丢弃（`4c3bee75b`）

**定位过程中先推翻了自己的一个结论。** 最初用 `grep "call_exit_callback" | tail -1` 看日志，读到 `DROP at try_get`，据此判断"JS wrapper 已经没了"，并提出 `js::to_js` 在 GC 压力下返回空值的假设。**这是错的** —— `tail -1` 取到的是**上一个** terminal 的记录。改成给每条日志打上 `T@<地址>` 标签、按地址分组之后，真实的生命周期才显出来：

```
T@5b2f182bc0 on_reader_finished(exit_code=1) finalized=false jsref=Weak(empty) READER_DONE=false
T@5b2f182bc0 call_exit_callback: DROP at try_get
T@5b2f182bc0 init: callbacks registered, calling read()      ← 注意顺序
T@5b2f182bc0 on_reader_finished(exit_code=1) ... READER_DONE=true
T@5b2f182bc0   -> EARLY RETURN (READER_DONE already set)
```

第一行出现在 `init: callbacks registered` **之前**：reader 在 `init_terminal` 还没建出 JS wrapper 时就已经以 `exit_code=1`（错误路径）完成了。此时 `this_value` 是空的 → `try_get()` 返回 `None` → 回调被静默丢弃；而 `on_reader_finished` 会置 `READER_DONE`，**这条路径是一次性的**，后面真正的 exit 通知全部走 EARLY RETURN。用户的 `exit` 回调于是永远不会触发。`jsref=Weak(empty)` 也顺带证伪了之前的 GC 假设：不是 wrapper 被回收，是它**还没被创建**。

**第一次修复不完整，被自己的数据打回。** 把 `terminal.reader.with_mut(|r| r.read())` 从 wrapper 创建之前挪到回调注册之后，复现率从 ~50% 降到 25% —— 降了但没归零，说明触发源不止 `read()`。实际是更早的 `reader.start()`（~line 550）。

**改用第二种思路：不抢时序，改成不丢通知。** 继续往前挪初始化要穿过 `writer.start()`/`reader.start()` 两条失败清理路径，风险高且仍然是在赌窗口位置。改为加一个 `deferred_exit: Cell<Option<i32>>`：`on_reader_finished` 发现 wrapper 未就绪时把 exit code 暂存，`init_terminal` 末尾统一回放。这样天然覆盖 `writer.start()` / `reader.start()` / `read()` **全部三个同步完成源**，不依赖"窗口到底在哪"这个判断。

验证（全部带 `BUN_JSC_randomIntegrityAuditRate=1.0`）：

| 场景 | 结果 |
|---|---|
| 最小复现 ×16 | **16/16 通过**（修复前 ~50% 超时，第一次修复后 25%）|
| 前置 N=30 / N=60 / N=100 个 terminal，各 ×8 | **24/24 通过** |
| `exit callback` 整组 | 4 pass / 0 fail |
| `exit callback is called on close`（原先跑满 30s）×5 | **5/5 通过** |
| `terminal.test.ts` 整文件 | 94 pass / 2 fail，剩余是无关的 `handles Unicode characters` 摇摆 |

分类应从 class C 改回 **class A（真实 bun 缺陷）**，且**不是 OHOS 特有** —— 这段代码是全平台共享的，OHOS 只是通过审计开销把窗口放大到了必现级别。

**收尾踩的坑（记下来防止再犯）**：移除插桩的 commit `7b260119a` 把紧邻插桩块的 `pub mod js { ... }` 一起删了 —— 那是原有的 generated bindings re-export，不是插桩，只是位置挨着。16 个 `cannot find module js` 编译错误，浪费一轮 18min 构建。`4baab5bcb` 恢复。**教训**：声称"diff 是纯删除"不够，还要确认删除的**每一段**都属于插桩本身；`git diff <修复commit> -- <文件> | grep "^+"` 应为空是必要条件而非充分条件。

**干净版复验（`7f42ebc2d`，插桩全部移除）**：`terminal.test.ts` **94 pass / 2 fail**，与插桩版逐数字一致；`exit callback` 组连跑 5 次 **5×(4 pass / 0 fail)**。移除插桩没有影响修复。

**结论**：T03 拆成两个独立根因，**两个都已真修** —— T03a raw mode（`738701916`，OHOS 平台特有）、T03b exit 回调竞争（`4c3bee75b`，上游共享缺陷）。剩下的 `handles Unicode characters` 等属于前面记录的"审计开销下整体摇摆"，是 class C 且已证明不是调预算能解决的。

### T03 簇余下三个文件的归宿（逐个查清，两个转出 T03、一个成为新根因）

| 文件 | 实际根因 | 与 PTY 有关？ | 归宿 |
|---|---|---|---|
| `18239.test.ts` | fixture `data-generator.sh` shebang 硬编码 `#!/bin/bash`，本机 bash 在 `/data/service/hnp/bin/bash` | 无关 | **已修**（`7f42ebc2d`，改 `#!/usr/bin/env bash`），0 pass/1 fail → **1 pass/0 fail** |
| `no-orphans.test.ts` 的 Ctrl-Z 用例 | 测试靠 `/proc/<pid>/stat` 的 `tty_nr`/`tpgid`/`state` 三个字段判断作业控制，OHOS procfs 这三个字段全不可用 | 无关 | **class C**（观测手段不可移植），详见下方 T25 |
| `no-orphans.test.ts` 的 setsid daemon 用例 | bun 的后代枚举依赖 `CONFIG_PROC_CHILDREN`，OHOS 内核没开 → `--no-orphans` 整个特性静默失效 | 无关 | **class A 新根因**，详见下方 T26 |

三个都跟 PTY 没关系 —— 当初归进 T03 是因为症状（TTY/超时）像，不是因为查过根因。

---

## 台账自查（07-28）：把"待查/待修"逐条隔离复测

T07 被撤回后做了一次系统复核 —— 台账里所有仍标"待查/待修"且带具体文件的条目，用最新二进制逐个**单文件隔离**复跑，通过的再拿基线 `3e233644d` 对照，区分"被本轮修好"和"从来就没坏"：

| 文件 | 最新 | 基线 | 判定 |
|---|---|---|---|
| `test-cluster-bind-privileged-port.js` | 0 fail | 0 fail | **撤回**（T07）|
| `test-cluster-shared-handle-bind-privileged-port.js` | 0 fail | 0 fail | **撤回**（T07）|
| `test-dgram-bind-fd.js` | 0 fail | 0 fail | **撤回**（T08）|
| `test-dgram-socket-buffer-size.js` | 0 fail | 0 fail | **撤回**（T08）|
| `cli/install/bun-run.test.ts` | 0 fail | **1 fail** | **真修复** —— T01 版即通过 → getcwd/`$PWD` 兜底的连带受益 |
| `test/js/node/test/sequential/test-fs-watch.js` | 1 fail | — | 仍失败（T05 `fs.watch(recursive)`，class B 已知）|
| `test/js/node/watch/fs.watch.test.ts` | 1 fail | — | 同上 |
| `test/js/bun/net/unix-socket-long-path.test.ts` | 1 fail | — | 仍失败（T15）|

`bake/dev/*` 11 个文件跳过：T18 已有结论（feature flag 能开但功能性失败，需产品级决策），且每个都会跑满超时，复测无信息量。

**教训**：本轮方案 Step 2 明确写了"每个失败文件单独跑一次 `--retries=0`，隔离下仍失败的才进台账"，但 T07/T08 是直接从全量批跑的失败清单誊进来的。四个条目里有四个是并发假象，这个比例说明批跑失败清单**不能**当作缺陷清单用。后续新增条目一律先隔离复测再写入，且"通过"要给重复次数。

---

## T31 — T21 长尾深挖：三项收口（两个测试假设 + 一个 fork 有意差异）

T21 复核确认 13 项里 10 项是稳定真失败后，逐个深挖。前三项都不是 bun 缺陷，但成因各不相同：

### `filesink.test.ts` — 硬编码的 socket 缓冲假设（已修）

`end() after a backpressured write() with the reader drained` 断在**第一行** `expect(writePromise).toBeInstanceOf(Promise)`，收到的是 `307200`——写入压根没 backpressure，300KB 一次写完了。

测试注释假设 "Linux default ~200KB"，但 AF_UNIX 缓冲不是常数：

| | 本机 HarmonyOS | OpenHarmony 容器 |
|---|---|---|
| `SO_SNDBUF` | **524288（512KB）** | 229376（224KB）|
| 实测可灌入 | 512KB | 228KB |
| 300KB 写入 | **不 backpressure** ❌ | backpressure ✅ |

于是测试在本机连它要覆盖的那个 orphan-promise bug 都没走到就挂了。写入量必须落在**一到两个缓冲之间**（超过容量才 backpressure，剩余又要小到能被一次 flush 清空），所以改成先量再取 1.5 倍。fd 本来就是非阻塞的（测试自己的 drain 循环就依赖 `readSync` 抛异常而非阻塞），灌到 `writeSync` 报 EAGAIN 就是容量。

两种缓冲下都验证过：512KB→768KB、228KB→349KB，`write()` 均正确 backpressure。**50 pass / 0 fail，3/3 稳定**，基线二进制同样通过。

### `resolver-permission-denied-ancestor.test.ts` — 我们自己 fork 的有意差异（已 skip）

`errors on the requested directory itself stay fatal` 期望 execute-only 的 cwd 让 `bun run` 以 `error loading current directory` 致命退出；本机报的是 `Script not found "start"`。

**这是有意的**：`run_command.rs` 有 `#[cfg(target_env = "ohos")]` 分支，读不到当前目录时回退到 `$HOME`（或 `/`）的 root DirInfo 而不是中止——因为 OHOS 上 SELinux 可能挡住某些挂载点的 `getcwd`/`openat`，一律致命会让 bun 在正常场景里直接不可用。`36dbc7630` 特意把这个 fallback 从"影响所有平台"收窄到只在 OHOS 生效，就是为了让其他平台保留本用例断言的致命行为。

平台本身没问题——C 探针确认 0o111 目录语义完全正确（`chdir` 成功、`opendir` EACCES、按已知文件名 `open` 成功）。同文件的兄弟用例（不可读**祖先**目录下 `bun run` 仍要能工作，正是该 fallback 要保护的那一半）照常通过。

已降级为带根因的文件内 skip，1 fail → **1 pass / 1 skip**。

### 追查：这个 fallback 本身是错的（已修 `ada86391d`）

上一段把它当成"合理的平台适配 + 一个静默的小瑕疵"。**深究之后这个判断不成立** —— 它不是"少报了一条提示"，而是**静默换了一个项目在跑**。

拿 `HOME` 指向 fixture 实测（工作目录不可读，但它自己的 `package.json` 里**确实定义了** `start`）：

```
$ cd unreadable-project && bun run start
$ echo LEAKED-FROM-HOME                       ← 跑的是 $HOME 的 start
name=HOME-PACKAGE ver=9.9.9 cfg=home-config-value
PATH-HEAD=/…/fakehome/node_modules/.bin:/…/fakehome/node_modules/.bin
command -v probe-bin -> /…/fakehome/node_modules/.bin/probe-bin
```

三层后果，全部无任何提示：

| 后果 | 说明 |
|---|---|
| **执行错误的脚本** | 用户在项目里敲 `bun run start`，跑的是 home 目录的同名脚本 |
| **身份冒充** | `npm_package_name`/`version`/`config_*` 全来自 $HOME 的 package.json，`config` 段整段泄漏进环境变量 |
| **PATH 劫持** | `$HOME/node_modules/.bin` 被放到 PATH 最前；脚本调用的 `tsc`/`eslint`/`prettier` 优先命中那里 |

第三条最隐蔽：不需要攻击者，一个在 home 目录随手 `npm i` 过的开发者就够了。

**恢复动机本身是成立的**（SELinux 确实会挡住某些挂载点的 `getcwd`/`openat`），错在把"读不到当前目录"降级成了"改用 $HOME 当项目根"——这是两件不同的事。修复按调用方拆开：

| 调用方 | 处理 |
|---|---|
| `bun run <script>`（`without_linker`）| **恢复上游的致命行为** —— 它靠 `root_dir_info.enclosing_package_json` 找脚本，拿别的目录顶替必然跑错 |
| install / `filter_run`（`with_linker`）| 保留 fallback —— 它们只需要一个 resolver 起点，不读 cwd 的 package.json 当身份 |
| 两者共用的 `npm_package_*` 注入 | fallback 时一律跳过 —— 这些变量描述"正在运行的包"，顶替来的根没有这个身份 |
| fallback 发生时 | 打印警告；静默替换会让下游所有异常看起来像是别处的问题 |

**验证（`ada86391d`）**：

| 检查 | 结果 |
|---|---|
| 不可读 cwd 跑 `bun run start` | 报 `error loading current directory`，exit=1，**未执行 $HOME 的脚本** ✅ |
| 正常项目 | 照常执行，`npm_package_name` 正确 ✅ |
| PATH | 不再含 `$HOME/node_modules/.bin` ✅ |
| `resolver-permission-denied-ancestor.test.ts` | skip 已撤销，**2 pass / 0 fail** |
| `cli/run` 全目录 43 个文件 | 仅 2 个失败，均为已知 T12（FUSE），**零回归**；比修复前还少一个（`multi-run` 已随 splice 修复转绿）|
| `filter-workspace`（保留 fallback 的那侧）| 3 0 通过 —— 此前只能靠推断的边界得到实测确认 |
| `bun-install` / `bun-add`（install 路径）| 各 3 0 通过，跳过 `npm_package_*` 注入未造成影响 |

报的错误文案与上游逐字一致，所以这不是"OHOS 特例"而是**回到了正确行为**。

---

## T33 — compat-shim 丢掉 `AT_SYMLINK_NOFOLLOW`，chmod 穿透 symlink（已修，0.2.2）

`cli/install/symlink-path-traversal.test.ts` 断言：安装一个 `bin` 指向包外文件的软链接时，被指向的文件必须保持原权限 `0o600`。实测是 **`0o775`** —— chmod 穿透了软链接，落到了包外的文件上。测试名里的 "path traversal" 不是修辞。

**根因在我们自己的 compat-shim**，而且旧代码的注释里就写着：

```c
/* Fallback: classic fchmodat(), no flags — the one meaningful loss is
 * AT_SYMLINK_NOFOLLOW (mode would apply to the symlink's target
 * instead of being rejected/applied to the link itself). */
return fchmodat(dirfd, path, mode, 0);
```

`fchmodat2` 在本平台会 SIGSYS，shim 回退到经典 `fchmodat()` 时把 flags 一并丢了。当时把这当作"有损但可接受的简化"——**不可接受**：丢掉 `AT_SYMLINK_NOFOLLOW` 等于把"不要跟随这个软链接"改写成"跟随它"。

**而且那个前提本身是错的。** 实测本机的经典 `fchmodat()` 完整支持该 flag：

| 目标 | `fchmodat(..., AT_SYMLINK_NOFOLLOW)` |
|---|---|
| 普通文件 | `rc=0`，正确应用 |
| 目录 | `rc=0`，正确应用 |
| 软链接 | `rc=-1 ENOTSUP`，**目标不变** |

这正是 Linux 的契约（软链接自身的权限位没有意义，所以 chmod 被拒绝）。**flag 直接透传即可**，`AT_EMPTY_PATH` 仍丢弃（经典 `fchmodat` 会直接拒绝，且无调用方使用）。

**验证**：shim 功能测试新增 `test_fchmodat2_symlink_not_followed`（断言目标 mode 不变），报 `ret=-1 errno=95 (ENOTSUP), target mode=600`；原有的 `fchmodat2_bun_lchmod`（普通文件）照常通过，因为 NOFOLLOW 在那里本就是 no-op。套件 **ALL PASS (0/35)**。bun 侧该文件 **1 fail → 0 fail，3/3 稳定**。

**已发布并装机**：tap PR [#87](https://github.com/social4hyq/homebrew-core/pull/87) 已合并，`ohos-compat-shim` 0.2.1 → **0.2.2**（bottle tag `-r1`），本机已 `brew upgrade` 到位。用**生产版**（非本地构建）复验：

| 检查 | 结果 |
|---|---|
| 探针：普通文件 / 目录 + NOFOLLOW | 均正确应用 ✅ |
| 探针：symlink + NOFOLLOW | `ENOTSUP`，目标 mode 不变 ✅ |
| `symlink-path-traversal.test.ts` ×3 | **3/3 全 0 fail** |
| `bun-install` / `bun-add` 回归 | 各 3 0 通过 |
| `fs.test.ts` | 1 fail —— 是 T06 已记录的 `readdir(recursive)` 系列，与 `fchmodat2` 无调用关系，**非回归** |

**升级时踩到的遗留问题**（与本条无关，但值得记）：`brew upgrade` 报 `Cellar/opencode/1.18.7 is not a directory`。原因是更早一次 `brew upgrade` 被我的 115s timeout 中断，brew 已把旧版重命名为 `<version>.reinstall` 准备重装却没跑完，留下半截状态；`opencode@2` 同样中招。把两个 `.reinstall` 目录改回原名即恢复（内容完整，含 `INSTALL_RECEIPT.json`）。**教训：给 `brew upgrade` 设短 timeout 有风险**——它中断的可能是不可重入的重命名步骤，而报错信息（"is not a directory"）完全看不出这个来历。

**遗留边界**：bun **静态内嵌**了一份 compat-shim，所以 `bun build --compile` 的产物（运行时没有 ambient `LD_PRELOAD`）在 bun 重新编译前仍是旧行为。普通 `bun` 调用走预加载库，立即修复。

---

## T34 — `execSync` 的 timeout 杀不到真正的子进程（class D，非 bun 缺陷）

`test-child-process-execsync.js` 断在 `assert(end < SLEEP)`：`TIMER=200ms` 的超时应当让调用提前返回，实测却等满了子进程的 2000ms。

**第一步就是同机 node 对照**（T32 的教训），结果逐项一致：

| | elapsed | errno | status |
|---|---|---|---|
| bun | 2093ms | -110 ETIMEDOUT | **143** |
| node | 2130ms | -110 ETIMEDOUT | **143** |

`status=143` = 128+15，说明 SIGTERM 确实发出并终止了某个进程 —— 但调用仍等满。node 一致 ⇒ **不是 bun 缺陷**。

**定位到 shell 这一层**，靠一组对照：

| 方式 | sleep=2000 | sleep=5000 |
|---|---|---|
| `execSync`（**经 shell**）| 2098ms ❌ | 5086ms ❌ |
| `spawnSync`（**不经 shell**）| 425ms ✅ | 430ms ✅ |

不经 shell 时超时完全正常，且 elapsed 不随 sleep 变化。经 shell 时 elapsed 精确跟随 sleep —— 超时对它毫无作用。

trace 给出进程结构与致命的一步：

```
bun(56101) → helper(56104) → /bin/sh(56116) → bun(56127)
pid=56104  kill(56116, 15)             ← 只杀了 shell
pid=56104  wait4(56116, WNOHANG) = 0   ← 反复轮询，孙进程还活着
```

**timeout 只 `kill` 直接子进程（shell），孙进程 56127 继续持有 stdout 管道的写端**，父进程读不到 EOF，于是等到孙进程自然结束。在多数 Linux 上这被 shell 的 exec 优化掩盖了：`sh -c "单条命令"` 直接 exec 替换自身，于是"杀 shell"就等于"杀真正的进程"。

**已排除的方向**（都做了探针，避免把平台当替罪羊）：

| 假设 | 结果 |
|---|---|
| 信号无法中断阻塞等待 | ❌ 证伪：SIGTERM 在 300ms 中断了 `poll` / `epoll_wait` / `nanosleep` 三者 |
| shell 忽略 SIGTERM | ❌ 证伪：mksh / bash / zsh 收到 SIGTERM 均在 ~300ms 内退出 |
| mksh 不做 exec 优化 | ❌ 部分证伪：裸命令、带引号路径、带参数、含分号四种形态下 mksh **都**做了 exec 优化，无子进程 |

**未查清、如实记录**：手动用 execSync 的精确命令串跑 `/bin/sh -c`，mksh 做了 exec 优化、不 fork；但 execSync 实际运行时 trace 显示 shell 确实 fork 了孙进程。两者的差异变量（execSync 设置的 stdio 组合 / 环境 / 进程组）尚未定位。**所以"mksh 在此场景下为何 fork"是未解的**，不要把上表当成完整解释。

**归类 class D（环境）**：被测对象（bun）行为与 node 一致，平台的信号机制正常，差异来自 shell 层的进程结构。

**潜在改进（上游设计，非本轮范围）**：`execSync` 的 timeout 若杀进程组（`kill(-pgid)`）而非单个 pid，就不依赖 shell 是否 exec 优化。这是 node 与 bun 共有的设计选择，不是本 fork 的问题。

---

## T32 — 测量环境本身有透明代理：任意公网地址的任意端口都"连接成功"（class D，影响网络类判定）

挖 `test-net-autoselectfamily.js`（Happy Eyeballs / RFC 8305）时撞上的，**不是 bun 缺陷，是本机网络环境**。

测试用 mock lookup 给出 6 个地址（v6/v4 交替），期望 `autoSelectFamilyAttemptedAddresses` 记录全部 6 次尝试；实测只有 1 个。但把它抽成不依赖 node test harness 的最小复现后，**node 在同一台机器上给出完全相同的结果**：

```
本机 bun : attempted count = 1  ["2606:4700::6810:85e5:36423"]
本机 node: attempted count = 1  ["2606:4700::6810:85e5:36481"]
```

行为一致 ⇒ 与 bun 无关。C 探针查出原因：

| 目标 | `connect()` 结果 |
|---|---|
| `2606:4700::6810:85e5:9`（公网 v6，discard 端口）| **connected** ❌ |
| `104.20.22.46:9`（公网 v4，discard 端口）| **connected** ❌ |
| `::1:9` | Connection refused ✅ |
| `127.0.0.1:9` | Connection refused ✅ |

连公网地址的 **discard 端口**都"连得上"——本机跑着 `org.xbgroup.clashbox` / `org.xbgroup.clashbox:vpn`，透明代理接管了所有出站连接。于是 Happy Eyeballs 的第一个地址立即"成功"，后续 5 个根本不会被尝试，`attemptedAddresses` 自然只有 1 条。

**归类 class D（环境），不是 A/B/C。** 任何有透明代理的机器上这个测试都会这样失败，与平台和 bun 都无关。

### 对已有结论的影响（已核查）

- **loopback 不受影响**——探针确认 `::1` / `127.0.0.1` 仍正确返回 `Connection refused`，代理只接管出站。因此 **T30（内核把 RST 呈现成正常 EOF）的结论不受波及**：它的复现全程在 `127.0.0.1` 上，且那里 bun 与 node 的行为**不同**（node 报 EPIPE、bun 不报），正是排除环境因素的判据。
- **需要重新审视的**：台账里凡是断言"连接某个公网地址应当失败/超时"的条目，其失败原因都可能是这个代理而非被测对象。已知涉及外网的有 T14（网络/超时预算）、`node-dns.test.js` 的 `dns.resolvePtr → ENOTFOUND`、`fetch-tls-abortsignal-timeout`。本轮未逐条复核，但**在此环境下它们的失败不能直接当作 bun 或平台的证据**。

**方法论**：这一条能定性，靠的是先拿 node 做同机对照、发现一致后才去查环境，而不是直接从 bun 的实现找解释。凡是"网络行为不符预期"的失败，同机 node 对照应当是第一步而非最后一步。

---

## T30 — 内核把 TCP RST 呈现成正常 EOF，bun 的读侧错误检测因此失效（平台限制 + bun 可改进）

从 T21 复核里挑 `test-net-error-twice.js` 深挖得到。测试逻辑：client 连上后立即 `destroy()`（RST），server 往这条死连接写 10MB，期望 server 端 `error` 事件**恰好一次**。

三方对照，同一段最小复现：

| 环境 | 结果 |
|---|---|
| 本机 HarmonyOS + bun | `errs.length = 0`，无 error 事件，`close` 的 `hadError = false` ❌ |
| OpenHarmony 容器 + bun（同一份二进制）| `ERROR event: EPIPE read`，`hadError = true` ✅ |
| 本机 HarmonyOS + node | `ERROR event: EPIPE write` ✅ |

同一台机器上 node 行得通、bun 行不通，所以**不是单纯的平台缺陷**；但换个内核 bun 又行得通，所以**也不是单纯的 bun 缺陷**。独立 C 探针把交叉点找出来了 —— RST 之后本机各检测信道的表现：

| 手段 | 本机 | 标准 Linux |
|---|---|---|
| `write()` | `-1 ECONNRESET` ✅ | 同 |
| `read()` | **`0`（干净 EOF）** ❌ | `-1 ECONNRESET` |
| `SO_ERROR` | **`0`（无错误）** ❌ | `ECONNRESET` |
| `epoll` 事件 | `EPOLLIN\|EPOLLOUT\|EPOLLRDHUP\|EPOLLHUP`，**无 `EPOLLERR`** ❌ | 含 `EPOLLERR` |

**内核把 RST 导致的终止呈现成了正常 EOF**：三个读侧信道全部丢掉错误信息，只有 `write()` 还留着 `ECONNRESET`。于是 bun（读侧检测，容器日志里的 `EPIPE read` 是直接证据）把它当成对端正常关闭，node（写侧检测，报 `EPIPE write`）则不受影响。

**errno 分类不是问题**：`us_internal_send_errno_is_peer_gone()`（`packages/bun-usockets/src/socket.c:515`）的名单里有 `ECONNRESET`。bun 也确实有写侧的 fatal 派发路径（`socket_body.rs:~906`，`internal_flush()` 返回 fatal errno → 派发 error handler → close），只是它挂在 **drain 派发**上，而这个场景里 RST 让 socket 先走了 close，那条路径没被走到。

**可修，但要动上游共享的 socket 关闭路径**（class A + B 混合）：既然 `write()` 仍然带着 `ECONNRESET`，bun 完全可以像 node 那样在关闭前从写侧取错误。风险在于"关闭前尝试 flush 并检查 fatal errno"要嵌进 close 流程，误判会把正常关闭报成错误。**本轮未修**，建议单独立项。

---

## T25 — OHOS procfs 不报告 `tty_nr` / `tpgid` / `state`（平台限制，class B）

`no-orphans.test.ts` 的 Ctrl-Z 用例断言全部建立在 `/proc/<pid>/stat` 之上，在 OHOS 上无法成立。四个独立 C 探针（完全脱离 bun）把边界划清楚了：

| 能力 | 结果 |
|---|---|
| `ioctl(TIOCSCTTY)` | ✅ rc=0，且生效（`tcgetpgrp` 随即返回 session leader 的 pgid）|
| `tcsetpgrp` / `tcgetpgrp` 前台进程组切换与交还 | ✅ 完全正常 |
| `SIGTSTP` / `SIGSTOP` 停止、`SIGCONT` 恢复 | ✅ 正常（`waitpid` 报 `WIFSTOPPED=1` / `WIFCONTINUED=1`）|
| `open(slave)` 自动获取 ctty（Linux 语义）| ❌ 不发生，需显式 `TIOCSCTTY` |
| `/proc/<pid>/stat` 字段 `tty_nr` | ❌ 恒为 0（即便 `TIOCSCTTY` 已成功）|
| `/proc/<pid>/stat` 字段 `tpgid` | ❌ 恒为 0（即便 `tcgetpgrp` 返回正确值）|
| `/proc/<pid>/stat` 字段 `state` | ❌ 进程被 `SIGSTOP` 停止后仍持续报 `S`，500ms 内不变 |

**作业控制的功能层完好，只有 procfs 的观测层缺失。** 所以这个用例在 OHOS 上既不能证明 bun 对、也不能证明 bun 错 —— 它测不到东西。归 class B/C，保留 quarantine 并在注释里指向本节；不改测试（改成 `waitpid` 口径要重写整个用例，且上游没有这个需求）。

`/proc/<pid>/stat` 的 `ppid` 字段**是准的**（T26 的修复正依赖它）——不要把本节读成"OHOS procfs 全不可信"。

---

## T26 — `--no-orphans` 在 OHOS 上完全静默失效（`CONFIG_PROC_CHILDREN` 缺失，已修 `e76b0d3a8`）

从 `no-orphans.test.ts` 的 setsid daemon 用例（30s 超时）挖出来，实际影响远超一个用例。

**症状链**：用例 `stderr: "pipe"`，daemon 继承写端且 `sleep 1 while 1` 永不退出 → 若 bun 没把 daemon 杀掉，`await proc.stderr.text()` 就永不返回 → 30s 超时。手动复现证实：`bun run --no-orphans` **exit=0**，但它 spawn 的 setsid daemon **3s 后仍存活**。

**根因**：`list_child_pids_linux()`（`src/io/ParentDeathWatchdog.rs`）读 `/proc/<pid>/task/<tid>/children`，该文件只在内核开了 `CONFIG_PROC_CHILDREN` 时存在。OHOS 内核没开 —— 实测该路径**不存在**。于是每次 `read_file_once` 返回 `None` → `continue` → 循环走完 → 函数返回 **`Some(0)`**，与"这个进程没有子进程"**完全无法区分**。

这一个返回值让四个调用方全部空转：`kill_descendants()`（退出时的主清理路径）、`kill_subreaper_adoptees()`、`kill_tree_rooted_at()`、`snapshot_children()`。**整个 `--no-orphans` 特性在 OHOS 上不工作，且不报任何错。**

**先排除了平台限制**（否则就该归 class B 而不是修 bun）：

| 能力 | 结果 |
|---|---|
| `prctl(PR_SET_CHILD_SUBREAPER, 1)` | ✅ rc=0，`PR_GET` 读回 1 |
| 孤儿孙进程是否真的 reparent 到 subreaper | ✅ 是 |
| `/proc/<pid>/stat` 的 `ppid` 字段 | ✅ 准确 |
| 扫 `/proc` 按 ppid 找子进程 | ✅ 可行（探针看到 224 个 pid，精确找出 3 个直接子进程）|
| `/proc/<pid>/task/<tid>/children` | ❌ 不存在 |

平台该有的都有，缺的只是一个内核配置项暴露的快捷文件。所以是 class A，可修。

**修复**：加 `children_file_usable` 标志区分"文件存在但为空"（真没子进程）和"文件根本不存在"（内核不支持），后者回退到扫 `/proc` 读每个 `stat` 的 ppid —— `pgrep`/`pstree` 的传统做法。快路径在有该文件的内核上完全不变；回退是 O(进程数)，但四个调用方全在退出/拆除路径上（进程退出，或 spawnSync 的 disarm defer），不在稳态执行路径。

**这不是 OHOS 特有的修复** —— 任何没开 `CONFIG_PROC_CHILDREN` 的内核（不少嵌入式/精简内核配置）上，`--no-orphans` 都同样静默失效。

**验证（`e76b0d3a8`）**：最小复现 A/B 一目了然 —— 修复前 `daemon 3965 仍存活`，修复后 `daemon 4027 已被 reap`。测试文件从 2 fail → **1 pass / 1 fail**（剩余的是 Ctrl-Z，属 T25/T27）。

### 顺带打掉一层隐藏跳过：`isPosix` 不认 openharmony

`no-orphans.test.ts:23` 的 `isPosix` 硬编码只认 linux/darwin，14 个 `skipIf(!isPosix)` 用例在本机全部静默跳过 —— 正是本轮要消灭的那类"从分母里消失"。加上 openharmony 后：

| | 修复前 | 解锁后 |
|---|---|---|
| pass | 1 | **15** |
| skip | 21 | 5 |
| fail | 1 | 3 |

新恢复的 14 个用例**全部通过**。新增的 2 个 fail 是解锁后才第一次被执行到的（不是回归），分别归入 T25 和下面的 T27。

---

## T27 — OHOS 的 PTY 行规程不生成信号（平台限制，class B）

解锁 `isPosix` 后暴露：`Ctrl-Z stop observed by outer shell's waitpid(WUNTRACED)` 超时。这个用例**不依赖 T25 那些 procfs 字段**（它走 `waitpid(WUNTRACED)`，而探针已证明该语义正常），所以是另一回事。

线索来自输出本身：`"BUN_PGID 8412\r\nREADY 8507\r\n^Z"` —— `^Z` 被**回显成字面字符**，`BUN_STOPPED` 从未出现。行规程认出了控制字符（ECHOCTL 生效），却没有据此发信号。

独立 C 探针（建 PTY → 子进程 setsid + TIOCSCTTY + 成为前台组 → 从 master 写控制字符 → `waitpid(WUNTRACED)`）：

| 写入 master 的字符 | 子进程 termios | 结果 |
|---|---|---|
| `^Z` (0x1a, VSUSP) | `ISIG=1 VSUSP=0x1a` | **无任何信号** |
| `^C` (0x03, VINTR) | `ISIG=1 VINTR=0x03` | **无任何信号** |
| `^\` (0x1c, VQUIT) | `ISIG=1` | **无任何信号** |

三个都不生成。`ISIG` 是开的、控制字符配置正确、前台进程组也设对了 —— OHOS 的 PTY 行规程就是不做字符→信号这一步。

对照 T25：那里缺的是**观测**（procfs 字段），这里缺的是**功能**（信号生成）。两者都不是 bun 的问题，但性质不同，所以分开记。任何依赖"往 PTY 写 ^C/^Z 来控制子进程"的测试在本机都不可能通过。

---

## T28 — OHOS 补丁自身的缺陷：`bun run` 下 PDEATHSIG 被清除且无人接手（已修 `822f3121d`）

`no-orphans.test.ts` 的 `supervisor SIGKILLed > bun run and the script exit` 用例：SIGKILL 掉外层 `sh` 后，`bun run` 10s 不退出。

**这个根因在我们自己的 fork 里**，不是上游缺陷 —— `src/spawn/process.rs` 那段 `#[cfg(target_env = "ohos")]` 的 no_orphans 分支。

**逐步二分**（每一步都推翻了上一步的假设，值得留档）：

| 实验 | 结果 | 排除了什么 |
|---|---|---|
| C 探针：`prctl(PR_SET_PDEATHSIG)` 是否生效 | ✅ 父死后 100ms 内子进程消失 | 平台不支持 PDEATHSIG |
| `bun script.js` + env var | ✅ 正常退出 | bun 完全不 arm |
| `bun run --no-orphans go`（flag 路径）| ❌ 不退出 | — |
| `bun run` + env var（**排除 flag/env 差异**）| ❌ 同样不退出 | "是 flag 路径解析太晚" |
| `bun spawner.js`（脚本内 `Bun.spawn`）+ env var | ✅ 正常退出 | "spawn 这个动作破坏 PDEATHSIG" |

到这里锁定在 `bun run` 特有的 **spawnSync** 路径。用 ohos-trace-shim 拦 `prctl`（Rust 侧是 `libc::prctl`，走符号，不像 rustix 的 `linux_raw` read/write 那样隐形）拿到决定性序列：

```
6:  pid=36527 prctl(PR_SET_PDEATHSIG, 9) = 0    ← bun run arm SIGKILL ✓
8:  pid=36527 fork() = 36531
10: pid=36531 prctl(PR_SET_PDEATHSIG, 9) = 0    ← 子进程设自己的 ✓ 正常
11: pid=36531 execve(bash)
12: pid=36527 prctl(PR_SET_PDEATHSIG, 0) = 0    ← ★ 父进程把自己的清成 0
```

**清除本身是有意为之**（SIGKILL 不可捕获，会让 cleanup defer 跑不了），代码打算用 `pidfd_open(ppid)` + `getppid()` 兜底来接手。两条退路的平台可用性也都用探针确认过：`pidfd_open` 成功、`poll` 正确唤醒、`getppid()` 在父死后 200ms 内变 1。

**真正的缺陷是那段接手代码的入口条件**：

```rust
while out_fds_to_wait_for[0] != Fd::INVALID || out_fds_to_wait_for[1] != Fd::INVALID
```

父死检测整个写在这个循环体里，而循环只在**有管道 stdio 要 drain** 时才执行。`bun run <script>` 用的是**继承** stdio，两个 fd 都是 INVALID，循环体一次都不进 —— PDEATHSIG 已经交出去了，接手的人却从没上班。`--no-orphans` 在它最常见的用法下静默失效。

**修复**：只有在那个循环确实会跑时才做这笔交易；否则保留 PDEATHSIG。代价是 SIGKILL 情形下 cleanup defer 不执行 —— 而这正是上游 Linux 路径既有的行为（`enable()` 的注释写明该情形靠 env-var 继承来做后代清理）。两害相权，"父死我死"是 `--no-orphans` 的第一语义，不能为了次要的 defer 把它丢掉。

**验证（`822f3121d`）**：最小复现 A/B —— 修复前 `bun run(18929) 仍存活`，修复后 `bun run(19690) 已随父退出`。

### `no-orphans.test.ts` 收口（plan Step 5 的样板）

一个文件走完"解锁 → 修 → 降级剩余项"的完整流程：

| 阶段 | pass | skip | fail |
|---|---|---|---|
| 起点（`isPosix` 不认 openharmony）| 1 | 21 | 1 |
| 解锁 `isPosix` | 15 | 5 | 3 |
| T26 + T28 修复后 | 16 | 5 | 2 |
| 两个 Ctrl-Z 用例降级为带根因的文件内 skip | **16** | 7 | **0** |

最后一步**没有**把文件塞回 `expectations.txt`。剩下两个用例是 T25/T27 两个内核侧缺口，各自在 `skipIf` 上标了 `ohosNoTtyJobControl` 并在文件头写清根因和探针结论；其余 16 个用例照常计入分母。这正是 `expectations.txt` 文件头警告的反面做法 —— 整文件 quarantine 会连带丢掉那 16 个的覆盖。

同时 `test/expectations.txt` 删掉 `18239` 条目（**73 → 51 条** `[ OPENHARMONY ]`），该文件在**不带** `--ignore-expectations` 的正常 CI 口径下已 1 pass / 0 fail。

**另外**：`tty-reopen-after-stdin-eof` 和 `tui-app-tty-pattern` 实测**已经通过**——上面表格里原先列为"可能同根因"，应从 T03 簇移出。

---

## T04 — `statx(2)` 对 socket 型 fd 报 EBADF，bun 的 `fstatSync` 误当真错误抛出（已修复并真机验证）

对应 `OHOS_TEST_STATUS.md` 第八/九轮记录的"字面 fd 数字作 stdio 导致父进程自身 fd 失效"。本轮排查**完全推翻了"spawn fd 所有权"的原始假设**——fd 从头到尾都没坏，是 bun 的 `fstatSync()` 实现在特定条件下给出了错误答案。

### 根因

`node_fs.rs::fstat()` 优先走 `statx(2)`（`SUPPORTS_STATX_ON_LINUX` 开关），失败时按 libuv 同款 errno 列表（`ENOSYS`/`EOPNOTSUPP`/`EPERM`/`EINVAL`）降级到普通 `fstat(2)`。**OHOS 的 `statx(2)` 对 socket 型 fd 返回的是 `EBADF`**（真机裸测证实：`syscall(SYS_statx, socket_fd, ...)` → `-1/EBADF`，而同一个 fd 上 `fstat(socket_fd, ...)` → `0` 成功）。`EBADF` 不在降级白名单里，于是这个本该降级处理的"假错误"被原样抛给了 JS 层的 `fstatSync()` 调用者。

触发条件：fd1/2 底层是 **socket**——Node.js 在这个平台上的 `"pipe"` stdio 实际是用 socketpair 实现的（不是传统匿名管道），而 `scripts/runner.node.mjs:1250` 拉起每个测试文件用的正是 `stdio:["ignore","pipe","pipe"]`。这解释了为什么 `spawn.test.ts` "close handling" 64 个组合里只有 `stdout===1`/`stderr===2` 那 28 个报错——不是这两个字面数字触发了什么特殊 spawn 逻辑，纯粹是测试断言用 `typeof stdout === "number"` 做门控，只有这两种取值会真的去调用 `fstatSync`，其余组合根本没检查、不代表没受影响。

### 排查历程摘要（完整过程见 commit 历史，不在此重复）

最初怀疑 `Bun.spawn({stdout:1,stderr:2})` 导致父进程 fd 失效 → 删掉 spawn 调用后单独一行 `fstatSync(1)` 依然报错，证明和 spawn 完全无关 → 怀疑 bun 启动阶段某处弄坏自己的 fd，用插桩二分定位（`run_command.rs`/`VirtualMachine.rs` 里连续加了 9 个 `t04_debug_fd_checkpoint()`，横跨 `boot()`→`Run::start()`→`load_entry_point()`→`wait_for_promise()`，做了 4 轮容器重编）→ **每一个 checkpoint 用裸 `libc::fstat()` 检查都显示 fd 完全正常，包括用户脚本自己的 `fstatSync(1)` 调用报错之后**——这才意识到检查方向错了：`writeSync(1, "...")` 在"失败"的 `fstatSync(1)` 前后都能成功写入，证明 fd 本身从未损坏，坏的是 `fstatSync()` 这个 API 本身的实现。顺藤摸瓜找到 `statx_impl` 的降级白名单缺了 `EBADF`。

### 修复

`src/sys/lib.rs::statx_impl()`：把 `E::EBADF` 也纳入降级到 `statx_fallback`（普通 `fstat`）的判断，限定 `#[cfg(target_env = "ohos")]`（真实 Linux/Android 的 `statx` 没有这个怪癖，不动它们的行为；即使限定放开，对"fd 真的坏了"的场景也无害——fallback 路径一样会从 `fstat(2)` 得到相同的 `EBADF`，唯独修复了"fd 有效但 `statx` 不支持这个 fd 类型"这一种此前被误判的场景）。

真机验证（`3bc00b9e7`，同一个复现脚本）：
- `fstatSync(1)`/`fstatSync(2)` 在管道 stdio 下正确返回 OK，不再报 EBADF。
- `test/js/bun/spawn/spawn.test.ts` "close handling" 描述块：64/64 全部通过（此前 28/64 失败）。

插桩代码（`t04_debug_fd_checkpoint` 相关，跨 `e3deeb459`/`c1201090b`/`1e3b53fed`/`63f54adc7` 四个 commit）已在修复 commit 里一并移除。

| 文件 | 症状 | 分类 | 层级 | 状态 |
|---|---|---|---|---|
| `test/js/bun/spawn/spawn.test.ts` | `close handling` 描述块 64 个组合里,`stdout===1`/`stderr===2` 的 28 个失败 | A | rust | **已修复,全文件真机验证**（`3bc00b9e7`：`135 pass, 6 skip, 0 fail`，`Ran 141 tests across 1 file`,此前 28 fail 现已全部转绿）；含 `with BUN_FEATURE_FLAG_FORCE_WAITER_THREAD` 那个不相关的慢用例,同样通过 |
| `test/js/bun/spawn/spawn_waiter_thread.test.ts` | issue #9404，`resourceUsage().cpuTime.total` 断言 `< 750_000n`，实测 `1374480n` | A | rust | **复核完毕，非同根因**——不是 statx/EBADF，是 waiter thread CPU 时间统计口径问题（真机上 waiter 线程消耗的 CPU 时间比阈值假设的高约 83%），需要单独立项 |
| `test/js/bun/spawn/spawn-pipe-read-error-leak.test.ts` | `PipeReader is freed when a subprocess stdout read fails`：断言 stderr 应为空数组，实测捕获到 8 行 `cat: .../sync-fifo: Broken pipe` | A | rust | **复核完毕，非同根因**——不是 statx/EBADF，是子进程 `cat` 读坏掉的 FIFO 时产生的 stderr 输出没有被过滤/预期到，需要单独立项 |
| `test/js/bun/spawn/spawn-pipe-stale-fd-unregister.test.ts` | `FilePoll teardown tolerates an fd closed while still registered` | A | rust | **已确认同根因，随 T04 修复转绿**：`1 pass, 0 fail`（此前失败） |
| `test/js/bun/spawn/spawn-stdin-large-buffer.test.ts` | 大 stdin buffer（2048/4096/8192 KB）截断，`spawnSync`/`Bun.spawn` 两条路径全部收到远小于预期的字节数（含收到 `0` 字节的情况） | A | rust | **复核完毕，非同根因**——不是 statx/EBADF，`fstatSync` 早已不参与这条路径；症状是大 buffer 下 socketpair 读取/写入的真实数据丢失，比 T04 更严重，需要单独立项且优先级应提高（数据完整性问题） |
| `test/js/node/test/parallel/test-net-socket-constructor.js` | `cluster.fork({stdio:['pipe','pipe','pipe','ipc','pipe','pipe','pipe']})` 的 worker 退出码 1 而非 0 | A | rust | **通过**（本轮 `--include` 批次里在"parallel-safe"分组内跑,记为 Passed,未见于 Failing 列表）——是否是 T04 附带修复暂无法反证,但当前已是绿色,不再需要动作 |

## T05 — `fs.watch(recursive: true)` 内核不支持（class B 硬限制，历史已确认）

OHOS inotify 不支持递归监听 flag，历史多轮记录过，本轮 6 个文件全部复现。

```
test/js/node/test/parallel/test-fs-watch-recursive-add-file-to-existing-subfolder.js
test/js/node/test/parallel/test-fs-watch-recursive-add-file-with-url.js
test/js/node/test/parallel/test-fs-watch-recursive-add-file.js
test/js/node/test/parallel/test-fs-watch-recursive-add-folder.js
test/js/node/test/parallel/test-fs-watch-recursive-symlink.js
test/js/node/test/parallel/test-fs-watch-recursive-sync-write.js
```

分类 B，层级 n/a，状态：保留 quarantine（整文件跳过合理，beforeAll 就依赖递归监听）。

---

## T06 — fs 递归遍历 / ELOOP 自引用符号链接 fixture

`test/js/node/` 目录树里为其他 vendored 测试准备的自引用符号链接 fixture（`fixtures/follow/cycle/...`），被 `fs.test.ts`/`fs.watch.test.ts` 的全目录 `readdir(recursive:true)` 扫到导致 `ELOOP`。历史记录过（第八轮）未定论是真 bug 还是 musl `SYMLOOP_MAX` 差异,本轮未新增证据。

| 文件 | 症状 | 分类 | 层级 | 状态 |
|---|---|---|---|---|
| `test/js/node/fs/fs.test.ts` | `readdir(recursive)`/`readdirSync(...recursive)` 与 Node.js 结果不一致（3 个子用例）+ `readdir(recursive) x100` 遇 `ELOOP` | F | rust? | 待与真实 Node.js 对照 |
| `test/js/node/test/sequential/test-fs-watch.js` | `assert.strictEqual(event, renameEv)` 事件分类不对 | F | rust | 待查（可能与 T05 同属 inotify 差异,但这个不是 recursive）|
| `test/js/node/watch/fs.watch.test.ts` | `inotify queue overflow`→`(change, null)`断言；`fs.promises.watch` symlink 场景（2）| F | rust | 待查 |
| `test/js/node/test/parallel/test-fs-link.js` | ~~未取得具体断言~~ | ~~E~~ | n/a | **已修复（`ade348ec6`）**——实际是 OHOS 内核拒绝裸 `SYS_linkat`，bun 直调 `libc::link()`（musl 直发裸 syscall）绕过 shim 的 `linkat` 符号拦截，详见 T21 表格里的完整根因记录 |
| `test/js/node/test/parallel/test-fs-promises.js` | ~~同上~~ | ~~E~~ | n/a | **已修复（`ade348ec6`，同根因）** |
| `test/js/node/test/parallel/test-fs-stat-date.mjs`（+ 未在基线清单的 `test-fs-stat-temporal.mjs`） | ~~同上~~ | ~~E~~ | test | **已修复（`64bf8ea35`）**——两个独立问题叠加：① vendored 测试的容忍守卫 `actual === 0` 对 BigInt 路径有类型洞（`0n === 0` 为 false）；② 这台设备文件系统的钳制边界比守卫预设的 NFSv3（仅 1970 前）更宽：**tv_sec=0 任意纳秒全部钳为 0**（1ms/355ms/999999999ns 实测皆然），tv_sec≥1 纳秒精度完整。守卫按实测边界（expected<1000ms）放宽并改数值比较 |

**注意**：上面三行原本都被标成"E 类 node-vendored 平台差异，未取得具体断言"——本轮深挖证明这个归类**全是错的**：fs-link 是可修的真实调用链问题（改 1 行代码修复），stat-date 是测试自身的类型洞 + 可精确表征的平台行为（修测试容忍度）。这对"E 类=不用管"的默认假设是一个警示，其余 E 类条目值得按同样标准复核。

---

## T07 — ~~cluster `getSystemErrorName` 崩溃~~ **撤回：隔离复测不复现，基线同样通过**

已知平台限制是"绑定 <1024 端口需 root"（class B），但本轮发现 fork 出的子进程在收到 `EACCES`（errno 13）后，试图把它转成可读错误名时本身就崩了：

```
RangeError: The value of "err" is out of range. It must be a negative integer. Received 13
    at getSystemErrorName (node:util:249:68)
```

这说明 `util.getSystemErrorName`（或它调用的 `makeErrorWithCode`）**期望负数 errno,但这条路径传入的是正数 13**——独立于"需要 root"这个已知限制之外的一个真实 bug，很可能不是 OHOS 专属（值得先在 macOS/Linux 上验证是否通用）。

**07-28 复核后撤回这条判断。** 四种组合下都不复现：

| 口径 | 最新二进制 | 基线 `3e233644d` |
|---|---|---|
| 单文件隔离 ×3 | 0 fail | 0 fail |
| 61 个 `test-cluster*` 并发 | 0 fail | 0 fail |

`getSystemErrorName` 本身的契约也和 node 完全一致（`-13 → EACCES`，`13 → RangeError`），两边逐字相同 —— 所以"bun 传了正 errno"这个推断没有立足点。当初那条 RangeError 是在**全量批跑**（几百文件并发）里观测到的，进台账前没做隔离复测，违反了本轮方案 Step 2 自己定的规矩（"隔离下仍失败的才进台账；隔离下通过的记为并发敏感，不当作 bug"）。

| 文件 | 分类 | 状态 |
|---|---|---|
| `test/js/node/test/parallel/test-cluster-bind-privileged-port.js` | 并发敏感（非缺陷）| **撤回**，隔离与并发下均通过 |
| `test/js/node/test/parallel/test-cluster-shared-handle-bind-privileged-port.js` | 同上 | **撤回** |

---

## T08 — ~~dgram 未深挖~~ **撤回：与 T07 同类，基线也通过**

| 文件 | 最新二进制 ×3 | 基线 `3e233644d` ×3 | 结论 |
|---|---|---|---|
| `test/js/node/test/parallel/test-dgram-bind-fd.js` | 0 fail | 0 fail | 并发敏感，非缺陷 |
| `test/js/node/test/parallel/test-dgram-socket-buffer-size.js` | 0 fail | 0 fail | 同上 |

和 T07 同一个成因：全量批跑里的失败没经隔离复测就进了台账。

---

## T09 — 第三方包缺 OHOS 预编译原生二进制（class E，复核确认仍成立）

`expectations.txt` 已有对应条目，`--ignore-expectations` 放回来复核后**全部依然失败**——证明这批 quarantine 不是陈旧误判,应该继续保留（不属于 bun 自身缺陷,是上游包没发 `openharmony-arm64` 二进制）。

| 文件 | 缺失的原生模块 |
|---|---|
| `test/integration/sharp/sharp.test.ts` | sharp |
| `test/js/third_party/@napi-rs/canvas/napi-rs-canvas.test.ts` | @napi-rs/canvas |
| `test/js/third_party/resvg/bbox.test.js` | @resvg/resvg-js |
| `test/js/third_party/prisma/prisma.test.ts` | （间接依赖 @napi-rs/canvas）|
| `test/js/third_party/astro/astro-post.test.js` | rollup native (`rollup/dist/native.js`) |

分类 E，层级 n/a，状态：保留 quarantine。

---

## T10 — valkey/Redis 服务缺失（class D，非 OHOS 限制）

| 文件 | 症状 |
|---|---|
| `test/js/valkey/unit/buffer-operations.test.ts` | `ERR_REDIS_CONNECTION_CLOSED` |
| `test/js/valkey/unit/ping.test.ts` | 同上 |

分类 D，层级 n/a，状态：本地沙盒没有 Redis/valkey 服务,不装 docker compose；真实 CI 若配了服务应该能过。不算 OHOS 限制。

---

## T11 — IPv6 / `localhost` DNS 解析 gap（class E，复核确认仍成立）

`expectations.txt` 里已有同类条目（`fetch family:6` 系列），本轮独立触发的几个也是同一个根因：这台沙盒缺少可用的 IPv6 回环/`/etc/hosts` 条目。

| 文件 | 症状 |
|---|---|
| `test/js/bun/dns/resolve-dns.test.ts` | `lookup() family:6/IPv6` 系列 |
| `test/regression/issue/22712.test.ts` | `dns.resolve` 系列回调参数（A/AAAA）|
| `test/js/node/test/parallel/test-net-socket-connect-without-cb.js` | 已有 expectations.txt 条目,复核仍失败 |
| `test/js/node/test/parallel/test-http2-premature-close.js` | 已有 expectations.txt 条目,复核仍失败 |
| `test/js/third_party/grpc-js/test-resolver.test.ts` | DNS resolver 对 `127.0.0.1`/`::1` 断言失败 |
| `test/js/node/test/parallel/test-http2-invalid-last-stream-id.js` | `DNSException: getaddrinfo ENOTFOUND localhost` |

分类 E，层级 n/a，状态：保留 quarantine/已知限制记录。

---

## T12 — FUSE 不可用

本机/容器都没有 `fusermount`，这两个测试测的就是 FUSE 挂载点上的行为，环境缺依赖。

| 文件 | 分类 | 层级 | 状态 |
|---|---|---|---|
| `test/cli/run/glob-on-fuse.test.ts` | B/D | n/a | 待确认能否 `brew install` 补上 FUSE,否则归 B |
| `test/cli/run/run-file-on-fuse.test.ts` | B/D | n/a | 同上 |

---

## T13 — `bun build --compile` 自身平台 target 不可下载

`bun-linux-aarch64-musl-v1.4.0` 目标没有为 OHOS 发布，`--compile` 自编译走的正是这个下载路径。`24742`/`29290` 是同一路径的下游症状（PT_INTERP 断言收到空字符串,而不是一个清晰的报错——编译步骤静默失败了）。

| 文件 | 症状 | 分类 | 层级 | 状态 |
|---|---|---|---|---|
| `test/bundler/bun-build-compile.test.ts` | `compile with current platform target string`；`compiled binary in a deleted cwd` | B | n/a | 已知限制,建议改 `test.skipIf(isOHOS)` 而不是全文件 quarantine |
| `test/regression/issue/24742.test.ts` | PT_INTERP 断言收到空字符串（编译静默失败,应该报错而不是空)| C | test/rust | 值得让编译失败时抛出更明确的错误,而不是吞掉 |
| `test/regression/issue/29290.test.ts` | 同上（2 个子用例）| C | test/rust | 同上 |

---

## T14 — 网络/包管理器超时预算（class D 为主，个别 C）

这台沙盒的外网访问（GitHub 走 gh-proxy、npm registry）延迟高且不稳定，以下失败的共同模式是长超时（90s-300s）打满。

| 文件 | 超时/症状 |
|---|---|
| `test/integration/esbuild/esbuild.test.ts` | 150s，`install and use esbuild` |
| `test/integration/expo-app/expo.test.ts` | 240s，`expo export` |
| `test/integration/next-pages/test/dev-server-ssr-100.test.ts` | 100s |
| `test/integration/next-pages/test/dev-server.test.ts` | 150s，`Failed to install dependencies: SIGTERM` |
| `test/integration/next-pages/test/next-build.test.ts` | `Integrity check failed for tarball`（网络中断导致 tarball 校验失败,不是超时但同属网络类）|
| `test/integration/vite-build/vite-build.test.ts` | 240s（历史记录过"这台机器上此文件计时不稳定"）|
| `test/js/third_party/next-auth/next-auth.test.ts` | 90s |
| `test/cli/install/bunx.test.ts` | 多个 300s（`--no-install` 缓存包查找 + 4 个真实网络拉取场景）|
| `test/cli/install/bun-upgrade.test.ts` | `recreates staging directory`/`verifies...digest`（需要真实 GitHub release）|
| `test/cli/install/bun-security-scanner-matrix-without-node-modules.test.ts` | 其中 1 个子用例 150s 超时（矩阵其余失败见 T-其他）|

分类 D（多数）/C（个别值得调预算），层级 n/a，状态：不建议再盲目加大超时（历史上 vite-build 加倍后仍卡线）,如实记录为环境限制。

---

## T15 — 深路径 / 长路径缓冲区问题（**两项均已收口**：一个随 T01 修复，一个是测试算术已修）

最初怀疑两个文件是同一类"固定缓冲区在深 TMPDIR 下截断"的 Rust bug（类比历史上的 128 字节 shebang 缓冲区 bug）。用 `e39db04d6`（T01 修复后的二进制）复查,结论分岔：

| 文件 | 结论 | 分类 | 层级 | 状态 |
|---|---|---|---|---|
| `test/js/bun/glob/path-length.test.ts` | **已修复（T01 的连带副作用）**：`buildDeepTree()` 用 `Bun.spawn({cmd:["bash",...], cwd: root})` 建深目录树,`root` 落在 EL2——这正是 T01 的触发模式。真机复测（`e39db04d6`）：**6 pass, 0 fail**。之前的失败根本不是"缓冲区溢出",是 T01 的 getcwd 噪音污染了 `buildDeepTree` 内部 bash 循环的 stderr,间接搞乱了后续断言。 | — | — | 已随 T01 一起修复 |
| `test/js/bun/net/unix-socket-long-path.test.ts` | **已修（测试层）**：根因是 `makeSockPath()` 里硬编码的 `pad = total - 60`。`tempDir()` 实际是 `mkdtemp(realpath(os.tmpdir()) + "/" + basename + "_XXXXXX")`，长度随 TMPDIR 深度变化，runner 又在其下多套了一层 `buntmp-XXXXXX/`；于是 `basenameLen` 算成负数，`Buffer.alloc(-2)` 在建 socket 之前就抛 RangeError（`total=108` 侥幸没事，`total=150` 必炸）。改成先用一次不带 pad 的 `tempDir()` 量出实际长度，再反推 padding —— `tempDir(prefix + pad)` 的长度恰好是 `probeLen + pad.length`，所以给 `/` 和 basename 各留一字节就能把 `sock.length` 精确钉在 `total`。复测 **4 pass / 0 fail，3/3 稳定**；用**基线二进制**跑同样通过，证明纯属测试层、与 bun 版本无关。 | C | test | **已修** |

---

## T16 — 测试自身硬编码 `/tmp`（低成本 test 层修复）

`/tmp` 在这台沙盒上只读（`environment_tmp.md` 已记录），测试应该用 `os.tmpdir()`/`TMPDIR` 而不是硬编码路径。

| 文件 | 症状 | 分类 | 层级 | 状态 |
|---|---|---|---|---|
| `test/js/sql/adapter-env-var-precedence.test.ts` | `Failed to listen at /tmp/thisisacoolmysql.sock` | C | test | **低成本修复**：改用 `tmpdir()` 拼路径 |

---

## T17 — WASI 打开 `/` 触发沙盒 EACCES（class B，历史已确认）

| 文件 | 状态 |
|---|---|
| `test/js/bun/wasm/wasi.test.js` | 保留 quarantine（`fs.openSync("/", "r")` 直接验证过是 OHOS app 沙盒策略) |

---

## T18 — bake dev server：feature flag 能解锁,但功能性失败（新发现，需要独立立项）

`ohos-full-test.yml` 里"stable 构建 `bake()` 被编译关闭因此排除"的判断**不准确**——`bake()` 是运行时 `feature_flag::BUN_FEATURE_FLAG_EXPERIMENTAL_BAKE.get()` 判断，不是编译期 cfg。设置 `BUN_FEATURE_FLAG_EXPERIMENTAL_BAKE=1` 后 dev server **确实启动了**（`Started development server: http://localhost:...`），但所有实际测试用例都在等待 dev server 响应时超时（60-120s），说明 HMR/live-binding 机制在这台环境下没有正常工作（或探测机制本身依赖了这台环境不具备的东西，如 WebSocket 长连接/文件监听）。`production.test.ts` 是唯一例外：直接报 "upgrade to canary" 拒绝（未设置到该文件的运行路径？需确认是否遗漏了 env 传递）。

| 文件 | 症状 | 分类 | 层级 | 状态 |
|---|---|---|---|---|
| `test/bake/dev/bundle.test.ts` | 60s 超时 x2 | F | rust | 待查（HMR 机制排查）|
| `test/bake/dev/ecosystem.test.ts` | 120s 超时 | F | rust | 待查 |
| `test/bake/dev/esm.test.ts` | 60s 超时（live bindings 系列）| F | rust | 待查 |
| `test/bake/dev/import-meta-inline.test.ts` | 60s 超时 | F | rust | 待查 |
| `test/bake/dev/plugins.test.ts` | 60s 超时 | F | rust | 待查 |
| `test/bake/dev/production.test.ts` | `error: To use the experimental "--app" option, upgrade to canary` — 和其余 10 个文件不同,没吃到 env | C | test | 待查：为什么这个文件没解锁 |
| `test/bake/dev/react-response.test.ts` | 60s 超时 | F | rust | 待查 |
| `test/bake/dev/request-cookies.test.ts` | 60s 超时 | F | rust | 待查 |
| `test/bake/dev/server-sourcemap.test.ts` | 60-120s 超时 | F | rust | 待查 |
| `test/bake/dev/ssg-pages-router.test.ts` | 60s 超时 | F | rust | 待查 |
| `test/bake/dev/vfile.test.ts` | 60s 超时 | F | rust | 待查 |

**建议**：这是一整个功能面（bake dev server），投入产出比需要评估——先确认 CI 是否真的需要覆盖它（README/发布计划里 bake 是否面向 OHOS 用户），如果不是当前优先级，可以考虑仍然 `--exclude=bake/dev`，但把 workflow 注释里"编译期关闭"的错误描述改成准确的"运行时可开启但功能未跑通"。

---

## T19 — E 类：`expectations.txt` 已有条目，复核仍成立（node-vendored 平台差异，历史归类）

以下与 `OHOS_TEST_STATUS.md` 第九轮记录的 16 个"E 类 node-vendored 平台差异"文件名对得上，本轮复核确认依然失败，不是陈旧条目：

```
test/js/node/test/parallel/test-trace-events-fs-async.js
test/js/node/test/parallel/test-trace-events-fs-sync.js
```

（`child-process-rlimit-nofile.test.ts` **已修复并真机验证**——两个叠加问题：① 沙箱 `/bin/sh` 是 mksh，其 `ulimit` builtin 是**完全 no-op**（设/读皆无效，实测读回为空、子进程看到未变的限制）；② 换能用的 shell 后又暴露 `RealFS::adjust_ulimit` 的真 bug——target 超过当前 hard limit 时它试图连 hard 一起抬，非特权进程 EPERM 整个静默失败，bun 就带着 256 个 fd 的预算跑全程。修复=测试侧换 zsh（`b6e5798e5` 的 test 部分）+ 回退到 Node 语义"soft 抬到 hard 允许的最高"（同 commit 的 rust 部分，**已真机验证**：`ulimit -Sn 256` 后 bun 正确抬到 32768，两个测试 4/4 全过；spawn 簇回归 135/5/1 pass 零影响）。`test-fs-write-sigxfsz.js` 同一个 mksh 根因，测试侧换 zsh 即通过（`631b5664b`）——bun 启动时 `SIGXFSZ→SIG_IGN`，越限写返回 EFBIG 正是 Node 语义。）

（`test-fs-link.js`/`test-fs-promises.js`/`test-fs-stat-date.mjs` 已并入 T06，避免重复计数）

**后续修正（同一轮深挖）**：这个清单里原本还有 `test-process-constants-noatime.js` 和 `test-process-getgroups.js`，复核深挖后**两个都不是"平台差异无需管"**：

- `test-process-constants-noatime.js`——vendored `common.isLinux` 是 `process.platform === 'linux'`，openharmony 不算，测试走了"该常量不应存在"的 else 分支，**断言方向本身就是错的**。改 `common/index.js`（OHOS 即 Linux 内核，本仓库 `test/harness.ts` 早就这么判定）修复，`5fb7cf366`，A/B 实测 11/7→14/4 零回归。
- `test-process-getgroups.js`——**bun 的 `process.getgroups()` 实现就是错的**（对所有平台）：Node 文档明确"POSIX 未规定是否含有效 gid，Node 保证包含"，bun 直接返回裸 `getgroups(2)`（仅附加组）。OHOS 上 egid `20020101` 不在附加组列表，与 `id -G` 必然不等。修 `src/jsc/bindings/BunProcess.cpp`（缺失时追加 egid，**平台无关修复**），`35eaf7a0e`，**已真机验证**：getgroups 返回 `[1006,1007,1097,3009,3099,20020101]`（含 egid），与 `id -G` 一致，vendored 测试通过。

分类 E，层级 n/a，状态：保留（仅列出的 3 个；trace-events 两个尚未单独深挖，rlimit 的见下方独立条目）。

---

## T20 — 已知 flaky/quarantine 条目，复核仍成立

| 文件 | expectations.txt 里的既有理由 |
|---|---|
| `test/cli/install/bun-install-security-provider.test.ts` | "1/43 tests: large-payload IPC pipe fails on OHOS" |
| `test/cli/run/multi-run.test.ts` | "parallel output-formatting / pre-post / pipe tests timeout (spawn overhead)" |
| `test/js/bun/shell/bunshell.test.ts`（`ls`/`node_modules` 子用例）| "shell load > immediate exit; bunshell ls/rm > node_modules (spawn + hmdfs)" |
| `test/js/bun/shell/commands/ls.test.ts` | 同上（90s 超时,`recursive > node_modules`）|
| `test/js/bun/shell/shell-load.test.ts` | 同上（90s 超时,`immediate exit`）|

分类 E，层级 n/a，状态：保留。注意 `bunshell.test.ts` 本轮还有一个**不属于**这条已知理由的新失败（见 T21）。

---

## T21 — F 类：未深挖的单点/长尾问题

### 修复后批量复测（18 个文件，`7f42ebc2d`）：3 个真转绿，1 个差点误判

| 文件 | 结果 | 归因（二分中间版本确认）|
|---|---|---|
| `cli/run/run-quote.test.ts` | ✅ 3/3 稳定通过（6 pass）| T01 版（`e39db04d6`）即已通过 → **T01 getcwd 修复**的连带受益 |
| `test/js/node/test/sequential/test-stream2-stderr-sync.js` | ✅ 3/3 稳定通过 | T01 版 2/2 失败、T04 版（`3bc00b9e7`）2/2 通过 → **T04 statx-on-socket 修复**。证实了台账里"libuv fd 类型识别 gap"的猜测，具体根因就是 `fstat` 对 socket fd 报 EBADF |
| `test/js/node/test/parallel/test-fs-write-sigxfsz.js` | ✅ 3/3 稳定通过 | rlimit 那一轮的 test 层改动（mksh `ulimit` no-op → 改用 `/usr/bin/zsh`）+ rust 层 `adjust_ulimit` EPERM 回退 |
| `test/js/node/net/node-net.test.ts` | ❌ **未转绿** | 见下 |

**`node-net.test.ts` 差点被记成转绿，是自己的数据把它拦下来的**：首轮单跑显示 61 pass / 0 fail，看着像被某个修复顺带解决了。二分归因时一路回溯到 `bun-rlimit`（`b6e5798e5`）都还失败，本来要把功劳记给其间的 T03 —— 但 T03 是 PTY 修复，跟网络测试八竿子打不着，这个不合理迫使我回头做重复性验证：`bun-rlimit` 跑 3 次得到 **0/1/1** 失败，`bun-t03-clean` 跑 3 次得到 **1/1/1**。真相是这个文件本身摇摆，首轮那次"通过"只是运气好。

**方法论教训（第二次踩同一类坑）**：单次运行不足以判定"转绿"，必须重复。T03 那轮"失败项每次都在换"已经提示过摇摆的存在，这次仍然差点上当。凡是宣布转绿的，本节一律给 3/3 的重复证据；归因不合常理时（修复域与测试域无关）优先怀疑自己的测量，而不是编一个因果故事。

### 回归检查（T26/T28 都改了 spawn 路径，`js/bun/spawn` + `cli/run` 共 87 个文件逐个单跑）

**零回归。** 失败项全部是 pre-existing 或已知长尾：

| 文件 | 判定 |
|---|---|
| `spawn-pipe-leak.test.ts` | **并发摇摆，不是回归** —— batch 里失败 1 次；单跑修复后 4/4 通过、修复前 2/2 通过 |
| `spawn.test.ts` | **不是失败** —— 我回归脚本的 100s 超时太短；单独跑 134+135 pass / 0 fail |
| `spawn-pipe-read-error-leak.test.ts`、`spawn_waiter_thread.test.ts` | T21 已知长尾 |
| `glob-on-fuse.test.ts`、`run-file-on-fuse.test.ts` | T12 FUSE 不可用（class B）|
| `multi-run.test.ts` | pre-existing（修复前同样失败、同一用例），新记入下表 |

`spawn-pipe-leak` 这一条再次印证前面的教训：batch 环境下的单次失败不足以判定回归，必须单跑复现。

### T29 — OHOS 内核 `splice()` 在源端 EOF 时返回 EPIPE 而非 0（平台限制，class B）

`multi-run.test.ts` 的 `scripts with pipes work` 失败，追到底是内核缺陷，**与 bun 无关**。

复现（script 是 `echo "hello world" | cat`）：

```
bun run piped              -> hello world                 exit=0  ✅
bun run --parallel piped   -> piped | hello world
                              piped | cat: -: Broken pipe
                              piped | Exited with code 1   exit=1 ❌   (4/4 稳定)
```

`--parallel` 要给每行加 `piped |` 前缀，于是 script 的 stdout 变成管道。GNU coreutils 的 `cat` 一旦发现 stdin 和 stdout 都是 pipe 就切到 `splice()` 零拷贝路径（经一个自建的中转 pipe）。同时挂 trace-shim 和 compat-shim 拿到的调用序列：

```
splice(in=0, out=6, len=524288) = 12            stdin -> 中转 pipe
splice(in=5, out=1, len=524288) = 12            中转 pipe -> stdout
splice(in=0, out=6, len=524288) = -1 errno=32   stdin 已 EOF -> EPIPE
```

独立 C 探针（完全脱离 bun 和 cat）确认这是内核行为：

| 操作 | OHOS | Linux 语义 |
|---|---|---|
| `splice()` 源端有数据 | 返回字节数 ✅ | 同 |
| `splice()` 源端 EOF | **-1 / EPIPE** ❌ | **0** |
| 同一个耗尽 pipe 上 `read()` | 0 ✅ | 同 |

`read()` 正确报 EOF，只有 `splice()` 把 EOF 报成错误。GNU cat 于是打印 `cat: -: Broken pipe`（`-` 是 stdin 的显示名，errno 32 就是 "Broken pipe"）并 exit 1。

**影响面远大于这一个测试**：任何用 splice 做拷贝循环的程序（GNU coreutils 的 cat/cp、多种 I/O 库）在本机都会在 EOF 处误报错误。bun 只是因为 `--parallel` 把 stdout 接成管道，才让 cat 走上这条路径。归 class B，测试侧无需改动。

#### 已修：ohos-compat-shim 加了 splice 拦截器（`63715bb`）

内核改不了，但 ohos-compat-shim 本来就是补这类缺口的（它已在拦 `getcwd`/`linkat`/`tmpfile` 等）。在那里加了 `splice` 拦截器：只在 `splice()` 已经返回 EPIPE 时介入，用 `poll()`（无损，不像 `read()` 会吃掉待搬运的字节）区分两种情况 ——

| 情形 | `poll(fd_in)` | `poll(fd_out)` | 处理 |
|---|---|---|---|
| 源端 EOF（内核 bug）| `POLLIN\|POLLHUP` | `POLLOUT` | 改写为 `0` |
| 目标端损坏（真 EPIPE）| `POLLIN` | `POLLOUT\|POLLERR` | 原样透传 |
| 两者同时 | `POLLIN\|POLLHUP` | `POLLOUT\|POLLERR` | 透传（先查目标端，歧义时倒向真错误）|

先查目标端是刻意的：把一个恰好也 EOF 的坏管道报成错误没有损失，吞掉一个真 EPIPE 却会让拷贝静默少写数据。EOF 的判据是 `POLLHUP` 而非"没有 `POLLIN`"—— EOF 的 pipe 上 `POLLIN` 同样置位。

验证：compat-shim 功能测试 **ALL PASS (0/34)**，其中新增的 `splice_eof_is_zero` 在 baseline（无 shim）段**故意失败**、shimmed 段通过，等于把这个内核缺陷本身变成了常驻探针；`splice_real_epipe_preserved` 两段都通过，防止将来有人把真错误也吞掉。端到端：`bun run --parallel piped` 从 6/6 报错变成 **0/6**，`cli/run/multi-run.test.ts` 从稳定失败变成 **0 fail**。

顺带发现该内核的 `splice()` 还有第二个毛病：**对空管道无限阻塞，无视 `O_NONBLOCK` 和 `SPLICE_F_NONBLOCK`**。它不返回 EPIPE 所以碰不到上面的分支，未处理，但它排除了"用非阻塞探测来做修复"这条路。

**已发布并装机**：`ohos-compat-shim` 0.2.0 → **0.2.1**（repin `63715bb`），tap PR [#86](https://github.com/social4hyq/homebrew-core/pull/86) 已合并，CI 构建 bottle（tag `ohos-compat-shim-v0.2.1-r1`）并自动回写、automerge 链跑通，本机已 `brew upgrade` 到位。

用**生产版** shim（不再是本地构建）复验，全部通过：

| 验证 | 结果 |
|---|---|
| 内核缺陷探针 `splice #2 (source at EOF)` | 返回 **0**（修复前 -1/EPIPE）|
| 真 EPIPE 场景 | 仍报 `-1 Broken pipe`（未被吞）|
| `bun run --parallel piped` | 6 次 **0 次**报错 |
| `cli/run/multi-run.test.ts`（`--ignore-expectations`）| 0 fail |
| 同上，**不带** `--ignore-expectations`（正常 CI 口径）×3 | **3/3 全 0 fail** |

据此从 `test/expectations.txt` 移除 `multi-run.test.ts` 条目（**51 → 50** 条 `[ OPENHARMONY ]`）。

#### 追查续：bun 自身**不**受影响（推断已证伪），但顺带挖出一个上游缺陷

先前记的"bun 也调 `libc::splice`（`copy_file.rs:383`，仅 FIFO→FIFO 启用），可能同样踩坑"是**推断，现已证伪**。绕开阻塞点后实测四个场景 —— 200000 / 0 / 4096 / 8192 字节 —— **全部正确、数据完整、无报错**。原因在循环结构：

```rust
if unknown_size { remain = 4096; }        // 长度未知时只要 4096
...
if written == 0 || remain == 0 { break; } // 搬满即退出
```

搬满 4096 就 `remain == 0` 退出，**结构上永远不会调用到源端 EOF 的那一次**，所以碰不到 EPIPE。此前实验里那几行 `cat: out: Broken pipe` 全部来自测试脚本自己的 `cat`（用的是尚未更新的生产版 shim），不是 bun。**结论：compat-shim 一处修复即可，bun 不需要改。**

**但挡住这次验证的东西是个真实的上游缺陷（未修，见下）**：`Bun.write(Bun.file(fifoA), Bun.file(fifoB))` 必定报 `Non-regular files aren't supported yet`，而代码里明明有 FIFO→FIFO 分支、注释还写明场景是 `bun run foo.js | bun run bar.js`。两个分支不对称：

```rust
// REG→REG   ：有 mode == 0 兜底
if ISREG(stat.st_mode) && (ISREG(dest.mode) || dest.mode == 0)
// FIFO→FIFO ：没有
if ISFIFO(stat.st_mode) && ISFIFO(dest.mode)
```

`stat` 是源的（当场 `fstat(source_fd)`），而 `dest.mode` 取自 File store，由 `resolve_file_stat()` **惰性**填充 —— 它只在 JS 访问 `.size`/`.lastModified` 时才跑，`Bun.write` 全程不碰。于是 `dest.mode` 恒为 0：REG 路径靠兜底照常工作，FIFO 路径直接掉进"所有分支都不匹配"的兜底报错。实证：先 `void dst.size` 强制 resolve 一下，同一段代码立刻正常搬运。

平台无辜 —— C 探针确认 `stat`/`lstat`/`fstat`/`statx` 对 FIFO 全部正确返回 `010644`。代码出自上游 `23427dbc1 (Rewrite Bun in Rust #30412)`，**非 OHOS 改动，所有平台都有**。

**本轮不修**，理由：不影响任何现有测试（涉及 FIFO 的 `bun-serve-file`、`file-io` 均 0 fail），且更合适的归宿是提 upstream PR 而不是留在 fork 里。修法很直接：判断前对已打开的 `destination_fd` 做一次 `fstat`，别信那个通常还是 0 的 store mode，`dest.mode == 0` 保留作 fstat 失败的后备。

#### 这条的排查过程值得留档：连续 8 个假设被证伪

| # | 假设 | 怎么倒的 |
|---|---|---|
| 1 | 与 `spawn-pipe-read-error-leak` 同根因（都是 cat + Broken pipe）| 读测试代码：那个用例是**故意** dup2 制造 EBADF 来测泄漏，Broken pipe 是人为破坏的副产品 |
| 2 | toybox cat 的行为 | `cat` 其实是 brew 的 GNU coreutils 9.11 |
| 3 | bun 用 socketpair 而非 pipe 导致 | C 探针：socketpair 下同样正常 |
| 4 | OHOS 不产生 SIGPIPE，只给 EPIPE | C 探针：pipe 和 socketpair 写关闭读端**都**正确产生 SIGPIPE |
| 5 | bun 把 SIGPIPE 设成 SIG_IGN 并继承给子进程 | 读 `/proc/self/status`：bun 子进程与纯 `/bin/sh` 的 SigIgn 完全一致，且不含 SIGPIPE |
| 6 | 是 Bun Shell 的 builtin cat 在报错 | `Builtin.rs:196` 写着 `posix_disabled: [Cat, Cp]` |
| 7 | bash 的 double close 搞坏了 fd | 那是 bash 的常规模式，第二次 EBADF 无害 |
| 8 | **纯 shell 也能复现，ohos-compat-shim 才是根因** | **12 次复测 0 次复现** —— 见下 |

第 8 条是这轮最严重的一次失误。我看到 `echo x \| cat \| cat` 报了一次错，就据此построил了一整张 "GNU cat vs toybox cat" 的四象限表格，还得出"禁用 compat-shim 任一拦截器即可修复"的结论 —— 而那七行"禁用后干净"其实只是问题没在那一次出现。补做复现率统计才看清：纯 shell **0/12**，bun `--parallel` **8/8**。那张表格整个是噪音。

**教训**：我在本轮早些时候刚因为 `node-net`（误判转绿）和 `spawn-pipe-leak`（误判回归）两次强调过"单次运行不足以判定"，紧接着在这里又犯了同一个错，而且这次是在单次观测之上叠了五六层推论。**凡是要写进结论的对照实验，先给复现率，再谈机制。** 后面九成的时间都花在推翻自己前面几步上，如果一开始就先跑 10 次基线，能省掉整条弯路。

余下 14 个文件复测后仍失败，维持原状。逐个独立，尚未查根因，按文件列出，后续 triage 从这里挑：

| 文件 | 症状摘要 |
|---|---|
| `test/js/bun/shell/bunshell.test.ts`（另一子用例）| `stdin redirect from a Uint8Array sends the bytes captured when the command starts` |
| `test/js/bun/resolve/resolver-permission-denied-ancestor.test.ts` | "errors on the requested directory itself stay fatal" 断言不符 |
| `test/js/bun/util/filesink.test.ts` | backpressured `write()` 后 `end()` 的 promise 未按预期 resolve |
| `test/cli/run/run-quote.test.ts` | "should handle quote escapes" |
| `test/cli/install/symlink-path-traversal.test.ts` | "does not change permissions of a file reached through a symlinked bin target" — 可能是真实 chmod-through-symlink 逻辑或 OHOS 权限模型差异 |
| `test/cli/install/migrate-bun-lockb-v2.test.ts` | lockfile 迁移快照不匹配 |
| `test/cli/install/bun-install-registry.test.ts` | `prereleases-3 should fail` 系列（3 个子用例，`assertManifestsPopulated`）|
| `test/cli/install/bun-security-scanner-matrix-with-node-modules.test.ts` | 矩阵测试若干组合失败（linker=hoisted/isolated × scanner=npm 等）|
| `test/js/node/child_process/child_process.test.ts` | `it accepts stdio passthrough` 90s 超时（历史记录过已调宽预算,这次又顶格）|
| `test/js/node/dns/node-dns.test.js` | `dns.resolvePtr (ptr.socketify.dev)` → `ENOTFOUND` |
| `test/js/node/fs/fs-oom.test.ts` | `memfd_create`+`readFileSync` 交互报 `EACCES` 而非预期 `ENOMEM`（已确认不是 stale quarantine,是真实平台差异，见下方 T22）|
| `test/js/node/http2/node-http2.test.js` | "http2 server with minimal maxSessionMemory handles multiple requests" 15s 超时 |
| `test/js/node/net/node-net.test.ts` | "should trigger error when aborted even if connection failed #13126" |
| `test/js/node/process/process.test.js` | "should be the node version on the host that we expect" |
| `test/js/node/test/parallel/test-child-process-exec-timeout-expire.js` | 未深挖 |
| `test/js/node/test/sequential/test-child-process-execsync.js` | `execSync should throw` / 计时断言 |
| `test/js/node/test/sequential/test-stream2-stderr-sync.js` | 历史记录过：libuv fd 类型识别 gap（`new net.Socket({fd})` 包裹继承 stdio）|
| `test/js/node/test/parallel/test-fs-write-sigxfsz.js` | 疑似与历史记录的"OHOS rlimit FSIZE 不产生 EFBIG"同根因,未核实 |
| `test/js/web/fetch/fetch-tls-abortsignal-timeout.test.ts` | `AbortSignal.timeout(0/1/10/20)` 超紧时间断言,这台环境 TLS 握手延迟可能超出 |
| `test/js/web/fetch/fetch.unix.test.ts` | 相对路径 unix socket `EPERM: operation not permitted, listen`（疑似 hmdfs 对 bind() 特殊文件的限制,类似已知的硬链接/AF_UNIX 坑）|
| `test/js/web/workers/message-port-context-destroy-leak.test.ts` | 历史记录过的 F 类长尾（MessagePort 泄漏）|
| `test/js/third_party/body-parser/express-memory-leak.test.ts` | 历史记录过的 F 类长尾,20s 超时未变 |
| `test/js/third_party/pnpm/pnpm.test.ts` | "successfully traverses pnpm-generated install directory" |
| `test/js/bun/test/parallel/test-integration-rspack.ts` | 跑 `create-rsbuild` 模板 + `bun install`,超时（可能是 T14 网络类,未核实）|
| `test/js/node/test/parallel/test-net-autoselectfamily.js` | `afterConnectMultiple`/`afterConnect` 路径抛错（Happy Eyeballs 双栈连接逻辑）|
| `test/js/node/test/parallel/test-net-error-twice.js` | `assert.strictEqual(0, 1)` — 错误只应触发一次的断言,实际触发次数不对 |
| `test/regression/issue/07500/07500.test.ts` | `Bun.stdin.text() doesn't read all data`,100s 超时 |
| `test/regression/issue/24364.test.ts` | `react-tailwind template passes tsc --noEmit`（可能依赖 T14 网络类模板拉取,未核实）|
| `test/js/bun/spawn/spawn-pipe-read-error-leak.test.ts` | T04 复核确认非同根因：`cat` 读坏掉的 FIFO 时产生的 `Broken pipe` stderr 输出未被吞掉/预期到,导致断言的空数组不成立 |
| `test/js/node/test/parallel/test-fs-link.js` + `test/js/node/test/parallel/test-fs-promises.js` | **已修复并真机验证（ade348ec6）**：OHOS 内核拒绝裸 SYS_linkat（EACCES），硬链接唯一可用途径是 ohos-compat-shim 对 linkat libc 符号的拦截（EACCES→字节拷贝回退）。musl 把 link() 实现为直发裸 SYS_linkat，绕过符号拦截；而 node_fs.rs::link() 又直接调 libc::link()，完全碰不到拦截器。改走 libc::linkat(AT_FDCWD,...)（语义等价）。第一轮修错了函数（改了无人走的 sys::link()，18 分钟重编白烧） |
| `test/js/bun/spawn/spawn_waiter_thread.test.ts` | T04 复核确认非同根因：issue #9404 的 `resourceUsage().cpuTime.total` 阈值断言,真机实测比 `750_000n` 阈值高约 83%（`1374480n`），疑似 waiter 线程 CPU 时间统计口径与阈值假设不匹配 |

---

## T24 — `ReadFile` 读循环被多个 worker 线程并发执行，大 buffer 随机丢数据 + 大 payload 必崩（**已修复并真机验证**，`04518175b`）

`test/js/bun/spawn/spawn-stdin-large-buffer.test.ts`（阈值 1MB~2MB 之间开始出现,文件自带注释猜的方向是错的）复核后，用脱离测试框架的最小复现脚本 + 改造过的 `ohos-trace-shim` 做 syscall 级追踪，**推翻了最初"写端过早关闭/write 返回 0 被误判 EOF"的假设**，定位到真正的机制在**子进程读 stdin 的一侧**。

### 排查历程（关键转折点）

1. **确认是真正的 race，不是确定性阈值**：同一个 1280KB 输入连续跑 8 次，结果是 `131072`/`1310720`(完整!)/`196864`/`1245184`/`1113856`/`196864`/`1310720`(完整!)/`0`/`0`——有时完全正确,有时部分丢失,有时收到 `0` 字节。排除了"固定 buffer 容量硬限制"的假设。
2. **排除了 `pwritev2`/`RWF_NOWAIT` 路径**：`BUN_FEATURE_FLAG_DISABLE_RWF_NONBLOCK=1` 复现率不变。独立 C 程序验证：非阻塞 pipe fd 写满后 `write()` 正确返回 `-1/EAGAIN`（不是 `0`）；`pwritev2(RWF_NOWAIT)` 在这台设备上对 pipe fd 第一次调用就 `ESPIPE`（走 fallback，和上面结论一致）。`write()`/`pwritev2` 本身语义标准，原始"write 返回 0"猜测已证伪。
3. **`ohos-trace-shim` 第一轮追踪（`fd,proc,raw` 组）扑空**：bun 的 `write()`/`read()` 在 Linux/OHOS 上通过 `src/sys/linux_syscall.rs` 走 **rustix 的 `linux_raw` 后端**（内联汇编直接发系统调用，从不经过任何动态链接的 libc 符号）——这正是该工具自己文档里写明的已知局限（"Bun's rustix linux_raw backend... never touches a dynamically-linked libc symbol"）。8 次追踪运行里所有 `write()` 都只有 8 字节（事件循环唤醒用的 eventfd 写入），从未出现兆字节级的 stdin 写入，证实这条路径确实不可见。
4. **关键突破：stdio 在这个平台上全部是 `socketpair`，不是 pipe(2)**——`src/spawn_sys/spawn_process.rs:812-826`：`PosixStdio::Buffer`（`"pipe"` stdio 的实现）统一用 `socketpair(AF_UNIX, SOCK_STREAM, 0, ...)`，**所有平台都这样，不是 OHOS 专属 fallback**。socket 路径的读写走 `sys::send_non_block`/`sys::recv_non_block`（`src/sys/lib.rs` 里 `sys_send`/`sys_recv` 直接调用 **`libc::send`/`libc::recv`**，不是 rustix）——这两个函数**没有**走 rustix，是真正可以被 LD_PRELOAD 拦截的！
5. **给 `ohos-trace-shim` 加装 `send`/`recv` 拦截**（原来的 `net` 组只包了 `sendto`/`recvfrom`/`sendmsg`/`recvmsg`，漏了最基础的 `send`/`recv`）,重新编译签名,重新追踪,同时抓到一次"好"（完整 1310720）和三次"坏"（截断 196864）的运行。

### 追踪结果（决定性证据）

**父进程（driver）视角**：`send(13, n=1310720, ...)` 起手，经过若干次 `EAGAIN` 重试穿插子进程的 `recv()` 排空缓冲区，**最终把全部 1,310,720 字节成功发送完毕**（逐条 `send()` 返回值相加 = 1,310,720，完全正确，没有任何异常）。

**子进程（reader）视角——这才是真正出问题的地方**：把"坏"运行里子进程对 `fd 0` 的全部 `recv()` 调用返回值相加，同样等于 **1,310,720**（全部数据确实通过 socket 到达了子进程内核缓冲区并被 `recv()` 取走）。但测试报告的 `bytes.length` 却只有 `196864`。**数据在传输层完整无损，丢失发生在子进程把收到的字节组装进最终 `ArrayBuffer` 的逻辑里。**

决定性的一条线索：对比"好"运行和"坏"运行里子进程对 `fd 0` 调 `recv()` 的线程号——

- 好运行：全程只有 **一个** `tid` 调用 `recv(0, ...)`。
- 坏运行：出现 **两个不同的 `tid`** 交替调用 `recv(0, ...)`（例如 `tid=15833` 和 `tid=15834`）。

即：**在坏的运行里，两个操作系统线程同时对同一个 stdin fd 调用 `recv()`。** `Bun.stdin.arrayBuffer()` 的读取实现（`src/runtime/webcore/blob/read_file.rs` 的 `ReadFile`）显然假设只有一个线程在跑这段读循环、往同一个 `self.buffer`/`self.read_off` 累加——一旦两个线程同时进场，谁的分片先到、`buffer.extend_from_slice`/`commit_spare` 的顺序、最终 `on_finish()` 判定"读完了"的时机全部失去保证，观测到的"随机丢失不同数量的字节"正是这种无同步并发访问的典型症状。

### 根因确认（第二轮容器重编 + Rust 层插桩，`f75eba150`）

给 `ReadFile` 加了 env-gated（`BUN_OHOS_T24_DEBUG=1`）插桩：一个全局 `Mutex<Vec<usize>>` 记录哪些 `ReadFile` 实例当前有 `do_read_loop` 在跑（按实例地址索引），`on_ready()` 和 `do_read_loop` 入口各打一条日志。**假设被 100% 证实**，日志直接给出：

```
[tid=2] [ReadFile::run_async_with_fd -> do_read_loop (immediately readable)]
[tid=2] enter do_read_loop for ReadFile@0x5bbab70600
[tid=2] exit  do_read_loop for ReadFile@0x5bbab70600
[tid=4] on_ready() for ReadFile@0x5bbab70600      ← IO Watcher 线程连发约 50 次
[tid=4] on_ready() ... （×50）
[tid=5] enter do_read_loop for ReadFile@0x5bbab70600
[tid=3] *** CONCURRENT RE-ENTRY into do_read_loop -- already in flight! ***
[tid=4] on_ready() ... -- ALREADY IN FLIGHT, scheduling a concurrent do_read_loop run!
[tid=2] *** CONCURRENT RE-ENTRY ***
[tid=6] *** CONCURRENT RE-ENTRY ***
```

第二次运行里更夸张，**tid 2/3/5/6/7/8/9 共 6 个 worker 线程同时在同一个 `ReadFile` 实例上跑 `do_read_loop`**。

机制完全清楚了：`on_ready()`（`src/io/lib.rs::IoRequestLoop::tick_epoll()` 所在的专用 IO Watcher 线程调用）**无条件** `WorkPool::schedule(&raw mut self.task)`，没有任何"是否已经有 worker 在跑这个 `ReadFile` 的读循环"的检查（`self.state` 那个 `AtomicU8` 只表示 `Running`/`Closing`，不是 in-flight 锁）。第一次 `do_read_loop` 退出后 IO 线程连发几十次 `on_ready`，每次都排一个新任务，多个 worker 同时抢到并进入同一个读循环，各自 `recv()` 同一个 fd、各自往同一个 `self.buffer`/`read_off` 追加——完全无同步。之前怀疑的 `EPOLLONESHOT` 并不能挡住这个，因为问题不在于单次事件被重复投递，而在于**每一次合法的可读事件都会无条件再排一个并发任务**。

### 修复（`04518175b`，**已真机验证通过**）

给 `ReadFile` 加 `read_loop_state: AtomicU8` 三态所有权握手：

- `IDLE` → 没有 worker 拥有读循环
- `RUNNING` → 某个 worker 已排队/正在跑
- `RUNNING_PENDING` → 同上，且跑的期间又来了可读唤醒（不能丢）

`on_ready()` 只在 CAS `IDLE→RUNNING` 成功时才 `schedule`；跑的期间来的唤醒把状态推到 `RUNNING_PENDING` 而不是排并发任务；持有者退出时（`wait_for_readable()` 之后的 early return 处）如果发现是 `RUNNING_PENDING` 就保留所有权再排一次，从而**既不并发也不丢唤醒**。`run_async_with_fd` 里第一次直接调 `do_read_loop` 的路径也先取所有权（因为它一旦 `wait_for_readable()` 武装了 epoll，`on_ready` 就可能并发进来）。`on_finish()` 路径故意保持 `RUNNING` 不释放——读已经结束，本就不该再排任何任务，而且那之后对象可能已被释放，不能再碰。

### 真机验证结果（`04518175b`）

| 验证项 | 修复前 | 修复后 |
|---|---|---|
| 1280KB 最小复现脚本 ×12 次 | `196864`/`1113856`/`1310720`… 随机 | **12/12 全部 `1310720`,`other=0`** |
| 插桩日志 `CONCURRENT RE-ENTRY` | 每次运行数条,最多 6 线程并发 | **0** |
| 插桩日志 `ALREADY IN FLIGHT` | —（旧代码无此路径）| 253 次——**这正是握手在正常工作**：唤醒被正确记账而不是排并发任务 |
| `spawn-stdin-large-buffer.test.ts` | 0 pass / 5 fail | **5 pass / 0 fail** |
| `bun-install-security-provider.test.ts` | 42 pass / 1 fail（100% 必现 SIGSEGV）| **43 pass / 0 fail，连跑 3 次稳定** |

**整个 `js/bun/spawn` 目录回归（45 个文件，跑两遍交叉验证）**：

| 运行 | 通过 | 失败 |
|---|---|---|
| 第一遍 | 44/45 | `spawn-pipe-read-error-leak` |
| 第二遍 | 43/45 | 同上 + `spawn_waiter_thread` |

这两个失败**正是修复前就已归类为「非 T24 同根因」的那两个**（见上面 T04 表格）：`spawn-pipe-read-error-leak` 是 `cat` 读坏掉的 FIFO 时 stderr 未被吞掉,稳定失败；`spawn_waiter_thread` 是 `resourceUsage().cpuTime` 阈值断言,两遍一好一坏,正是时序敏感断言的典型表现。**本次修复零回归**，且 T24 直接相关的文件（`spawn-stdin-large-buffer` 5/5、`spawn-pipe-stale-fd-unregister` 1/1、`spawn.test.ts`）全绿。

**意外收获：那个"确定性 SIGSEGV"其实是同一个 bug。** 之前把它和 T24 的非确定性丢数据分开记录（理由是"一个必现、一个随机，不应假设同源"）——这个谨慎是对的，但结论错了：它们确实是同一个并发缺陷的两种表现。security scanner 那条路径传的 payload 更大、时序更稳定，于是每次都必然踩中同一个并发窗口，表现成确定性崩溃；而 stdin 那条路径的时序更松散，表现成随机截断。修好并发以后两者同时消失。

分类 A（真实 bun 缺陷，**不是** OHOS 平台限制：OHOS 上因为 stdio 走 socketpair 更容易撞见，但竞争本身在 `ReadFile`/`WorkPool` 共享调度逻辑里，与平台无关）,层级 rust,状态：**已修复并真机验证**。

**插桩已移除**（`5c2a44ef9`）。移除后重编的干净版（`5c2a44ef9`）复验：1280KB 复现脚本 ×10 全部完整；`spawn-stdin-large-buffer` 5/5、`bun-install-security-provider` 43/43 —— 与带插桩版本结果一致，确认删除插桩没有影响修复本身。

**改动过的调试工具**：`../Software/ohos-trace-shim` 加了 `send()`/`recv()` 拦截（之前的 `net` 组只包了 `sendto`/`recvfrom`/`sendmsg`/`recvmsg`），已编译签名，这是这次能突破"rustix 不可见"限制的关键——以后排查任何 socketpair-based stdio 的问题都可以复用。

**关联但独立的发现**：`test/cli/install/bun-install-security-provider.test.ts` 的 "Large payload via ipc pipe > handles packages JSON larger than max arg length (>1MB)" 用例传大 JSON（>1MB）给 security scanner 子进程时，**100% 确定性复现 `SIGSEGV`**（连续 3 次隔离单跑,每次都崩,"multiple threads are crashing" 连环崩溃日志）——注意这个是**确定性**崩溃，和上面 T24 的**非确定性**丢数据不是同一种表现（一个必现、一个随机),暂不确定是否同根因,只是触发条件相似（子进程经 pipe/IPC 传大 payload），仍值得放在一起排查但不应假设是同一个 bug。分类 A,层级 rust,状态：待查。

---

## T22 — `fs-oom.test.ts`：memfd + readFileSync 交互差异（复核：不是陈旧 quarantine）

`expectations.txt` 把这个文件标注为"bun:internal-for-testing unavailable"（和下面"陈旧 quarantine 确认"里那批一样的理由），但**放回来复测后确认这条 quarantine 依然成立**——只是理由错了。真实原因：`memfd_create` 产生的 fd 配合 `setSyntheticAllocationLimitForTesting` 后调用 `readFileSync`，OHOS 上报 `EACCES: permission denied, fstat`，而不是预期的 `ENOMEM: not enough memory`。分类 A/B（待定,需要判断是 bun 对 memfd fd 的 fstat 逻辑问题还是 OHOS memfd 实现本身的差异），层级 rust，状态：待查。

---

## T23 — `patchelf --set-interpreter` 在 OHOS 签名后的 bun 二进制上静默失效（Task 14 新发现）

`test/regression/issue/24742.test.ts` 和 `test/regression/issue/29290.test.ts` 都测试 `bun build --compile` 对 NixOS `/nix/store` 风格 `PT_INTERP` 路径的归一化逻辑。两个文件都在**归一化逻辑跑之前**就失败：`patchelf --set-interpreter <fake-nix-path> <copied-bun-binary>` 执行后（`stderr === ""`、`exitCode === 0`，patchelf 自认为成功），紧接着 `readInterp(readHead(patchedBinary))` 读回的 `PT_INTERP` 字符串是空的 `""`，而不是 patchelf 刚写入的伪 nix 路径。

### 现状（未深挖，Task 14 只是发现并记录）

- 两个测试用同一段 helper（`readInterp`/`readHead`/`patchelf --set-interpreter`），失败点一致，判定同根因。
- 尚未确认是：① OHOS bun 二进制自带的 CodeSign 段（LLD `--code-sign` patch + `binary-sign-tool` 双重签名）让 `patchelf` 认为程序头有效但实际写入位置不对；② 这台设备 `/data/service/hnp/bin/patchelf` 版本本身在处理这类 ELF 时有 bug；③ 别的原因。三种可能都还没验证。
- 不影响生产使用——这是"NixOS 主机把 bun 自身的 PT_INTERP 改写成 nix store 路径，bun build --compile 复制这个改写过的二进制时应该把路径转回标准 FHS 路径"的边缘功能测试，这台设备既不是 NixOS 也不会真的触发这个场景，所以是低优先级。
- 分类 A（可能是真实平台交互 bug）或 C（可能是测试 helper 对签名二进制的假设不成立），层级 rust 或 test，状态：待查。

---

## 陈旧 quarantine 确认（class E → 待删除，全部实测通过）

以下 `[ OPENHARMONY ]` 条目在本轮 `--ignore-expectations` 全量+隔离复测中**全部通过**，理由（"bun:internal-for-testing unavailable in release build"）已被证伪——`scripts/runner.node.mjs` 的 `spawnBun()` 本来就同时设置了 `BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING=1` 和 `BUN_GARBAGE_COLLECTOR_LEVEL=1`（后者是前者在 Rust 侧生效的必要条件，`src/jsc/VirtualMachine.rs:3247` 的判断嵌套在 `BUN_GARBAGE_COLLECTOR_LEVEL` 的 `if let` 里），这两个环境变量任何时候只要走真实 runner 就会同时具备。当年的"不可用"结论大概率来自裸 `bun test` 复测（漏掉这两个 env）。

```
test/internal/bindgen.test.ts
test/internal/fifo.test.ts
test/internal/highlighter.test.ts
test/internal/linear-fifo.test.ts
test/internal/powershell-escape.test.ts
test/internal/sigaction-layout.test.ts
test/napi/napi-value-ffi.test.ts
test/napi/uv.test.ts
test/napi/uv_stub.test.ts
test/napi/node-napi-tests/**（60 个子文件）
```

（`test/js/first_party/ws/ws-syscall-fault.test.ts`、`test/cli/install/architecture-match.test.ts` 等同理由的条目本轮未落在跑的批次里，下一轮验证时一并处理。）

`test/js/node/fs/fs-oom.test.ts` **不在此列**——同样的理由标签，但复核后是真实平台差异（见 T22），保留 quarantine。

---

## 会话状态快照（2026-07-27 更新：Task 14 expectations.txt 核实归类进行中）

**已完成并真机验证的修复（commit 已推送到 `origin/ohos-aarch64`）**：
- `6a5df2ea5`/`e39db04d6` 附近 —— T01（EL2 沙盒 `getcwd()` bug）修复，9/9 文件转绿
- `3bc00b9e7` —— T04（`statx(2)` 对 socket fd 报 EBADF)修复，最小复现脚本确认 `fstatSync(1)` 不再报错;`spawn.test.ts` 135 pass/6 skip/0 fail,28 个失败全转绿
- T15：`path-length.test.ts` 随 T01 修复；`unix-socket-long-path.test.ts` 改判独立小问题(未修)
- T04 同簇 5 文件复核完毕：仅 `spawn-pipe-stale-fd-unregister` 同根因转绿；`spawn_waiter_thread`/`spawn-pipe-read-error-leak`/`spawn-stdin-large-buffer` 非同根因仍失败,已转入 T21；`test-net-socket-constructor` 已是绿色

**Task 14（expectations.txt 核实归类）进行中,本轮已处理 19 条**：
- 删除（陈旧/已修复,共 15 条）：`adapter-env-var-precedence`（tmpdirSync 修复生效）、`error-name-from-libuv`（disproven premise 同款,漏网之鱼）、`FormData`/`text-decoder`（"1 test failure" 语焉不详,隔离单跑 0 fail,是 --parallel 下的假阳性）、`bun-security-scanner-matrix-{with,without}-node-modules`（CI=true 确实有传,理由本身过期）、`inspect`/`hot`（workaround 已生效,隔离单跑全绿）、`17405`/`17294`/`17244`/`prepare-stack-trace-crash`/`18161`/`test-process-stdout-async-iterator`/`03844`/`23022-stack-trace-iterator`/`22353`/`14976`/`ctrl-c`（regression/issue 整批"[Flaky] # N tests"标签隔离单跑全部 0 fail——**关键发现**：这批标签的年代早于"CI 不用 `--parallel`"这个约定,`ohos-full-test.yml` 头部注释明写"Buildkite 自己的 CI 也不用 `--parallel`",隔离单跑（无并发）就是真实 CI 的复现条件,所以这批"Flaky"从一开始就是并发假阳性,不是环境限定的真实降级）
- 修正标签+关联新发现（4 条）：`29290`/`24742`（同根因,新立 **T23**：`patchelf --set-interpreter` 在签名后的 bun 二进制上写入静默失效,`PT_INTERP` 读回空字符串,未深挖）；`24364`（改判为确定性 `Skip`,和 `bun-types.test.ts` 一样是 tsc/tsgo 原生包 OHOS 未发布)；`18239`（改判为确定性 `Failure`,归入 T03 PTY 簇,该表已有此文件）
- **新发现的高价值关联**：`bun-install-security-provider.test.ts` 的 "Large payload via ipc pipe" 用例其实是 100% 复现的 `SIGSEGV`（不是原标签写的 flaky exit 1），和 `spawn-stdin-large-buffer.test.ts` 的数据丢失高度疑似同一个"子进程 pipe 传大 payload"缺陷的两种表现（一个丢数据、一个直接崩），已在两处互相引用，值得合并立项
- 剩余 ~54 条：TLS 证书库缺失、DNS/hosts family:6 gap、RLIMIT 内核默认值差异、docker compose 不可用、FUSE 沙盒拦截、第三方包无 OHOS 原生二进制（sharp/astro/prisma/resvg/canvas/rspack/tsgo）、T03 PTY 簇本轮未逐条重跑——这些都已有扎实的证据链（日期、具体报错、确认过的平台限制），本轮判断不需要逐条重新压测,维持现状

**下一步方向（性价比排序）**：
- **`spawn-stdin-large-buffer.test.ts` + `bun-install-security-provider.test.ts` 合并根因排查**——数据完整性/崩溃问题,现在有两个独立入口都指向"子进程 pipe 传大 payload"，优先级应该提到最高
- Task 14 收尾：剩余 ~54 条如果要继续抠,边际收益已经不高（本轮已经把好摘的果子摘完）,可以考虑就此收口进入 Task 15
- T03（PTY/Terminal）——还没开始摸底根因,现在有 7 个文件（含新发现的 18239）
- T23（patchelf/PT_INTERP）——低优先级,不影响生产场景
- T18（bake dev）——需要产品层面先拍板要不要投入
- Task 15：全部真实修复落地后,做一次最终全量重跑,产出三口径通过率报告,追加进 `OHOS_TEST_STATUS.md`

**环境状态**：容器（`openharmony`）当前安装的是 `3bc00b9e7`（T04 修复版,build-from-source,非正式 bottle）。host 的 harmonybrew tap 本地 formula 文件（`~/.harmonybrew/Homebrew/Library/Taps/social4hyq/homebrew-core/Formula/b/bun.rb`）也指向这个 revision，未提交（这是本地测试用的临时改动,不是正式发布,tap 是独立 git repo,main 受保护）。真机默认 `bun`（`~/.harmonybrew/bin/bun`）**仍然是修复前的旧版本**——本轮所有验证都是用 `docker cp` 取出的独立二进制文件跑,没有替换真机默认安装。Task 14 的验证全部用真机默认 `bun`（旧版本）跑,因为涉及的都是 test 层判断,和 T01/T04 的 rust 修复无关。

---

## 下一轮优先级建议

1. ~~T01~~ —— **已修复并真机验证**（`e39db04d6`，9/9 文件转绿）。陈旧 quarantine 已清（class E 11 个文件删除）。
2. ~~T15~~ —— **已复查完毕**：`path-length.test.ts` 随 T01 一起修复（连带副作用,6/6 转绿）；`unix-socket-long-path.test.ts` 改判为独立的测试算术脆弱（class C，低成本 test 层修复,未动手）。
3. ~~T04~~ —— **已修复并真机验证**（`3bc00b9e7`，`statx(2)` 对 socket fd 报 EBADF 未降级到 `fstat`，`spawn.test.ts` close handling 64/64 转绿）。同簇 5 文件复核完毕：仅 `spawn-pipe-stale-fd-unregister` 同根因转绿，其余 4 个（`spawn_waiter_thread`/`spawn-pipe-read-error-leak`/`spawn-stdin-large-buffer` 仍失败但非同根因已转入 T21；`test-net-socket-constructor` 已是绿色）。
4. **Task 14（expectations.txt 剩余条目核实归类）**——纯 test 层，不需要容器重编，性价比最高，建议先做。
5. **`spawn-stdin-large-buffer.test.ts`**——数据完整性问题（大 buffer 丢数据），优先级高于其他长尾单点，值得单独立项深挖。
6. **T03（PTY/Terminal）**——新发现的规模较大的簇,建议先摸底根因（可能一次修复解决 7 个文件）。
7. **T18（bake dev）**——投入产出比需要产品层面先拍板要不要投入。
