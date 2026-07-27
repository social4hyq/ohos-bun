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

## T03 — PTY / TTY：`Bun.Terminal` raw mode 与作业控制（新发现，规模不小）

`terminal-*.test.ts` 是全新文件（历史 `OHOS_TEST_STATUS.md` 里从未出现过 `Bun.Terminal` 相关记录），说明这是本轮首次覆盖到。核心症状：`setRawMode` 抛 `Failed to set raw mode`,以及依赖 raw mode/SIGWINCH/作业控制信号的场景全部超时。`no-orphans.test.ts`/`tty-reopen-after-stdin-eof`/`tui-app-tty-pattern`/`18239` 症状不同但都在 TTY/PTY 子系统,怀疑共享底层 termios/PTY 分配逻辑,值得一起排查。

| 文件 | 症状 | 分类 | 层级 | 状态 |
|---|---|---|---|---|
| `test/js/bun/terminal/terminal.test.ts` | `setRawMode` can enable/disable/toggle 全部抛 `Failed to set raw mode` | A | rust | 待查（根因定位） |
| `test/js/bun/terminal/terminal-spawn.test.ts` | 同样 `Failed to set raw mode`；`exit callback fires after close`/`pipeline producer exit...`超时或挂 | A | rust | 待查 |
| `test/js/bun/terminal/terminal-platform-gaps.test.ts` | `setRawMode is a no-op on Windows` 断言在这台机器上抛错（预期不抛）；`SIGWINCH`/CRLF 用例 90s 超时 | A | rust | 待查 |
| `test/regression/issue/18239/18239.test.ts` | `TTY stdin buffering should work correctly` | A | rust | 待查（可能同根因）|
| `test/regression/issue/tty-reopen-after-stdin-eof.test.ts` | 2 个子用例：reopen `/dev/tty`、`position` for char devices | A | rust | 待查（可能同根因）|
| `test/regression/issue/tui-app-tty-pattern.test.ts` | 读 piped stdin 后 reopen `/dev/tty` | A | rust | 待查（可能同根因）|
| `test/cli/run/no-orphans.test.ts` | Ctrl-Z stop 桥接 + `setsid` 场景 30s 超时（历史记录过 tpgid=0 异常,本轮换了新症状）| A | rust | 待查 |

**建议**：先在容器/真机上单独探测 `ioctl(TIOCSETA/TCSETS)` 或等价 termios 调用在 OHOS 上的行为,这可能是一个共享的、影响面较大的 PTY 层 gap。

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
| `test/js/node/test/parallel/test-fs-link.js` | 未取得具体断言（历史记录归入"E 类 node-vendored 平台差异"）| E | n/a | 复核确认仍失败 |
| `test/js/node/test/parallel/test-fs-promises.js` | 同上 | E | n/a | 复核确认仍失败 |
| `test/js/node/test/parallel/test-fs-stat-date.mjs` | 同上 | E | n/a | 复核确认仍失败 |

---

## T07 — cluster 特权端口绑定 + `getSystemErrorName` 崩溃（发现一个额外的真实 bug）

已知平台限制是"绑定 <1024 端口需 root"（class B），但本轮发现 fork 出的子进程在收到 `EACCES`（errno 13）后，试图把它转成可读错误名时本身就崩了：

```
RangeError: The value of "err" is out of range. It must be a negative integer. Received 13
    at getSystemErrorName (node:util:249:68)
```

这说明 `util.getSystemErrorName`（或它调用的 `makeErrorWithCode`）**期望负数 errno,但这条路径传入的是正数 13**——独立于"需要 root"这个已知限制之外的一个真实 bug，很可能不是 OHOS 专属（值得先在 macOS/Linux 上验证是否通用）。

| 文件 | 分类 | 层级 | 状态 |
|---|---|---|---|
| `test/js/node/test/parallel/test-cluster-bind-privileged-port.js` | A（`getSystemErrorName` 崩溃）+ B（需 root，已知）| rust | 待修（`getSystemErrorName` 正负号问题）|
| `test/js/node/test/parallel/test-cluster-shared-handle-bind-privileged-port.js` | 同上 | rust | 待修 |

---

## T08 — dgram 未深挖

| 文件 | 分类 | 层级 | 状态 |
|---|---|---|---|
| `test/js/node/test/parallel/test-dgram-bind-fd.js` | F | rust? | 待查 |
| `test/js/node/test/parallel/test-dgram-socket-buffer-size.js` | F | rust? | 待查 |

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

## T15 — 深路径 / 长路径缓冲区问题（复查完毕：一个是 T01 的连带受益者，另一个是独立的测试算术问题）

