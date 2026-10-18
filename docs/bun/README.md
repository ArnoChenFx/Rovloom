# Bun 开发与验证

当前工具链为 **Bun 1.4.3**，已合入 main。版本由 `.bun-version`、
`package.json` 和 CI 共同固定；发布来源、revision 及 Linux x64 校验值见
[provenance.json](provenance.json)，运行时选择见
[ADR 0003](../adr/0003-bun-toolchain.md)。Node/npm 命令属于早期调查历史。

## 开发命令

在仓库根目录使用精确版本的 Bun：

```sh
bun --version
bun --no-env-file install --frozen-lockfile --ignore-scripts
bun --no-env-file run toolchain
bun --no-env-file run typecheck
bun --no-env-file run test
bun --no-env-file run test:p0
bun --no-env-file run test:bun
bun --no-env-file run p0:audit
bun --no-env-file run p0:bun-native
bun --no-env-file run build
bun --no-env-file run smoke
```

`typecheck` 显式由 Bun 启动锁定的 TypeScript 7.0.2 dispatcher，再执行其
原生编译器；保留 `strict` 与 `noUncheckedIndexedAccess`。Bun build/test 的
转译成功不能替代独立类型检查。不要直接执行 TypeScript 的 Node shebang。
安装禁用生命周期脚本；配置及子进程禁用自动加载 `.env`。

构建清空 `dist`，输出 `dist/src/` 下四个 ESM 模块入口、共享 chunk 和
外部 source maps，依赖外置。共享 chunk 保持 `GatewayError` 类型身份一致。
`smoke` 导入构建产物并验证实际文件数据库重开。当前没有 Gateway/Connector
服务 CLI、Node target 或类型声明产物。

## CI 与隔离复验

Linux 需要 Python 3、strace 和上述 Bun；与
[工作流](../../.github/workflows/bun.yml) 相同的完整入口为：

```sh
python3 scripts/bun/verify.py --bun /absolute/path/to/bun --output /tmp/rovloom-verification-new
```

输出目录必须尚不存在且位于 checkout 外。验证器在临时项目、空缓存和新 HOME
中冻结安装，审计实装依赖，执行独立类型检查及故意错误反例、基础/P0/Bun
测试、fixture 审计、clean build 和产物 smoke。Node/npm/npx 阻断探针必须
返回 99；之后的 execve/execveat 追踪拒绝项目执行链中的 Node 回退。
GitHub Actions 自身的 checkout 宿主不属于项目运行时。

测试原始名称基线保留在
[original-test-inventory.json](review/original-test-inventory.json)；待合入的
Wire/native 验证器用它核对原 20 项测试，不能作为普通复核日志删除。
新增测试仍须全部发现，不能跳过或只更新总数来放行。每轮命令输出与验收摘要
放在 CI/PR，临时执行日志无需加入源码仓库。

## 原生证据与兼容边界

[P0 回放指引](../p0/README.md)说明固定 Luvus 0.14.3 输入及原生归档。
`p0:bun-native` 只离线重放归档；重新采集是独立操作，需要先校验指定 binary，
再在全新实例中运行：

```sh
python3 scripts/bun/collect_native_no_node.py --binary /absolute/path/to/luvus --bun /absolute/path/to/bun --output /tmp/rovloom-native-new
```

采集器仅使用自建 session、私有状态根与合成终端输入；不连接已有用户实例。
Linux x64 的官方 Bun binary hash 由脚本固定，不能随意换版本。
[SDK stdio 记录](sdk-compatibility.json)保留同一 Bun 子进程的实际握手；
SDK 1.32.1 协商的是 `2025-11-25`。`process.version` 是 Bun 的 Node
兼容字符串，不能据此宣称实际运行过 Node 26。Linux 通过不代表 macOS、
Windows、商业 MCP Host、HTTP/OAuth 或双机 Gateway 已验收。

## 基础模块维护边界

`src/contracts.ts`、`src/store.ts`、`src/router.ts` 与 `src/protocol.ts` 是内部
基础模块。Store 的注册、管理和账本方法不能直接作为已认证远程 API；Router
仍需宿主提供可信 principal 与当前策略。现有协议是内部 v1 草稿，没有完整
原生 schema 校验、认证握手、流、minor 能力协商或实际网络接线。

SQLite 使用 Bun 提供的 `node:sqlite`。当前 schema v3 支持事务式 v1/v2
升级，未知版本在 DDL 前拒绝；多 provider 迁移仍须遵循
[ADR 0004](../adr/0004-multi-runtime-provider.md)，不能给旧记录猜默认 provider。
文件数据库只允许单 writer；崩溃遗留 `.lock` 时先确认无 writer 并备份，
不能自动删锁当作已完成恢复。父目录防护、备份、Windows ACL、恢复隔离、
凭据轮换和真实认证仍有待实施。

当前结果句柄最多一小时，聚合 payload 上限 16 MiB，单页最多 64 KiB；
重复保存活句柄不续期。句柄到期不删除 `calls.response`，显式 discard
另需 `principal.permissions.discard_response === true`，并保留调用元数据和
去重记录。逻辑删除不保证物理擦除、磁盘回收或备份清除，全库/WAL/备份预算
及保留调度尚未实现。发送后失联保留 `outcome_unknown`，取消不承诺回滚，
不能自动重放写操作。正式目标与后续门禁以
[DESIGN](../DESIGN.md)、[实施计划](../IMPLEMENTATION-PLAN.md)和 ADR 为准；
Herdr 仍须先通过 P0-H，不能从这些基础模块推导已支持执行。
