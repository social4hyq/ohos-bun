# 交接手册：bun 1.4.2 鸿蒙适配 ohos-minimal 重做（Claude → opencode）

写于 2026-09-17，codex 周额度耗尽后 Claude 短暂接手期间发现构建卡点，现在把工作交给 opencode 继续。

## 先看这两份文档，不要跳过

1. `/storage/Users/currentUser/HarmonyPC/Software/ohos-bun/logs/HANDOFF-2026-09-15-claude-to-codex.md`——上一份交接手册，任务背景、总体方案、协作纪律（老补丁只作参考不照搬、不改测试绕 bug、A/B 对照生产 bun 等）都在里面，**这些约定继续有效，不重复贴一遍**。
2. `logs/todo-round-1-followup-20260915-121104.md`——从第 1 轮到第 29 轮的完整进度记录。**codex 在 round 13-29（2026-09-16 那批）做了大量真实修复和测试复核，但全部还没提交**，本文档下面详细说这件事。

方案文件：`/storage/Users/currentUser/.claude/plans/snoopy-moseying-walrus.md`。

## 当前最紧急的事：一大批未提交的工作，先保住再验证

`git status --short` 现在有 **334 个改动文件**（分支 `ohos-minimal`，最新 commit 仍是 `df6a706610`）。这不是失控——是 codex 在 round 13-29 做的、每轮都有真机验证记录（见上面 todo 文件），只是还没来得及 commit 就没额度了。**千万不要用 `git checkout`/`git reset --hard`/`git clean` 清理这些改动**，那会丢掉一整天的工作。

### 我（Claude）已经做的复核

**核心产品代码改动很小，已完整看过，质量好**：`git diff --stat -- src/ scripts/build/rust.ts` 只有 19 个文件、+134/-24 行。逐条看过，都是有根因、有注释解释"为什么"的最小修法，符合项目纪律。摘要（详细内容看 `git diff -- src/ scripts/build/rust.ts`，或直接问 codex round 13-29 的 todo 记录对应哪条）：

- `install_types/resolver_hooks.rs` + `install/lockfile/Package/Meta.rs`：加了 `LEGACY_ALL_VALUE`（不含 OHOS 位的旧 ALL 掩码），修复"加了 openharmony 位之后，旧 lockfile 里编码的『不限平台』被误判成『不含 openharmony』"的兼容性问题
- `install/npm.rs`：manifest cache 版本号 v0.0.7→v0.0.8（配合上面那条，bump 缓存格式版本，旧缓存自动失效重新解析）
- `io/PipeReader.rs` + `io/PipeWriter.rs` + `runtime/api/bun/Terminal.rs`：OHOS PTY 相关的第二轮修复——master fd 关闭后返回 EIO 时正确当作 EOF 处理（而不是当错误抛出）；writer 初始为空时不注册 EPOLLOUT，避免丢失后续可写边缘触发
- `jsc/bindings/c-bindings.cpp`：`__wrap_pthread_create` 加了新线程创建前等 execve 计数清零的逻辑——这是**之前记忆库标记为"未解决、需要重新设计真正互斥方案"的 execve/pthread_create SIGSEGV 问题**（见记忆 `project_execve_pthread_create_sigsegv`），如果这轮真的把它修好了，是本次会话最大的一块产品级修复，**验证通过后务必更新那条记忆**
- `js/node/child_process.ts` + `runtime/api/bun/js_bun_spawn_bindings.rs` + `spawn/process.rs` + `spawn_sys/spawn_process.rs`：给 shell 模式的子进程加了 `newProcessGroup`（OHOS 专属），kill 时用 `-pid` 打整个进程组而不是单个 pid——像是在修某个 timeout/kill 场景下子进程的孙进程杀不干净的问题
- `runtime/node/node_fs_watcher.rs` + `runtime/node/path_watcher.rs`：OHOS 的 PATH_MAX 实际是 1024（不是 target_os=linux 带来的 4096 假设），加了长度校验；`fs.watch` 的 inotify 事件分类修正（OHOS 的 IN_ATTRIB/IN_DELETE 顺序跟标准 Linux 不同）
- `runtime/napi/libc_check.rs`：OHOS 的 musl-derived libc 没有报 `target_env=musl`，加 `cfg!(target_env="ohos")` 到 glibc-addon 拒绝检查里
- `runtime/api/bun/spawn/stdio.rs` + `runtime/shell/IO.rs`：cfg 收紧（`Capture::buf` 字段在 OHOS 下不再用 `#[allow(dead_code)]` 消音，改成真的不编译进去）
- `scripts/build/rust.ts`：把 `aarch64-unknown-linux-ohos` 从 `allRustTargets`（一个只给 `.buildkite/ci.mjs` 一致性检查用的列表）里删掉——**这条改动我还没有把握它对本机直构完全无副作用，见下面"正在验证"**
- `runtime/webcore/FileReader.rs`：纯格式化改动（一行拆三行），逻辑没变，不用管

