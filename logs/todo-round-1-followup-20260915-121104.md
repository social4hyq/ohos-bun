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

## 产物

- `logs/baseline-ohos-minimal-2026-09-15/serial-reverify/`（第一轮串行复核，
  CI=1，92 个可疑文件）
- `logs/baseline-ohos-minimal-2026-09-15/serial-reverify-2/`（第二轮串行复核，
  CI=true + 清理陈旧 bun 文件后重跑同一批）