最初怀疑两个文件是同一类"固定缓冲区在深 TMPDIR 下截断"的 Rust bug（类比历史上的 128 字节 shebang 缓冲区 bug）。用 `e39db04d6`（T01 修复后的二进制）复查,结论分岔：

| 文件 | 结论 | 分类 | 层级 | 状态 |
|---|---|---|---|---|
| `test/js/bun/glob/path-length.test.ts` | **已修复（T01 的连带副作用）**：`buildDeepTree()` 用 `Bun.spawn({cmd:["bash",...], cwd: root})` 建深目录树,`root` 落在 EL2——这正是 T01 的触发模式。真机复测（`e39db04d6`）：**6 pass, 0 fail**。之前的失败根本不是"缓冲区溢出",是 T01 的 getcwd 噪音污染了 `buildDeepTree` 内部 bash 循环的 stderr,间接搞乱了后续断言。 | — | — | 已随 T01 一起修复 |
| `test/js/bun/net/unix-socket-long-path.test.ts` | **不是同一类 bug，是测试自身的路径长度算术假设**：`makeSockPath()` 用 `pad = total - 60` 反推需要填多少字节让 `tempDir()` 产出的目录名凑到 `total` 长度,这个"60"是针对其他平台/更浅 TMPDIR 校准的常量。这台环境里 runner 给每个测试文件套了一层 `TMPDIR=.../buntmp-XXXXXX/` 嵌套,实际 `tempDir()` 产出的绝对路径比假设的深,导致 `total=150` 时 `basenameLen = total - dir.length - 1` 算出负数,`Buffer.alloc(-2, ...)` 直接抛 `RangeError`（真机复测确认：`total=108` 正常,`total=150` 才炸)。分类改判 C（测试算术脆弱,不是 Rust 层 bug），层级 test | C | test | 待修（低成本：把硬编码的 padding 常量换成先量出 `tempDir()` 实际长度再反推,而不是假设固定 60）|

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
test/js/node/test/parallel/test-process-constants-noatime.js
test/js/node/test/parallel/test-process-getgroups.js
test/js/node/test/parallel/test-trace-events-fs-async.js
test/js/node/test/parallel/test-trace-events-fs-sync.js
test/js/node/child_process/child-process-rlimit-nofile.test.ts
```

（`test-fs-link.js`/`test-fs-promises.js`/`test-fs-stat-date.mjs` 已并入 T06，避免重复计数）

分类 E，层级 n/a，状态：保留。

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

逐个独立，尚未查根因，按文件列出，后续 triage 从这里挑：

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
| `test/js/bun/spawn/spawn-stdin-large-buffer.test.ts` | **优先级建议提高**：2048/4096/8192 KB 级别 stdin 通过 socketpair 传输给子进程时数据丢失（`spawnSync`/`Bun.spawn` 两条路径都中招,部分组合收到 `0` 字节）。T04 复核时排除了 statx/EBADF 同根因,是独立的数据完整性问题,不是断言脆弱。**Task 14 追加发现**：`test/cli/install/bun-install-security-provider.test.ts` 的 "Large payload via ipc pipe > handles packages JSON larger than max arg length (>1MB)" 用例 100% 复现 `SIGSEGV`（security scanner 子进程收 >1MB JSON 通过 IPC pipe 时崩溃）——症状级别比这里的截断更严重（是崩溃不是丢数据），但触发条件同款（子进程 pipe 传大 payload）,值得合并排查,可能是同一个 pipe 缓冲区处理缺陷的两种表现形式 |
| `test/js/bun/spawn/spawn-pipe-read-error-leak.test.ts` | T04 复核确认非同根因：`cat` 读坏掉的 FIFO 时产生的 `Broken pipe` stderr 输出未被吞掉/预期到,导致断言的空数组不成立 |
| `test/js/bun/spawn/spawn_waiter_thread.test.ts` | T04 复核确认非同根因：issue #9404 的 `resourceUsage().cpuTime.total` 阈值断言,真机实测比 `750_000n` 阈值高约 83%（`1374480n`），疑似 waiter 线程 CPU 时间统计口径与阈值假设不匹配 |
| `test/cli/install/bun-install-security-provider.test.ts` | Task 14 新发现：大 payload (>1MB JSON) 经 IPC pipe 传给 security scanner 子进程时 100% 复现 `SIGSEGV`（"multiple threads are crashing" 连环崩溃日志）。同一簇候选,见上一行 `spawn-stdin-large-buffer.test.ts` |

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
