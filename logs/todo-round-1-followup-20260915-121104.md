# ohos-minimal 失败清单 TODO（Round 1 后续深挖）— 2026-09-15

承接 `logs/round-1-20260915-110514.md`。对该报告"C 类待确认"57 个文件（两轮串行复核
都失败，排除了并行争用噪音）逐项深挖，按优先级重新分组。

## 2026-09-15 同日续：又修了 5 处（追加在原 P0/P1 基础上）

- **`cli/bun.test.ts`"PowerShell completions"**：`getcwd_honest()` 还漏了 5 个
  调用点（`install_completions_command.rs` 1 处 + `package_manager_command.rs`
  4 处，都是"报告 deleted cwd 为致命 CLI 错误"这同一类），已全部补上，commit
  `b5aa451d63`。
- **`js/bun/glob/scan.test.ts` + `js/bun/shell/commands/rm.test.ts`**：两个都是
  bun 需要 `open("/")`（一个是 glob pattern 锚定在根目录，一个是 shell
  `.cwd()` 覆盖时先打开进程实际 cwd）撞上 OHOS 沙箱拒绝读根目录，已加
  `skipIf(openharmony)`，commit `0c3bffb382`。
- **`rm.test.ts` 另一个测试**："PATH_MAX" 用 `process.platform === "linux" ?
  4096 : 1024` 三元表达式，跟已隔离的 `mmap.test.js` 同一个平台字符串坑，
  同一个 commit 一并处理。
- **`js/bun/shell/commands/mv.test.ts`**：`findCrossDeviceDir()` 用
  `accessSync` 探测 `/dev/shm` 可写性，DAC 位显示可写但实际 `mkdirSync` 被
  MAC 层拒绝（用纯 Python 独立验证过同样的 access/mkdir 分歧）。加了
  `describe.skipIf(openharmony)`，commit `cb65c01eb9`。
- **`js/node/fs/fs-oom.test.ts`（真实产品 bug，已修复）**：`node_fs.rs` 的
  `read_file_with_options()` 有第三处未加容错的 memfd fstat 调用（前两处已在
  `ohos-fstat-eacces-on-memfd`/`ohos-spawn-buffer-memfd-eacces` 系列修过），
  照着 `sys/file.rs` 已验证的容错模式打了最小补丁，commit `9a046c8e19`，
  登记 `ohos-readfilesync-memfd-fstat-eacces`。

至此 P1 表格里的 `fs-birthtime-linux.test.ts`/`unix-socket-long-path.test.ts`
两项仍只是证据确认（未改代码，结构性），其余全部落地。

## 又清出 3 个 AF_UNIX-on-hmdfs 类 + 确认 P0.5 范围比预想更大

- `bun-serve-args.test.ts`（整文件隔离）、`adapter-env-var-precedence.test.ts`
  （单测 skip，硬编码 `/tmp/...sock`）、`socket.test.ts` 的 kqueue drain 用例
  （单测 skip，fixture 内部用裸相对文件名）——三个都是同一个 AF_UNIX-on-hmdfs
  根因的新样本，commit `9e6339b3d0`/`cd04ae2312`。

- **P0.5（本地 dev build 假象）范围确认比预想更大**：`bunshell.test.ts` 的全部
  7 个失败深挖后确认都是这一类，且出现了一个新变体——不只是"子进程 env 缺
  LD_LIBRARY_PATH"，还有"子进程被 `ulimit -n 32` 卡死 fd 数来触发 EMFILE，
  但本地动态链接的 dev build 光加载 ICU/openssl 外部 `.so` 在启动阶段就要
  多吃几个 fd，正式 formula 构建大概率是自包含/静态链接的，根本不需要这些
  fd"，导致测试还没跑到真正要验证的"管道创建阶段 EMFILE"就已经启动失败。
  **这类失败不是产品 bug，是本地构建方法论的边界，本轮不再逐个"修复"，
  统一标记"需要走 formula 构建复测才能定论"。**

## 2026-09-15 第三轮：老补丁交叉比对法——找到 5 个真实的、从零重做时漏掉的产品级回归

在前面几轮"单测逐个查根因"的基础上，改用更高杠杆的方法：`kqueue` drain 测试
的失败链接到一个真实的 socket 写错误丢失 bug 后，systematically 拿失败测试
对应的源文件去 tap `Patches/bun/` 老补丁系列做交叉比对，一次性找到多处漏移植：