### 我发现并已经修复的一个构建环境陷阱（opencode 接手时可能还会再撞到）

这是**已知问题**（记忆库 `environment_bun_toolchain_rust_export_required` 有完整背景），这次真撞上了：codex 改 `scripts/build/rust.ts`（删那个 OHOS target）触发了 ninja 的自动 reconfigure，但**那次 reconfigure 大概率没有正确导出 `BUN_TOOLCHAIN_RUST` 环境变量**，导致 `build/ohos-minimal/build.ninja` 里的 rust 构建规则被永久写死成 `~/.harmonybrew/bin/cargo`（Harmonybrew 自己的 stable 版 cargo，不是项目里 `rust/bin/cargo` 那个 nightly-2026-07-20）。表现是编译到 `bun_runtime` 时报：
```
error: the `-Z` flag is only accepted on the nightly channel of Cargo, but this is the `stable` channel
```
**这个错误看起来像代码问题，其实是纯环境问题**，光是重新 `export` 环境变量再跑 `ninja` 没用（错误的路径已经是文件里的死文本）。修法是**从 build 目录内直接手动跑一次 configure**（不经过 ninja）：
```bash
cd /storage/Users/currentUser/HarmonyPC/Software/ohos-bun/build/ohos-minimal
export BUN_TOOLCHAIN_RUST=/storage/Users/currentUser/HarmonyPC/Software/ohos-bun/rust
export PATH="/storage/Users/currentUser/.harmonybrew/opt/lld@21/bin:/storage/Users/currentUser/.harmonybrew/opt/llvm@21/bin:$BUN_TOOLCHAIN_RUST/bin:$PATH"
export LD_LIBRARY_PATH="/storage/Users/currentUser/.harmonybrew/opt/openssl@3/lib:/storage/Users/currentUser/.harmonybrew/opt/icu4c@78/lib"
export SSL_CERT_FILE="/storage/Users/currentUser/.harmonybrew/etc/ca-certificates/cert.pem"
export CURL_CA_BUNDLE="$SSL_CERT_FILE"
export CARGO_HTTP_CAINFO="$SSL_CERT_FILE"
export TMPDIR=/data/storage/el2/base/tmp
/storage/Users/currentUser/.harmonybrew/bin/bun /storage/Users/currentUser/HarmonyPC/Software/ohos-bun/scripts/build.ts --config-file=configure.json
```
**已经跑过这一步，已确认修好**（`grep 'cargo build \$args' build/ohos-minimal/build.ninja` 现在显示 `.../ohos-bun/rust/bin/cargo`，不再是 `harmonybrew/bin/cargo`）。

### 正在验证、还没做完的事（opencode 接手后的第一步）

