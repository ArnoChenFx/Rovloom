# Issue #15 验收视角复核

日期：2026-10-18 UTC。复核对象为本地提交 `885cc6aaf54790c09845128aeb1e3e849a15a807`，tree `0b3f8a7f9db082a5ed545a767d5fa4a6348952ad`；基于已合并 main `9c4a7fe`。本轮按 [issue #15](https://github.com/ArnoChenFx/luvus-mcp/issues/15) 逐项检查迁移 diff、原始日志、依赖数据和 CI；不是另一个平台或商业 Host 的验收。

结论：Linux 本地验收通过。发现的证据/开发指引缺口已补齐，没有修改业务源码、原测试断言、原 P0 fixture 或历史 Node 结果。原 39 项测试的产物和哈希均保留，因业务源码/测试/tsconfig 字节相同，不重复整轮；仅做下列必要补验。修复合入第三个 Bun 增量提交，原 885cc6a 另留本地备份；最终本地/远端 SHA 以交付消息和 PR 为准。

## 核对结果

| 验收项 | 复核依据与结论 |
| --- | --- |
| Bun pin/来源 | `.bun-version`、packageManager、engines、版本脚本和 CI 均为 1.4.3；官方 ZIP checksum 与 binary SHA 再核对一致，revision 未变，无安装脚本、全局配置或账户操作 |
| TypeScript 是否升级 | 直接读取 916cae2、4f963d1、9c4a7fe 的 package/lock：全部为 **7.0.2**，SRI 完全相同；不是本次升级。其现有 JS dispatcher 显式由 Bun 运行，源码只转交原生编译器，不执行 Node shebang |
| 119 条目“不变” | 不复用迁移比较器，独立按原 npm 路径还原嵌套包，与 Bun 锁条目逐一比较版本和完整 SRI：119 相同、29 仅 tsx/esbuild/fsevents/平台链移除、0 新增、0 版本或 SRI 改动 |
| 真实安装 | 再次在临时空目录、空缓存 frozen 安装，元数据 hash 不变；逐路径读取 installed package.json：**100 个安装路径**，其余 **19 个外平台条目**明确不适用。Bun 日志中的 **97 packages** 是其包计数，嵌套复用版本导致与安装路径数不同，不能把两者混算 |
| 原 20 项/断言 | 5 个文件逐字节与 main 相等，未删断言/skip/todo；逐个名称在原 Bun 日志中找到：protocol 3、results 2、retention 3、router 4、store 8，合计20；[清单及 hash](review/original-test-inventory.json) |
| SQLite | 保留真实 node:sqlite；原日志覆盖文件库/内存、v1/v2→v3、重开 offline/unknown/no replay、7 字节跨 UTF-8 分页、结果失效/所有权；新增兼容性日志验证参数绑定、changes=1/0、BLOB 含 NUL、SQL rollback、Store redeem 触发器失败后 token consumed 仍为0、DB/lock 0600、第二 writer EEXIST |
| strict 独立检查 | tsconfig 保留 ES2023/NodeNext/strict/noUncheckedIndexedAccess，4 src+5 test 均包含；执行链启动锁定原生 tsc，临时错误文件被 TS2322/TS2532 拒绝并 exit1。不是 Bun 直接转译的“成功” |
| 构建/SDK | Bun ESM 四入口、外置依赖、共享 chunk、source maps、清 dist；原产物 smoke 导入全部入口并用真实库重开；SDK 1.32.1 和实际 stdio 协商2025-11-25未变，子进程明确同一 Bun execPath + --no-env-file，stderr 空 |
| 安装/typecheck/test/build 零回退 | 原完整 strace、阻断探针99、最小 PATH/新 HOME、负例退出码、日志 hash 已逐项核对；execve/execveat 中无 Node/nodejs/npm/npx。补验安装/实装审计的追踪亦为0 |
| 原生采集零回退 | 原提交只追踪新原生归档**重放**，没有追踪**实际采集**；本轮新建阻断 PATH，使用未改的原 Capture 采集器，实际 strace 包含 Luvus CLI/foreground server、synthetic Python terminal、close/cleanup；Node/npm/npx为0，727项通过，31请求/30响应/21events/29schema文档，2项故意无效请求，Bun语义重放通过 |
| `.env`/生命周期 | 保留原 synthetic `.env` 隔离测试；不读取用户 env；安装 trace 没有生命周期子进程，ignoreScripts/显式flag均保留。官方 [配置](https://bun.com/docs/runtime/bunfig#installignorescripts) 与 [生命周期说明](https://bun.com/docs/pm/lifecycle)支持该策略，没有 trust-all 或未审查例外 |
| CI/权限 | 仅 push/PR/workflow_dispatch 测试，contents:read，checkout 固定 SHA 且不保留认证；无部署、发布命令、secrets、sudo、权限扩大或安全设置变更。缺 strace 时只通过 runner 的既有认证 APT 索引下载并在 RUNNER_TEMP 解包，不安装系统包或启服务。静态 shell 语法通过；精确 CI Python bootstrap 用官方 ZIP 成功、损坏 ZIP 被拒绝，PYTHONOPTIMIZE=1 亦不能绕过 hash 检查 |

## 已修复的具体缺口

1. 增加实际原生采集的无 Node 验证入口，不把归档重放当作采集追踪。
2. CI 原 bootstrap 的 Python assert 改为不可被 `-O` 禁用的显式校验；补齐临时 strace 测试依赖准备，不扩大权限。
3. 测试发现门禁现逐个核对20项名称并拒绝skip/todo；使用原通过日志复验，加入 `1 skip` 的变异日志如预期被拒绝。
4. 增加安装路径版本审计，保留119锁条目与Bun包计数/真实100安装路径的区别；不改变依赖。
5. 新代码注释/docstring改为中文；实施方案 #4 的当前开发指引指向 Bun 门禁实测与 ADR，而非继续说版本尚未核验。设计安全原则没有改动。

补验命令：

```sh
python3 scripts/bun/collect_native_no_node.py --binary /absolute/path/to/reviewed-luvus --bun /absolute/path/to/bun --output /tmp/new-native-review
bun --no-env-file install --frozen-lockfile --ignore-scripts
bun --no-env-file scripts/bun/audit_installed.mjs
```

后两条实际在新临时项目、空缓存、最小环境及 strace 下执行；没有用当前 node_modules 冒充干净安装。该审计已纳入默认 verify.py。实际采集为显式可选命令，CI只重放归档，不自动下载/启动 Luvus。

[复核 JSON](review/review.json)、[安装证据](review/dependencies-verification.json)、[实际采集证据](review/native-verification.json)。新增原生归档为 [review-native-evidence.tar.gz](../../fixtures/bun/review-native-evidence.tar.gz)，SHA-256 `d3096fedbd0e632e52c747277e181002afdeccd910ebc3b7f77dfcd25b9fc798`；原729项归档及原完整39项日志保持原字节。所有本轮临时实例/root均清理，无现有会话或凭据操作。

## 边界与后续

本轮复核结束时远端 CI 尚未运行；发布后状态须在 PR 单独核对，不能由本地结果推定通过。macOS/Windows、商业 MCP Host、OAuth、双机、P1与管理 UI仍未验收。没有开发阻断。

父会话随后转达用户已明确批准设计+Bun发布、创建PR与合并；本任务只负责经既有 ArnoChenFx 连接发布完整审定增量并创建PR，不操作 main。三项提交顺序不变，Git对象API若重建author/time导致SHA变化，发布后必须逐tree/hash和文件集合核对。合并由父会话单一协调，未启动 #4。
