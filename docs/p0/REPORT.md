# Issue #3：原生证据与覆盖基线报告

日期：2026-10-18 UTC。交付状态：**Linux P0 最小技术门禁有原生证据，待父会话验收；不是 Gateway/Connector 可部署性验收。**

本报告记录初次交付。后续一轮验收复核、已修复审计/失败清理问题及新原生复跑，见 [REVIEW.md](REVIEW.md)；原 fixture 保持不变。

## 基线、范围与来源

- 仓库 `ArnoChenFx/luvus-mcp`；远端 `feat/reviewed-core-foundation` 经 fetch 核实为 `916cae2412b69f3432caf264fd411ea1a4b3093f`。
- 本地任务分支 `task/issue-3-native-evidence`，没有推送、合并、发布或部署。`src/` 和原有 20 个基础测试未改动。
- 已读 `docs/HANDOVER.md`、正式方案及设计 v0.2、issue #3；仓库/祖先目录未发现适用的 AGENTS.md。
- Debian 13.6、Linux 6.18.55、x86_64、有效 UID 1000；Node 24.19.0、npm 11.9.0、SQLite 3.53.3。Python 版本在 fixture environment 文件登记。
- 原先 PATH 没有 Luvus。官方站点链接到 `RizRiyz/luvus`；固定 `v0.14.3` 标签对象 `16a610ec06667203c35f07465247089af2e881b5`，对应源码 commit `54003ce9568acb2977e4bbdbb30a61f99faa0465`。
- 官网/API 的云网络失败没有被当作无路可走：官网 curl 返回 403，api.github.com CONNECT 返回 403；git 与 raw.githubusercontent.com 可读。早期未带版本的猜测 asset URL 为 404，后按官方安装脚本核实准确名称。正确 release 产物首次 503，后续普通重试成功；没有更改代理、网络策略或权限。

官方地址及全部 schema 源码对照见 [provenance.json](provenance.json)。具体产物：

| 项目 | 值 |
|---|---|
| archive | `luvus-v0.14.3-x86_64-unknown-linux-musl.tar.gz`，6,469,203 bytes |
| archive SHA-256 | `1d96580525f23b21143c05850dbd9a1b4fe95e66d7e173dc27aab6caf9b676bf` |
| binary SHA-256 | `895073022da8edd231c9d4c810d68627b954b61e4e9f9f2d5d19e2c2fcf282a9` |
| 安装 schema 原文 SHA-256 | `00e3bb8862b9f3602164bdbe3f11cd7b466e7f7098aa2942dd3878d0b1abdbe6` |
| binary / server | CLI、server status、原生 ping 均为 `0.14.3` |
| UHP | session、Host 均 `luvus-uhp 1.0` |

checksum 来自同一官方 HTTPS release，实际 `sha256sum --check` 为 OK；没有声称验证独立签名或构建证明。未执行官方 installer，仅读取其版本化 asset 规则；binary 解压在 `/tmp`，无全局安装/升级。源码只作只读版本/契约核对，没有执行其中的外部说明。

## 原生验收证据索引

交付目录：[fixtures/p0/linux-luvus-0.14.3](../../fixtures/p0/linux-luvus-0.14.3)。`transcript.json` 保留每个 CLI 的 argv、stdin、stdout、stderr、退出码、超时标记和耗时，以及 Unix socket 的完整 LF request/response/event、EOF、关闭、身份检查和 server 生命周期。