修好 reconfigure 之后跑了一次完整增量构建（`ninja -C build/ohos-minimal bun-profile -j 20`），**编译到最后一步（`bun_runtime`，通常是最后一个大 crate）时被我这边的工具超时打断（SIGTERM），不是编译错误**——日志显示一路 `Compiling` 到 `bun_runtime` 都没有任何 `error`，说明 toolchain 修复是有效的，只是没跑完。**第一件事：重新跑一遍这个命令到完成**：
```bash
cd /storage/Users/currentUser/HarmonyPC/Software/ohos-bun
export BUN_TOOLCHAIN_RUST=/storage/Users/currentUser/HarmonyPC/Software/ohos-bun/rust
export PATH="/storage/Users/currentUser/.harmonybrew/opt/lld@21/bin:/storage/Users/currentUser/.harmonybrew/opt/llvm@21/bin:$BUN_TOOLCHAIN_RUST/bin:$PATH"
export LD_LIBRARY_PATH="/storage/Users/currentUser/.harmonybrew/opt/openssl@3/lib:/storage/Users/currentUser/.harmonybrew/opt/icu4c@78/lib"
export SSL_CERT_FILE="/storage/Users/currentUser/.harmonybrew/etc/ca-certificates/cert.pem"
export CURL_CA_BUNDLE="$SSL_CERT_FILE"
export CARGO_HTTP_CAINFO="$SSL_CERT_FILE"
export TMPDIR=/data/storage/el2/base/tmp
nohup ninja -C build/ohos-minimal bun-profile -j 20 > logs/rebuild-$(date +%Y%m%d-%H%M%S).log 2>&1 &
```
**注意**：这条命令启动后会真正脱离父 shell 在后台跑，"工具层面提示这条命令已完成"**不代表 ninja 真的编译完**（这条命令本身几秒内就返回了）。判断真的编译完，要 `ps -ef | grep ninja` 确认进程还在/不在，或者 `grep -E "Finished|error\[|error:" logs/xxx.log` 看日志里有没有出现 `Finished` 或任何 `error`。完整增量构建约 10-13 分钟。

构建成功后：
1. 跑 `bun --version`/`bun -e 'console.log(1)'` 冒烟确认二进制能跑
2. **重点验证 `c-bindings.cpp` 那条 pthread_create/execve 修复**：参考记忆 `project_execve_pthread_create_sigsegv` 里描述的压力测试场景（大量并发 execve），跑几轮看 SIGSEGV 是否真的消失了。这条如果验证通过，是本次交接期间最重要的一块产品修复，请更新那条记忆
3. 跑一遍 `architecture-match.test.ts`、`process.test.js`、几个 Terminal/PTY 测试，跟 todo 文件里 round 13 那批记录的通过数对一下（应该基本一致，因为源码没有本质变化，只是编译状态从"未编译"变成"已编译"）
4. **确认 `scripts/build/rust.ts` 删除 OHOS target 那条改动没有破坏本机直构本身**（这是我唯一没完全放心的一条——它改的是给 `.buildkite/ci.mjs` 一致性检查用的列表，理论上不影响本机 `--config-file=configure.json` 走的路径，但既然这次构建流程本身就撞过一次 reconfigure 坑，建议单独确认一下这条改动没有引入新的隐藏问题）

## 之后：提交这 334 个文件

**不要一次性 `git add -A` 无脑提交**。建议按 todo 文件 round 13-29 的叙事分主题提交（source 改动一个/几个 commit，测试改动可以按子系统分组：install/lockfile 一组、PTY/terminal 一组、fs.watch 一组、DNS/esbuild/rspack fixture 升级一组，等等）。todo 文件里每轮都写了做了什么、为什么、验证结果，写 commit message 时可以直接摘。commit 尾缀按 opencode 自己的署名规范（不是 Claude 的）。

提交完之后：
- 更新 `logs/todo-round-1-followup-20260915-121104.md`，继续往后加轮次
- 检查跨会话记忆库要不要更新（`/storage/Users/currentUser/.claude/projects/-storage-Users-currentUser-HarmonyPC-Workspace/memory/`——如果 opencode 环境读不到这个路径，至少把重要发现写进 todo 文件，保证下一个接手的 agent 能看到）；`project_execve_pthread_create_sigsegv`、`environment_bun_toolchain_rust_export_required` 这两条尤其可能需要更新

## 其它交接常态提醒（跟上一份 codex 交接手册一致，再强调一遍）

- 用户偏好简体中文交流
- 老补丁（`Patches/bun/`）只作参考交叉验证，不照搬；每个修法从根因出发自己设计
- 不改测试断言绕过真 bug；npm 包版本/resolutions 可以改
- `test/expectations.txt` 顶部有使用规范：单个测试坏了在文件内 skip，不要整文件隔离
- TMPDIR 每次 Bash 调用前 `export TMPDIR=/data/storage/el2/base/tmp && export TMPPREFIX="$TMPDIR/zsh"`
- grep 交替模式 `-E "a|b"` 在本机偶尔假阴性，没找到先重试一次
