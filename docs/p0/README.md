# Luvus 原生契约与证据回放

Linux Luvus 0.14.3 的 P0 技术基线已验收。版本和协议决策见
[ADR 0001](../adr/0001-p0-version-and-contract-baseline.md)，完整来源、release
校验值与 29 个 schema 文档的固定源码对应关系见
[provenance.json](provenance.json)。这些证据证明固定版本的原生行为；
Gateway/Connector、跨平台、商业 MCP Host、OAuth 和 Herdr P0-H 仍有独立门禁。

## 必须保留的输入

| 路径 | 维护用途 |
|---|---|
| [fixtures/p0/linux-luvus-0.14.3](../../fixtures/p0/linux-luvus-0.14.3/manifest.json) | 测试和审计直接读取；包含安装 schema 原文字节、实时能力、RPC/Host/终端记录、endpoint 检查及清理证据 |
| [coverage.json](coverage.json) | `scripts/p0/audit-fixtures.mjs`、P0 测试与隔离验证器消费的逐方法基线 |
| [provenance.json](provenance.json) | 官方 release、binary hash、固定源码 commit 和 schema 源码映射 |
| [sdk-compatibility.json](sdk-compatibility.json) | 原 Node 调查的 SDK stdio 协商 wire；Bun 路径另见 [Bun SDK 记录](../bun/sdk-compatibility.json) |
| [fixtures/p0/review-native-evidence.tar.gz](../../fixtures/p0/review-native-evidence.tar.gz) | `v2` 保留 pane ID 被原生拒绝的失败预期，`v3` 是通过审计的补充采集，包含 stale_route 拒绝 |
| [fixtures/bun/native-evidence.tar.gz](../../fixtures/bun/native-evidence.tar.gz) | `scripts/bun/audit_native.py` 固定 hash 后离线重放的 Bun 原生输入 |
| [fixtures/bun/review-native-evidence.tar.gz](../../fixtures/bun/review-native-evidence.tar.gz) | 在阻断 Node 的采集中获得的独立原生输入，可经相同语义审计复放 |

三个归档 SHA-256 分别为：

```text
c96e145ad04b7ffd42a5d96624db81a68599ca769b5a10d8e15857e900e3fb23  fixtures/p0/review-native-evidence.tar.gz
71c38aa6ce308cb71fe02746a8380034e2869b75d82c8c288edefd3b4935cc41  fixtures/bun/native-evidence.tar.gz
d3096fedbd0e632e52c747277e181002afdeccd910ebc3b7f77dfcd25b9fc798  fixtures/bun/review-native-evidence.tar.gz
```

归档内只接受已审查的普通文件、相对路径和清单，不直接执行采集内容。
回放补充包时选择成功目录；P0 `v2` 应被完整验收审计拒绝，不能混作通过集。
归档与展开 fixture 都是有效测试/复现输入，不能按运行日志删除。

## 离线验证与重新采集

在仓库根目录按 [Bun 指引](../bun/README.md)冻结安装后执行：

```sh
bun --no-env-file run test:p0
bun --no-env-file run p0:audit
bun --no-env-file run p0:bun-native
```

`p0:audit` 校验 manifest 的必需文件集合、文件 hash、schema 引用闭包、请求/
响应关联、实际退出码、endpoint/peer 身份与清理状态，不启动 Luvus、不联网。
`test:p0` 还运行真实 SDK stdio 子进程探针与 Python endpoint 拒绝/失败清理
测试；合成 socket 测试本身不算 Luvus 原生证据。

对补充包安全解包后，可从仓库根目录将成功采集目录传给同一审计器：

```sh
bun --no-env-file -e 'import {inspectFixtures} from "./scripts/p0/audit-fixtures.mjs"; console.log(inspectFixtures(process.argv[1]))' /absolute/path/to/extracted/successful-capture
```

重新采集需先按 provenance 校验官方 Luvus binary，再指定尚不存在的新输出：

```sh
python3 scripts/p0/collect_native.py --binary /absolute/path/to/luvus --output /tmp/rovloom-p0-new
```

采集器固定官方 Linux x64 binary hash，在 `/workspace` 下创建新的 0700
状态根，使用自己的 `p0-issue3` session 与合成 Python 终端输入，不继承用户
HOME/session 选择器；这不构成 OS 文件访问沙箱。流、server 与临时根在
`finally` 清理；SIGKILL/机器崩溃仍需外部回收。不要覆盖已提交 fixture。
更新版本时先人工审查契约/分类，再重新采集和运行审计；日常 CI 不带 `--write`。

## 契约与实现边界

223 个方法来自 197 session、17 Host 和 9 access_machines；四个持续流
单列。schema 只有 79 个方法专用条件分支，其余 144 个接受通用 params
object，不能宣称完整参数验证。覆盖账本中的 `not_implemented/not_enabled`
是这份 P0 Gateway 基线的状态，不是原生能力不可用。

保留 schema 原文和离线引用闭包，缺引用不能联网补齐。Host 不依赖 session；
endpoint 必须从精确发现行取得，不能使用展示 socket 或自己拼路径。queued
ack 不等于输入已消费，关闭流不等于关闭 pane；原生错误与终端身份 fence
不能被网关改写。SDK 1.32.1 的记录协商 `2025-11-25`，不证明支持新版
MCP revision、HTTP/OAuth 或实际商业 Host。多 provider 与 Herdr 的只读 MVP、
迁移和 P0-H 边界以 [ADR 0004](../adr/0004-multi-runtime-provider.md) 为准。