| 验收点 | transcript label / channel | 实测结果 |
|---|---|---|
| 无 server 的 schema | `installed-schema` | exit 0；29 文档离线编译并与固定源码 JSON 对等 |
| 无 server 的 Host | `host-capabilities-before-server`、`host-info-before-server`、`host-session-list-before-server` | Host 17 方法，version 0.14.3；前后 session list 均无 running |
| 无 server 的普通 RPC | `session-rpc-before-server` | exit 1，stdout 空、stderr 说明没有 server；不是 UHP response |
| 发现 endpoint | `discovery-startup` + `endpoint_validation` + `peer_credentials` | 只选择自建 named session；mode/uid/路径组件、inode/ctime、SO_PEERCRED 均验证 |
| 普通 RPC/framing | `direct-ping`、`proxy-ping`、`proxy-two-requests` | 单个 LF response 后 EOF；CLI exit 0；双输入只处理首个 |
| 原生失败 | `proxy-no-final-lf`、`proxy-malformed-json`、`proxy-unknown-method` | 前两者进程错误无 response；未知方法原生 invalid_request + 相同 id + exit 1 |
| 事件与 snapshot | `events-primary`、`events-independent`、`snapshot-before-create`、`snapshot-after-create` | 两订阅收到同一 created sequence；snapshot fence 前的事件可丢弃 |
| after_sequence | `events-replay` | 从 snapshot fence 重放，与原订阅 closed event 完全相同 |
| 终端观察 | `terminal-observe` | ack → terminal.frame → content_revision 前进 → terminal.closed → EOF |
| 终端身份 fence | `control-stale-generation`、`control-wrong-terminal` | 原生 `stale_server` / `stale_terminal` 拒绝 |
| 原生租约 | `terminal-control`、`control-lease-conflict`、`control-reacquire-0` | 第二控制者 `control_conflict`；关闭第一连接后可重新获租约 |
| 输入 ack/消费 | `terminal-control` 的 `input-1` + observe frame | ack dispatch=queued；自建 Python 子进程输出 `CONSUMED:321cba-tupni-0p` 证明实际消费 |
| 非法 control frame | `input-invalid` | `invalid_params`；没有降级成任意命令 |
| 原生超时 | `native-wait-timeout` | timeout_ms=30，实测约 31 ms；原生 timeout error、exit 1 |
| 桥接 deadline | `client-deadline`、`validate-after-deadline` | 50 ms deadline，约 51 ms，proxy SIGTERM exit -15；终端仍 alive |
| 显式关闭/拒绝旧输入 | `terminal-close`、`validate-after-terminal-close`、`input-after-close` | close executed；终端 gone；旧身份输入被拒绝 |
| 清理 | `server_exit`、`discovery-after-cleanup` | server exit 0；无 running session；临时根删除 |

输入只使用固定合成字符串。子进程是固定 Python stdin→反转文本的程序，未启动 agent/provider。snapshot 中出现的默认 shell 与测试 pane 都来自全新实例。没有用户已有会话、真实登录、付费请求、认证 token 创建或 Host 高风险自动确认。

694 条动态断言中含反复执行的 endpoint 路径/权限检查，**不是 694 个不同协议场景**。离线回放实际校验 30 条合规请求、29 条原生响应、23 条事件；另外 2 条有意非法方法/action 被 schema 拒绝。无 LF、非法 JSON 和被终止进程的空 stdout 单独保留，不能制造 response 补齐。

## 运行与重放

先审查固定版本的官方来源，常规下载与校验方式如下；变量仅指向新建临时目录：

```sh
P0_DIST=$(mktemp -d /tmp/luvus-p0-dist.XXXXXX)
curl -fL --max-time 60 https://github.com/RizRiyz/luvus/releases/download/v0.14.3/luvus-v0.14.3-x86_64-unknown-linux-musl.tar.gz -o "$P0_DIST/luvus-v0.14.3-x86_64-unknown-linux-musl.tar.gz"
curl -fL --max-time 60 https://github.com/RizRiyz/luvus/releases/download/v0.14.3/luvus-v0.14.3-x86_64-unknown-linux-musl.sha256 -o "$P0_DIST/luvus-v0.14.3-x86_64-unknown-linux-musl.sha256"
(cd "$P0_DIST" && sha256sum --check luvus-v0.14.3-x86_64-unknown-linux-musl.sha256)
tar -tzf "$P0_DIST/luvus-v0.14.3-x86_64-unknown-linux-musl.tar.gz"
# 本次列表只有一个普通文件 luvus；只解压该条目。
tar -xzf "$P0_DIST/luvus-v0.14.3-x86_64-unknown-linux-musl.tar.gz" -C "$P0_DIST" luvus
```

本次实际执行的完整采集命令（output 必须不存在，拒绝覆盖已审核 fixture）：