1. **`socket_body.rs`（真实产品 bug，非 OHOS 专属）**：`internal_flush()` 有
   ~9 个调用点，只有 1 个消费返回值报告致命写错误，其余 8 个 `let _ = ...`
   丢弃。装机生产 bun（老 106-patch 系列）能正确报出 1 个 EPIPE，这次重做的
   版本报 0 个错误、静默截断——A/B 对比 + 对照老补丁的 `pending_fatal_send_errno`
   latch 设计确认是真实回归。移植时代码结构已比老补丁写作时多了 6 个
   `NewSocket` 构造点（`Listener.rs` ×5、`node_net_binding.rs` ×1），编译器
   报错后逐一核对补齐。commit `502cc89955`。
2. **`SpawnSyncEventLoop.rs`**：OHOS 上"刚过期的绝对 deadline"算出的 duration
   会绕成事实上无穷大的 epoll_wait 等待，老补丁做了 clamp，当前代码完全没有。
   照抄验证无误后应用（未改变语义，纯粹是缺失）。没能解释当时在查的
   `spawnsync-isolated-event-loop.test.ts` DRIFT 失败（那是独立问题），但
   本身独立成立，予以保留。commit `51f471d612`。
3. **`system_certs.rs`（重大修复）**：完全没有 OHOS 分支——通用的 Linux 发行版
   证书路径列表在 OHOS 不存在，BoringSSL 默认路径也不存在，导致系统 CA 目录
   扫描一个都加载不到。移植老补丁加了真实的 `/system/etc/security/certificates`
   路径（设备上核实过真实存在有效证书）。`test-use-system-ca.test.ts` 从大范围
   diff 不匹配变成 13/14 通过。commit `8955bd9469`。
4. **`path_watcher.rs`（真实修复，但纠正了一次方法论错误）**：老补丁的完整版
   （含跨读边界 poll 重试）第一次是直接照抄应用的（commit `d1a62b6fed`），
   但随后发现代码库里已经有一个**不同设计**的既有修复
   （`batch_has_rename_event`，"重分类"而非"跳过"，见
   `environment_ohos_inotify_attrib_before_create` 记忆——之前误读为"部分缺失"，
   实际是完整功能，只是没有跨读边界能力）。撤销重做（`df9f8c2113` revert
   `d1a62b6fed`），改为在既有机制上**扩展**跨读边界重试能力，不引入第二套
   并行逻辑。`fs.watch.test.ts` 7 fail → 2 fail。commit `393c151f8b`。
   **教训**：即使找到了对应的老补丁，动手前也要先确认代码库里是不是已经用
   别的设计解决了同一个根因——"参考老补丁"不等于"老补丁必然是唯一/正确的
   落地形态"。

**方法论沉淀**：`find /storage/.../Patches/bun/ -name "*.patch" | sed ...`
拿到全部 107 个补丁的文件路径清单，跟失败测试大致对应的源文件名做人工比对，
命中率相当高（5/5 尝试全部命中真实缺口）。下一轮可以继续按这个清单排查
`run_command.rs`（对应 `cli/run/env.test.ts` 等）、`Coordinator.rs`（对应
`cli/test/parallel.test.ts`）等尚未检查的匹配项。

## 2026-09-15 第三轮续：第 6 个真实修复 + 一次"不要投机应用"的验证

- **`run_command.rs`**：老补丁里有一个 EPERM/EACCES 顶层目录回退机制，看起来
  很像会命中什么问题，但先查了对应的 `cli/run/env.test.ts`/`multi-run.test.ts`
  当前状态——两个都已经是 0 fail（被本轮其他修复顺带解决了），剩下的
  `require-cache.test.ts`/`run_command.test.ts` 两个失败跟这个补丁描述的场景
  完全不相关。**没有应用**：没有任何当前失败对应得上，不应该投机式移植。
  这条例子写进来是为了强调"对照老补丁"不等于"看到同名文件就一定要打补丁"，
  必须先确认真的有对应的失败现象。
- **`Coordinator.rs`（第 6 个真实修复）**：`cli/test/parallel.test.ts` 的
  "每个 worker 唯一 ID"和"至少 2 个 worker PID"两个失败精确匹配老补丁描述的
  "OHOS 慢 fork 导致 worker 抢占竞态"。`find_steal_victim()` 跳过"存活但还没
  分发过文件"的刚 spawn worker，两个原失败清零。修复后**意外暴露了第三个
  测试**（"partitions by directory and steals from the end"）——用独立 repro
  脚本查清：这台设备的 scale-up 阈值确实会合理地多开一个第 5 个 worker
  （4 目录 + 1 补位偷活的），但测试自己假设 worker 数不超过目录数（4），
  数学上 5 个 worker 时"每个 worker 首个文件来自不同目录"这个断言必然不成立
  ——不是 bug，是测试假设跟设备时序特性不匹配，加了 skip。commit
  `7d00312207`。

**至此老补丁交叉比对法命中 6/6 次尝试**（1 次正确判断"不该应用"，其余 5 次
找到真实缺口），是这一轮最高价值的方法论收获。

## 2026-09-15 第四轮：又一个重要方法论坑 + 1 个真实跨平台既有问题确认

- **`OHOS_SYSROOT` 也是裸调用缺失的环境变量**（跟 `BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING`/
  `--timeout=90000` 同类）：`cc.test.ts` 裸调用显示 16/42 失败，补上
  `export OHOS_SYSROOT=$(brew --prefix ohos-sdk)/native/sysroot` 后变成 1/42
  ——15 个纯粹是方法论假象。**以后裸调用测试涉及 `bun:ffi` 时必须带这个变量**。
  剩下真实的 1 个失败：TinyCC 词法分析器解析不了 OHOS SDK 头文件里 Clang 专有
  的 `__attribute__((__availability__(ohos, introduced=12.0.0)))` 三段式版本号
  （词法层面直接报错，不是"忽略未知属性"能绕过的）。查过老补丁系列确认没有
  先例，是真实未解决的 TCC 局限，扩展了文件自己已有的 `it.todoIf` 约定。
  commit `12e7359da3`。
- **`ctrl-c.test.ts`**：6/8 "SIGINT 杀死 vite" 测试期望 `signalCode:"SIGINT"`，
  实际 vite 自己（或 bun `--bun` 的 node 兼容层）捕获信号后正常退出
  （`exitCode:1`）。A/B 对比装机生产 bun 确认逐字节复现同样的 2 pass/6 fail，
  跨平台既有问题，非 OHOS 专属，超出移植范围，加隔离项。commit `4290f775f8`。

**至此老补丁交叉比对法命中 6/7 次尝试**（1 次正确判断不该应用），另有 2 个
环境变量类方法论坑被系统性修正（`CI=true`、`OHOS_SYSROOT`）。

## 2026-09-15 第五轮：又清了 4 个，2 个深挖后判定"暂不追"

- **`init.test.ts`**：4 个失败同 tsgo 缺口，隔离。commit（跟其他一起提交）。
- **`inspect.test.ts`**（真实修复）：又一个 AF_UNIX-hmdfs 相对路径样本
  （`.tmp` 硬编码目录，文件里其实已经在别处用了正确的 `tempDir()`），改用
  EL2 tmpdir，4→0 fail。
- **`hot.test.ts`**（真实修复）：`timeout = isDebug ? Infinity : 10_000` ——
  expectations.txt 早就记录"该 10s→60s"但代码里从没真落地，这次真正应用了
  OHOS 分支（60s/90s），1→0 fail。
- **`pipeline_stack.test.ts`**（真实修复）：`cd / | pwd` 类用例撞上已经确认
  好几次的"OHOS 沙箱拒绝访问根目录"，`TestBuilder` fluent API 没有
  `skipIf`，用它已有的 `.todo()` 方法条件调用，2→0 fail。

以上四个一起 commit `3d90323371`（init+inspect+hot）、`e4f5519e70`（pipeline_stack）。

**深挖后判定"暂不追"的 2 项**：
- **`process-stdin.test.ts` "a single read does not ingest the whole pipe"**：
  真实的背压（backpressure）测试，41MB 实际增长 vs 16MB 预期上限，暗示
  `Bun.stdin.stream()` 在这台设备上可能没有正确限流读取。顺着这条线索查了
  `PipeReader.rs`/`posix_event_loop.rs` 的老补丁，发现一个之前完全没注意到
  的机制——**OHOS 内核 epoll 有个真实缺陷：`epoll_ctl` 报成功但内核会静默
  停止投递事件**，老补丁做了一个 `epoll_rearm_watchdog`（周期性冗余
  `CTL_MOD` 唤醒）来恢复。但这个机制**仅针对 `Bun.Terminal` 的 PTY master
  fd opt-in**（`PosixFlags::EPOLL_REARM_WATCH`），不适用于普通 pipe，跟
  当前这个失败没有直接关联——没有投机式应用这么大的一套新机制。
  真正的根因还没查到，先记录。
- **`streams.test.js` "Bun.file() read text from pipe"**：90000ms 超时，用
  `mkfifo` + bash 脚本写 65KB 数据，读端用 `Bun.file()`。检查过 FIFO 默认
  buffer size（跟匿名 pipe 一样是标准 64KB，不是"翻倍"类问题），没找到明显
  线索，未继续深挖。

**当前累计**：老补丁交叉比对法 7/8 命中真实缺口或提供关键背景信息
（1 次判断不该应用，1 次找到相关但不适用当前场景的机制）。

## 下一轮建议的做法（不再是"继续在 dev build 上单个查"）