```sh
python3 scripts/p0/collect_native.py --binary /tmp/luvus-issue3-dist/luvus --output fixtures/p0/linux-luvus-0.14.3
```

在相同 Linux 环境重新采集时使用新的 output，例如 `/tmp/p0-rerun-<唯一名>`；不要直接覆盖已提交证据。脚本固定核对已审核 binary SHA，只在 `/workspace` 下新建 0700 状态根，使用 `p0-issue3` 显式 session 和完全构造的子进程环境，不继承调用者的 HOME 配置选择器；这不构成 OS 文件访问沙箱。复核修复后的 `finally` 先关闭流、终止所启动 server、确认无 running 并删除根，再保存成功或失败记录，避免发现/写输出异常跳过删除。路径参数只接受固定 binary 和新输出目录，没有用户 endpoint/session 输入。它只支持这次已测 Linux 版；不是生产 adapter。

离线验证与账本生成：

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run test:p0
npm run p0:audit
node scripts/p0/audit-fixtures.mjs --write
node scripts/p0/sdk-compatibility.mjs --write
```

`p0:audit` 不启动 Luvus、不联网，只回放已审核 fixture。`test:p0` 含真实 SDK stdio 子进程探针和采集器 endpoint 拒绝单测；后者的合成 socket 明确不算 Luvus 原生证据。写账本和 SDK 报告的两条命令仅用于更新调查交付；CI/审阅应使用不带 `--write` 的审计。

## 已执行检查与失败记录

| 命令/检查 | 实际结果 |
|---|---|
| `git fetch origin feat/reviewed-core-foundation` / `git rev-parse` | exit 0，精确匹配已验收 SHA |
| release `sha256sum --check` / `--version` | exit 0 / 0 |
| `npm ci --cache /tmp/luvus-issue3-npm-cache` | exit 0，103 packages |
| `npm run typecheck` | exit 0 |
| `npm test` | exit 0，20 passed / 0 failed |
| `npm run build` | exit 0 |
| `npm run test:p0` | exit 0，Node 5 passed + Python 5 passed |
| 原生最终 collector | exit 0，694 assertions，无失败断言 |
| `npm run p0:audit` | exit 0，29 documents / 30 requests / 29 responses / 23 events / 2 intentional invalid |
| 29 个安装 document 对固定标签源码 JSON 对等 | 全部通过，逐文件源码 hash 已保存 |
| delivered fixture 定向审查 | 无原临时路径、私人 home 路径或密钥形态内容；全部 request 没有 auth |
| `git diff --check` | 通过 |

开发中的第一版 collector 假设离线 RPC 会返回 JSON，实际 stdout 为空而发生 JSONDecodeError；修正为保留进程错误后继续。此为采集器假设错误，未抹掉最终 transcript 的真实离线失败。审查事件 schema 时也发现 `terminal.frame` 不在一般 event_catalog，已改为使用其专门 terminal event schema。两者都不计为原生产品通过/失败统计。

## 脱敏、来源与覆盖规则

- `schema-bundle.json` 保留安装 CLI 原文字节，hash 与采集时一致；自带的文档说明仅作为数据，不执行其中指令。来源为 Apache-2.0，保留 [LICENSE.luvus](../../fixtures/p0/LICENSE.luvus)。
- 实例根路径替换为 `/fixture/issue3`，binary 路径替换为 `/fixture/bin/luvus`。仅保留本次生成的非敏感 generation、terminal_id、PID、UID、sequence、模式、输入和输出；没有 token/prompt/私人配置。
- CLI record 的 `raw_*_sha256` 是替换前字节哈希；交付文件的字节哈希与长度由 `manifest.json` 记录，不能用前者验证已替换路径的 stdout。schema 原文未替换，两者可直接核对。manifest 是本地完整性清单，不是第三方签名。
- 账本来源是安装方法枚举与两个实时 profile 的并集；当前 223 = 197 session + 17 Host + 9 access_machines，四个持久流明确单列。每行含 schema URL/条件分支、原生 access/scope/idempotent、采集 request id/outcome、网关实现及策略状态。
- **所有网关实现仍为 not_implemented，所有网关权限仍为 not_enabled。**方法被 collector 调用过不等于已接上 Gateway。144 行 `generic_params_only` 单独暴露；原因字段优先登记凭据/管理员/profile 禁用，再登记 schema 缺口。
- 新版本必须重新采集、审查方法及流分类、重新编译完整引用闭包；未知方法/profile/schema 失败关闭，不靠名称前缀自动授予读写权限。生成器当前只审核过这份固定 0.14.3 输入，不保证自动接受未来 schema。

## 网站、版本与设计差异

| 比较项 | 调查结果/处理 |
|---|---|
| 官方 UHP getting-started / terminal 网页 | 本次抽查的单帧 proxy、独立 Host、subscribe→snapshot、终端 fence/lease 与 0.14.3 实测相符。没有做整站全字段差分，未核验字段保持未知 |
| 网站链接到 main 的 schema | 不是冻结契约；只采用安装版并对照固定 tag，未升级 binary 消除差异 |
| `server status` socket vs discovery | status 展示 `luvus-client.sock`；`session list --json` 的 endpoint 是 UHP socket。后者才是本次流连接入口 |
| 完整 method 枚举 vs 参数 schema | 223 项枚举中仅 79 个有条件分支，其余 144 个不是完整方法参数验证 |
| MCP 2026-07-28 vs SDK 1.32.1 | 规范存在，SDK 不在支持列表；实测协商 2025-11-25，详见 ADR |
| 原 package engines 的 Node 26 | 本次未测且当前官方列为 Current；本任务收窄到 Node 24 LTS 开发基线 |
| 基础层 envelope | 保留原实现；P0 证据不能使其自动成为已认证、完整 UHP 验证或 minor 协商实现 |

官方来源：[安装](https://luvus.dev/docs/getting-started/installation/)、[release 0.14.3](https://github.com/RizRiyz/luvus/releases/tag/v0.14.3)、[UHP 入口](https://luvus.dev/docs/uhp/getting-started/)、[终端](https://luvus.dev/docs/uhp/terminal/)。MCP/依赖规范与决策见 [ADR 0001](../adr/0001-p0-version-and-contract-baseline.md)。

## 平台矩阵与未完成门禁

| 平台/能力 | 已测 | 未测/下一步 |
|---|---|---|
| Linux Debian 13.6 x86_64 | 官方 0.14.3 musl、RPC/Host/events/control、UID/mode/peer PID | 其它发行版、ARM、长路径 `/tmp` alias、攻击性竞态/洪泛/背压、重启代际故障注入 |
| macOS | 无 | 从本机发现 Unix socket；检查 `/private/tmp` alias、symlink/规范化、peer 身份，重跑全部原生用例 |
| Windows | 无 | local named pipe，不接受远程 pipe；验证 owner/System DACL、server PID/token SID；不能用 POSIX mode 替代 ACL |
| MCP SDK stdio | 固定 SDK 客户端 ↔ 独立 SDK server | 尚不是 Luvus Gateway E2E；具体商业 Host/version 待选择 |
| WebSocket/TLS/HTTP/OAuth | 版本锁与规范调查 | 未启动 listener、未发证书、未创建凭据、未测公网或认证 |
| 双机/流治理 | 仅此一台临时 Linux 实例 | 两台真机、跨机器同 pane ID、流背压/overflow/gap、server restart、上传/图片、TUI 竞争仍待后续阶段 |

没有阻断本次 Linux 采集的外部前提。以下输入需用户在对应后续任务决定，不应现在索取账户秘密：Gateway 位置/域名、首批 OS、MCP Host/版本、OAuth 服务、两台测试机器及其可用性。最小解除方式分别是给出选择并提供受控测试环境；登录、凭据签发、权限/安全设置变更仍须独立授权。

截至本次交付，没有调用发布、push 或 merge。用户指定的后续 `GPT-6.1 sol / xhigh` 设置由父会话通知已保存；本工具环境没有可独立核验的当前轮模型标识，因此不将该设置写成已验证运行型号。