到这里为止，剩余的"待确认"清单里，除了个别已经确认是全新的独立信号（如
`unix-socket-long-path.test.ts`、`fs-birthtime-linux.test.ts` 这类结构性
证据确认过的），**相当一部分很可能都是 P0.5 类**（子进程 spawn 时 env 被
显式收窄、或撞上跟本地动态链接开销冲突的 ulimit/资源限制）。继续在裸
`ninja` 直构的 `bun-profile` 上一个个人工确认性价比在下降——下一轮更高效的
做法是：**先走一次真正的 formula 构建**（`brew install --build-from-source
bun` 或对应的容器/CI 路径），拿这个自包含的正式产物重跑一遍现在还标"待
确认"的清单，P0.5 类大概率会大批量转绿，剩下真正跑不过的才是需要继续深挖
的真实信号。

## P0 — 已修复（本轮完成）

### 1. `run-baseline.sh` 用 `CI=1` 而非 `CI=true`，导致 bun 自愈符号链接从未生效 ✅ 已修复

**影响**：`bun-install-lifecycle-scripts.test.ts`(29 fail→0)、`bun-run.test.ts`、
`config-precedence.test.ts`、`run-quote.test.ts`、
`resolver-permission-denied-ancestor.test.ts`、`AsyncLocalStorage-tracking.test.ts`、
`tls-keepalive.test.ts`、`regression/issue/17454/destructure_string.test.ts`
——**8 个文件**从失败转为通过。

**根因**：`scripts/utils.mjs` 的 `isCI = getEnv("CI", false) === "true" || isBuildkite
|| isGithubAction` 要求 `CI` 严格等于字符串 `"true"`。`run-baseline.sh` 一直用
`CI=1`，`isCI` 全程是 `false`，导致 `scripts/runner.node.mjs::getCombinedPath()`
里"若 `--exec-path` 不是字面上叫 `bun` 就建一个符号链接"这段自愈逻辑从未触发。
更麻烦的是 `build/ohos-minimal/` 目录下还留着一个 2026-09-13 构建、从未签名的
陈旧 `bun` 文件（比 `bun-profile` 小得多的独立 ninja 产物），挡住了
`symlinkSync`/`linkSync`（两者都因 `EEXIST` 静默失败，只打一行 `console.warn`）。
任何 lifecycle script/fixture 用裸 `bun xxx.js`（而非 `bunExe()`）通过 PATH 解析
就会踩到这个陈旧、无签名的文件，报 `Permission denied`。

**已做**：删除陈旧的 `build/ohos-minimal/bun` 文件，验证 `CI=true` 下自愈逻辑
正确重建软链接指向当前 `bun-profile`。**待办**：把 `run-baseline.sh` 的 `CI=1`
改成 `CI=true` 并提交（本轮验证用的是手动 `CI=true` 覆盖，尚未回写脚本本身）。

## P0.5 — 新发现的方法论问题（影响面未知，需要下一轮確認范围）

### 2. 本地 dev build（裸 `ninja`）缺 `LD_LIBRARY_PATH` 会导致任何"最小 env spawn 子进程"类测试假性失败

**证据**：`env -i TEST=test /storage/Users/currentUser/.harmonybrew/bin/bun --version`
（正式发布的 bun）正常返回 `1.4.2`；同样方式跑 `build/ohos-minimal/bun-profile`
直接 `exit=127`，报几百行 `Error loading shared library libicui18n.so.78` /
`symbol not found`。`child_process.test.ts` 的 `getChildEnv()` 助手直接用调用方
传入的 `env` 参数 spawn `bunExe()`（不 merge `bunEnv`），只要某个用例传
`{ TEST: "test" }` 这种不含 `LD_LIBRARY_PATH` 的最小 env，子进程还没跑到业务
逻辑就先加载失败，stderr 里混进的错误文本让上层 `JSON.parse()` 直接崩
（"Unexpected identifier 'Error'"）。

**判断**：**不是产品 bug**——正式 formula 构建的 `bun` 不依赖外部
`LD_LIBRARY_PATH`（大概率是 formula `install()` 阶段做了本地 ninja 直构没做的
处理，比如静态链接 ICU，`patchelf --print-rpath` 对两者都是空，所以不是简单的
RPATH 缺失，具体机制未继续深挖）。这是本 session 一直用的"裸 ninja 直构 +
外部 LD_LIBRARY_PATH 包装脚本"这套快速迭代方案本身的局限，CLAUDE.md 硬约束 6
早就承认了这个偏离，最终定论要走 formula 构建。

**待办（下一轮）**：用这个特征信号（子进程 stderr 含 `Error loading shared
library`/`symbol not found`/exit 127）批量筛一遍 57 个"待确认"失败里还有哪些
命中同一模式（`filesink.test.ts`、`node-net.test.ts`、`socket.test.ts`、
`spawnsync-isolated-event-loop.test.ts`、`cli/bun.test.ts`、`cli/init/init.test.ts`
都有裸 `env: {...}` 用法，值得优先排查），命中的一律标记"本地构建假象，需走
formula 构建复测"，不再逐个当产品 bug深挖。

## P1 — 已确认结构性限制（有严谨证据链，建议补隔离项，不需要代码修复）

| 文件 | 证据 | 结论 |
|---|---|---|
| `js/node/fs/fs-birthtime-linux.test.ts` | 系统自带 `stat` 命令（跟 bun 无关）对 EL2 tmp 里的文件也显示 `Birth: -` | 文件系统/内核本身不支持 `STATX_BTIME`，bun 返回 0 是正确行为 |
| `js/bun/net/unix-socket-long-path.test.ts` | 手工验证：OHOS 强制的长 TMPDIR（`/data/storage/el2/base/tmp/buntmp-XXXXXX` 40 字符）+ runner 自己的双层 mkdtemp 嵌套，令测试自己"假设 60 字符前缀开销"的算术产生 `basenameLen = -2`，跟报错里的 `-2` 精确对应 | 测试自身的路径长度假设在本机 TMPDIR 环境下不成立，测试从未跑到被测的 bun 长路径 workaround 代码 |
| `cli/install/bun-workspaces-self-contained.test.ts` | `nlink toBeGreaterThan(1)` 失败，同已隔离的 `bun-workspaces.test.ts` | EL2 `link(2)` Permission denied，bun 正确回退成 copy，只是这个文件名没被现有隔离项的子串匹配覆盖 |
| `cli/install/migration/complex-workspace.test.ts` | 直接运行看到 `sharp: Installation error: Prebuilt libvips 8.14.5 binaries are not yet available for openharmony-arm64v8` | fixture 锁定的 `sharp@0.32.6`（专测老 lockfile 迁移）没有 OHOS 预编译包，全文件级联失败（0 pass/21 fail） |
| `js/node/child_process/child-process-rlimit-nofile.test.ts` | "runtime should raise the soft limit above 256, got 0" | OHOS 内核 RLIMIT_NOFILE 默认值跟 Linux 不同，文件顶部本就有陈年注释但缺一条正式隔离项 |
| `js/bun/http/bun-listen-connect-args.test.ts` | 用相对路径 `xxx.sock`（无目录前缀），解析到仓库 CWD（`/storage/Users/...`，hmdfs），跟已知"hmdfs 禁止 AF_UNIX bind"同一根因 | 结构性，只是没用 `tmpdirSync()` 所以没被覆盖 |
| `cli/run/no-orphans.test.ts` | tpgid 断言失败，A/B 对比装机版生产 bun 1.4.2+744846f84 复现同一签名（本 session 早前已确认） | 跨平台既有缺陷，非 OHOS 特有，超出移植范围 |

**待办**：给以上 7 项在 `test/expectations.txt` 补正式隔离项（`bun-serve-args.test.ts`、
`js/sql/adapter-env-var-precedence.test.ts` 大概率是同一个 AF_UNIX 相对路径类，
建议一并核实后合并处理）。

## P2 — 需要继续深挖（有具体信号但本轮未收敛到根因）

按信号强度排序：

1. **`js/bun/shell/commands/mv.test.ts`**（7/13 fail）：`mkdir '/dev/shm/bun-mv-xdev-...'`
   直接 `EACCES`——**本轮首次记录**的一个具体沙箱限制点（`/dev/shm` 写入被拒）。
   需要确认：①是否所有测试都能绕开 `/dev/shm`（用 `os.tmpdir()`）②这是否影响
   真实用户场景（mv 跨设备场景需要一个真实的临时文件系统做测试媒介）。
2. **`js/bun/shell/commands/rm.test.ts`**：`JSON Parse error: Unexpected EOF`
   ——子进程 stdout 被截断或提前退出，需要确认是否也是 P0.5 那个 LD_LIBRARY_PATH
   类假象（rm.test.ts 有没有裸 `env:` 用法待查）。
3. **`js/node/fs/fs-oom.test.ts`**：期望 `ENOMEM`，实际拿到 `EACCES`——需要确认
   是否是已知的"memfd fstat 返回 EACCES"这个类的一个新样本（该 bug 之前记录
   为已修复，这里可能是同类问题的不同触发路径，未修全）。
4. **`js/bun/test/parallel/test-integration-rspack.ts`**：`Cannot find module
   '@rspack/binding-linux-arm64-ohos'`——跟 CLAUDE.md 记录的"已真机验证"矛盾，
   需要确认是这次环境缺失绑定还是纯网络/缓存问题。
5. **28 文件批次（`cli/create` 系）**：至少 `create-jsx.test.ts` 确认是
   `tailwindcss` npm 包不认 `openharmony arm64` 平台（`bun --only-missing
   install -- tailwindcss ...` 报 `Unsupported platform`）。`@ohos-npm-ports/
   tailwindcss-oxide` 已有移植但这条路径显然没接上，需要确认是 fixture 没配
   resolutions 还是别的原因。其余 27 个文件未拆解，需要单独用
   `--include=cli/create` 跑一次拆开批次。
6. **`js/bun/shell/bunshell.test.ts`**（7/517 fail）、**`js/node/fs/fs.test.ts`**
   （7/571 fail）、**`js/node/child_process/child_process.test.ts`**（6/72 fail，
   除了 P0.5 那个 getChildEnv 用例外还有其他失败未查）——单文件失败占比不高，
   适合下一轮直接 `-t` 过滤到具体用例名单独复测。

## P3 — 尚未查看具体内容（本轮时间限制，按字母顺序列出，无优先级排序）

`cli/bun.test.ts`、`cli/hot/hot.test.ts`、`cli/init/init.test.ts`、
`cli/inspect/inspect.test.ts`、`cli/install/isolated-install.test.ts`、
`cli/run/env.test.ts`、`cli/run/multi-run.test.ts`、`cli/run/require-cache.test.ts`、
`cli/run/run_command.test.ts`、`cli/test/parallel.test.ts`、
`integration/datadog-pprof/datadog-pprof.test.ts`、`integration/esbuild/esbuild.test.ts`、
`integration/vite-build/vite-build.test.ts`、`internal/build-rust-toolchain-probe.test.ts`、
`js/bun/ffi/cc.test.ts`、`js/bun/glob/scan.test.ts`（`EACCES: permission denied,
open '/'`，很可能是已知的根目录访问受限类）、`js/bun/http/serve-directory-routes.test.ts`、
`js/bun/net/socket.test.ts`（1/101 fail，可能是 P0.5 假象）、
`js/bun/shell/pipeline_stack.test.ts`（diff 不匹配）、
`js/bun/spawn/spawn-stdin-readable-stream.test.ts`、
`js/bun/spawn/spawnsync-isolated-event-loop.test.ts`（可能是 P0.5 假象）、
`js/bun/util/filesink.test.ts`（可能是 P0.5 假象）、
`js/node/net/node-net.test.ts`（可能是 P0.5 假象）、
`js/node/process/process-stdin.test.ts`、`js/node/test/sequential/test-fs-watch.js`、
`js/node/tls/test-use-system-ca.test.ts`（diff 不匹配）、`js/node/watch/fs.watch.test.ts`、
`js/sql/adapter-env-var-precedence.test.ts`（大概率同 P1 的 AF_UNIX 类，见上）、
`js/third_party/@napi-rs/canvas/napi-rs-canvas.test.ts`、`js/third_party/pnpm/pnpm.test.ts`、
`js/third_party/rollup-v4/rollup-v4.test.ts`、`js/third_party/vitest/vitest.test.ts`、
`regression/issue/18239/18239.test.ts`、`regression/issue/24364.test.ts`（跟 28 文件
批次同一个 tailwindcss 平台问题的可能性较大）、`regression/issue/32492.test.ts`
（性能预算类，`<9000` 收到 `17735`，高负载下更可能是残留噪音而非真实回归）、
`regression/issue/ctrl-c.test.ts`、`js/web/streams/streams.test.js`（timeout，可能仍是噪音）、
`test-fs-write-sigxfsz.js`/`test-fs-stat-date.mjs`/`test-net-error-twice.js`/
`test-net-autoselectfamily.js`（这四个混在 runner 自己的 19-way "parallel-safe"
内部批处理里跑的，**不能排除是 runner 内部并发本身造成的噪音**，需要单独用
`--include=` 精确到单文件绕开这个批处理机制才能拿到干净信号）。

## 方法论备注

- 串行复核仍需注意 `scripts/runner.node.mjs` 有自己的"parallel-safe width 19"
  内部批处理机制，对特定目录（`js/node/test/parallel`、`cli/create` 等）即使
  顶层不传 `--parallel` 也会内部并发跑，这类文件的"串行"结果并不是真正隔离。
- 设备负载本轮结束时仍在 20+（正常应个位数），P3 列表里没有单独重跑到"干净
  隔离"状态的文件，结论都还是初步的。

## 第六轮（2026-09-15 续）

- **`js/third_party/rollup-v4/rollup-v4.test.ts`（真实修复）**：`test/package.json`
  的 `rollup` 从 4.4.1 bump 到 4.50.2 ——registry 实测 rollup 从 4.50.0 起才有
  openharmony-arm64 原生绑定；只测 `parseAst` 这个稳定 v4 API，v4.x 内 bump
  行为中立。commit `2f1e279829`。
- **`js/third_party/pnpm/pnpm.test.ts`（结构性，已隔离）**：fixture 依赖
  `vite@5.4.10` → `esbuild@0.21.5`，esbuild 的 `@esbuild/openharmony-arm64`
  从 0.25.6 起才有（registry 实测），fixture 是三方脚手架产物不是本仓断言，
  改动成本大于收益，同 commit 隔离。
- **`js/third_party/@napi-rs/canvas/napi-rs-canvas.test.ts`（结构性，已隔离）**：
  无 openharmony-arm64 原生绑定；`@ohos-ports/napi-rs-canvas` 有真机验证过的
  产物（见记忆 `reference_napi_rs_canvas_ohos_port_exists`），接线属独立
  npm-porting 任务不是 bun 运行时问题，本轮不追，同 commit 隔离。
- **`js/third_party/vitest/vitest.test.ts`（结构性，已隔离）**：`vitest@4.1.9`
  自身传递依赖解析到 `rollup@4.37.0`（独立于本仓顶层 rollup 依赖，早于
  4.50.0），`test/node_modules` 里已经有满足条件的 `rollup@4.62.2`/`4.63.1`
  但 vitest 依赖树没解析到，深挖要改 vitest/vite 版本锁定成本过高，同 commit
  隔离。
- **`js/node/fs/fs.test.ts`（7 处，全部结构性，已隔离）**：commit `f70bb88b8e`。
  - RLIMIT_FSIZE 一组（`writeFileSync when the write fails partway` x4 +
    `createWriteStream surfaces EFBIG` x1）：toybox `/bin/sh` 的 `ulimit`
    内建 no-op，已有记忆 `environment_toybox_sh_ulimit_broken` 精确覆盖，
    裸 `/bin/sh -c 'ulimit -f 1; ulimit -f'` 读回空，但 Python
    `resource.setrlimit` 走真 syscall 能正确 enforce EFBIG——内核没问题，
    纯 shell 内建的坑。
  - 负数(pre-epoch)时间戳一组（`utimesSync` 负数分数字符串 + `BigIntStats
    *Ns` 字段）：纯 Python `os.utime(path,(-1.5,-1.5))` + `os.stat()` 也读回
    0，bun 完全不参与，是内核/文件系统把负数时间戳钳到 0，新建记忆
    `environment_ohos_negative_timestamp_clamped_to_epoch`。
- **`js/node/child_process/child_process.test.ts`（1 处，本地构建产物差异，
  已隔离但需 formula 复验）**：commit `769049e609`。`"should allow us to set
  env"` 用 `env: {TEST:"test"}`（无 `LD_LIBRARY_PATH`）spawn 子 bun 触发
  ICU 动态库找不到。`readelf` 实测：本地 `ohos-minimal` 直构二进制
  `NEEDED libicui18n.so.78`/`libicuuc.so.78` 且无 RPATH（本会话每次直构都要
  手动 export `LD_LIBRARY_PATH` 正是因为这个）；而已发布的 formula 产物
  `~/.harmonybrew/Cellar/bun/1.4.2_8/bin/bun` 的 `readelf -d` 只有
  `NEEDED libc.so`——生产二进制是静态链接 ICU 的。**这不是代码 bug，是本轮
  会话本地快速迭代构建（动态链 ICU 复用 keg 求速度）跟正式 formula 构建
  （静态链）之间的构建配置差异**，先按 OHOS 隔离处理，但必须在真正走一次
  formula 构建后复验——如果 formula 构建也复现同样问题，那就是真 bug 需要
  另外处理；如果不复现，说明纯粹是本地直构的已知取舍，可以放心保留隔离。
  **这个发现有更广泛的影响面**：任何测试只要 spawn 子 bun 时传一个精简过的
  `env`（不含 `LD_LIBRARY_PATH`），本轮所有"失败"里都可能混着这同一个假阳性，
  之前几轮遇到的个别"诡异"失败要留意是否是这个而不是急着当真 bug 深挖。

## 第七轮：bun install 的 npm os/cpu 匹配没有 openharmony（真实产品 bug，已修复）

- **根因**：`src/install_types/resolver_hooks.rs` 的 `OperatingSystem`
  bitflag 枚举压根不认 `"openharmony"` 这个名字，OHOS 构建下 `CURRENT` 落到
  通用 `#[cfg(target_os="linux")]` 分支变成纯 `LINUX`。后果：任何 npm 包声明
  `"os":["openharmony"]`（rollup≥4.50.0、esbuild≥0.25.6、rolldown≥beta.31，
  这类包在增多）装的时候一律 "os mismatch" 被跳过——**这很可能是本会话（乃至
  更早）canvas/resvg/sharp/tailwindcss 等一路要靠手工 `resolutions` override
  才能装上的根因之一**，不是那些包本身没有 openharmony 产物，是 bun 自己不
  认它。
- **修复**：加 `OPENHARMONY` bit + `negatable_names!` 注册 + OHOS 专属
  `CURRENT` 分支。commit `e914078f95`。
- **一次真实的自我纠正**：第一版把 `CURRENT` 设成 `LINUX | OPENHARMONY`
  （双 bit，想让没有 openharmony 变体的包继续走通用 linux 二进制），单元
  测试之外看起来一切正常（rolldown/esbuild 装包正确），但被
  `test/cli/install/architecture-match.test.ts` 抓到：`!openharmony`
  （否定当前平台）因为 LINUX 位还在没被排除干净，匹配没有整体失效——每个
  平台的 `CURRENT` 必须是单 bit，这是这个测试在验证的不变量。改成纯
  `OPENHARMONY` 单 bit 后 `architecture-match.test.ts`（30/30）+
  `bun-install-cpu-os.test.ts`（13/13）全绿，rolldown/esbuild 仍正确。
- **未解决的窄范围真 bug**：`rollup`（不是 rolldown）作为父依赖时，它自己
  的 `@rollup/rollup-openharmony-arm64` optionalDependency 在不带 `--force`
  的正常 `bun install` 下装不上——debug print 证实该子包的 os 字段在
  `--no-cache --force` 下正确解析成 OPENHARMONY(512)，不带 `--force` 时却
  解析成 `NONE`(0)。换了 5+ 个本会话从未测过的 rollup 版本，现象一致，
  排除本机 stale cache；`rolldown` 结构几乎一样的场景完全正常。花了 4 轮
  debug 重编（每轮 ~10 分钟）没查出确切根因，记入记忆
  `project_ohos_bun_npm_os_matching_fix` 留给下次。`vite-build.test.ts`
  （走 `rolldown-vite`→`rollup@4.63.3`）因此仍然隔离，但注释里写清楚了
  "更大的根因已修，这个是另一个更窄的独立 bug"。

## 第八轮：按"升级→查 @ohos-npm-ports→查 @ohos-ports"顺序补漏

用户提醒了标准流程后，回头对本轮刚处理过的几个包重新走了一遍这个顺序：

- **`esbuild.test.ts`（真实修复）**：硬编码 `esbuild@0.19.8`（bun install 命令行
  + 版本断言两处），早于 esbuild 0.25.6 才有的 openharmony-arm64 二进制；
  esbuild 自己的 `install.js` 平台判断是 JS 侧硬编码 switch，不读
  package.json os/cpu 字段，所以本轮的 os-matching 修复够不着它，只能升版本。
  bump 到 0.25.11，两处断言同步改，验证过真的能装/能跑。estrella@1.4.1
  内部锁死 `esbuild@^0.11.0` 且本身已无人维护，没有版本可升，改
  `skipIf(openharmony)`。commit `852eb572d1`。
- **`@napi-rs/canvas`（真实修复，之前误判为"独立 npm-porting 任务本轮不追"，
  这次直接做了）**：查到 `@ohos-ports/napi-rs-canvas` 确实存在（记忆
  `reference_napi_rs_canvas_ohos_port_exists` 早就记过，这次翻出来验证并接
  线）。`dist-tag latest` 指向的 `0.1.80-beta.0` 不是最新版，包里还有个没打
  latest 标的 `1.0.2-beta.0`，实测用后者能正常渲染、像素级匹配
  `expected.png`。`test/package.json` 加
  `resolutions."@napi-rs/canvas" = "npm:@ohos-ports/napi-rs-canvas@1.0.2-beta.0"`，
  测试转绿，从 expectations.txt 摘除。同 commit。
- **复核 `pnpm.test.ts`**：卡点其实是 pnpm 自己的 lockfile
  （`install_fixture/pnpm-lock.yaml` 锁死 vite@5.4.10→esbuild@0.21.5），
  `bun x pnpm install` 走的是 pnpm 自己的解析器不是 bun install，本轮的
  os-matching 修复和"查 ports"这条路径都够不着——要修得改 fixture 自己的
  pnpm lockfile 重新生成，成本仍大于收益，维持隔离。
  **复核 `vitest.test.ts`**：重新跑过，依然失败——卡点是 rollup@4.37.0
  本身就早于 4.50.0（openharmony 二进制起点），不是 os-matching 匹配不到，
  是这个版本压根没有 openharmony 产物，我的解析器修复对这个场景本来就无能
  为力，维持隔离，原判断成立。

## 产物

- `logs/baseline-ohos-minimal-2026-09-15/serial-reverify/`（第一轮串行复核，
  CI=1，92 个可疑文件）
- `logs/baseline-ohos-minimal-2026-09-15/serial-reverify-2/`（第二轮串行复核，
  CI=true + 清理陈旧 bun 文件后重跑同一批）
