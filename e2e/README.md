# 端到端验收（e2e）

不属于单元测试门禁。用**真实发布产物**、**官方 Herdr 0.9.5**、**官方 MCP SDK 客户端**走完整链路，并制造故障。
每个场景独占一套全新状态（独立 Gateway / Connector 目录、空 `PATH`、空 `HOME`、新端口、新凭据）。

## 运行

```sh
bun --no-env-file run release:build                      # 产物：dist/release/bun-linux-x64/candidate/rovloom
curl -L -o /tmp/herdr https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-linux-x86_64
bun --no-env-file e2e/run.mjs dist/release/bun-linux-x64/candidate/rovloom /tmp/herdr [场景名...]
```

Herdr 二进制必须是固定的 0.9.5（SHA-256 `14d9e8bc…929d`，夹具会校验）。仅支持 Linux x64。
输出为每个场景一行 JSON（含证据与耗时），最后一行汇总环境与是否全部通过。

## 场景

| 场景 | 验证 |
|---|---|
| `full-chain-herdr` | machines → providers → discover → describe → call → get → result_read（摘要校验）；有副作用的 `workspace.create` 用 `session.snapshot` 读回；关闭终端开关时目录隐藏 `pane.send_text` |
| `idempotent-retry` | 同 `client_request_key` + 同意图返回同一 `call_id` 且原生只执行一次；同 key 不同意图 → `conflict`；无 key 不合并 |
| `terminal-switch` | `allow_terminal_execution:false` 时 `pane.send_text` → `not_dispatched`，连接与只读调用不受影响；改配置重启后同一调用放行 |
| `connector-restart` | 正常停止后 native 子进程被回收；离线调用立即 `unavailable`（毫秒级，不挂起）；重启后恢复 |
| `connector-crash` | `kill -9`：Gateway 立即判不可用；孤儿 native 仍在监听时**重启被拒（退出码 3，fail-closed）且不触碰孤儿**；native 也消失（等同掉电）后重启自动清理遗留并恢复 |
| `attach-existing` | 用户已运行 Herdr：Connector 附着它（不再起第二个）；Connector 退出后用户的实例继续存在 |
| `attach-create-persist` | 没有实例：Connector 自建并放手；Connector 退出后仍运行，重启后附着同一个（之前创建的 workspace 还在） |
| `attach-recover` | 附着的实例被 `kill -9`：Connector 自行重建并结束当前连接周期，数秒内调用恢复，Connector 进程不退出 |
| `device-revoke` | Gateway 停止后经正式 Store 撤销设备，重启后设备为 `revoked`，调用不可达，Connector 持续重试而不得服务 |
| `unknown-outcome` | native 已收到请求但未应答时 Connector 被杀：调用为 `outcome_unknown`；Connector 重启后状态不变，新 native 收不到该请求（不自动重发） |

## 从零部署（真实首次配对）

默认场景用预置夹具跳过首次配对。`e2e/quickstart.py` 则按 Quick Start 在真实 pty 终端里走完整流程：
自动创建 Connector 用户文件 → 选择 Herdr → Gateway 批准配对 → Connector 输入地址与一次性码 → 发现并初始化原生
→ Gateway 批准 → `connector_ready`。Herdr 不写 `runtime_bin_dirs`，由 `PATH` 自动发现。

```sh
python3 e2e/quickstart.py --binary dist/release/bun-linux-x64/candidate/rovloom --herdr /tmp/herdr \
  --then "bun e2e/agent-session.mjs <opencode可执行文件>"
```

`--then` 会拿到 `MCP_CONFIG`（URL、Bearer、target）。`agent-session.mjs` 让 opencode + DeepSeek 经 MCP 完成
list → discover → ping → 读结果，再由独立 MCP 客户端取真实版本核对 Agent 的回答。

这条路径发现过夹具掩盖的三个产品缺陷（均已修复并有回归测试）：Gateway 返回非 200 时 Connector 因响应流已锁定而崩溃；
Herdr 自建端点目录按宿主 umask 为 0755 被 0700 门禁拒绝；Herdr 私有 socket 路径检查漏算更长的 `herdr-client.sock`。

`--repair` 在就绪后重新配对同一设备（`rovloom gateway --repair-device` + `rovloom connector --repair`，均在 pty 里）：断言本机凭据文件被替换、
`connector_ready` 再次出现，并用**未改变的 MCP Bearer** 跑 `--then` 链路（授权与原生设置不变）。

## 两台“机器”（独立容器、真实 TCP）

`e2e/two_host.py`（CI：`.github/workflows/two-host.yml`）把 Gateway 和 Connector 放进两个 Docker 容器：各自独立的文件系统（互相看不到对方的数据目录、凭据和程序），
只通过 Docker 网络上的真实 TCP 通信；Gateway 容器里没有 Herdr，设备监听 `0.0.0.0`，Connector 用容器 DNS 名 `ws://rv-gw-…:9443` 连接。
配对仍在两个容器的真实 TTY（`docker run -it`）里按 Quick Start 完成；MCP 只在 Gateway 的回环上（设计如此），客户端容器共享该网络命名空间，用官方 MCP SDK 走完整 Herdr 链路。
随后 `docker network disconnect` 把 Connector 摘出网络：Gateway 在空闲超时（20 秒）内发现，新调用立即不可用而不是悬挂（记录值约 19 秒）；接回后数秒内自动恢复。

## 真实 Luvus 链路

```sh
curl -L -o /tmp/luvus.tgz https://github.com/RizRiyz/luvus/releases/download/v0.14.3/luvus-v0.14.3-x86_64-unknown-linux-musl.tar.gz
tar -xzf /tmp/luvus.tgz -C /tmp luvus   # SHA-256 895073022da8edd2…，与仓库固定的官方摘要一致
LUVUS_WRITE='{}' python3 e2e/quickstart.py --work ~/.rq1 --binary dist/release/bun-linux-x64/candidate/rovloom \
  --luvus /tmp/luvus --then "bun --no-env-file e2e/luvus-session.mjs"
```

加 `--crash` 会在就绪后 `kill -9` Connector 再重启：Luvus 的 claim 锁与 owner 锁由新 Connector 自行接管，随后的读写调用照常通过（不加则无此项）。

`--luvus` 走 Quick Start 的默认 Luvus 引导（隔离状态，不动你的 Luvus）。Luvus 的状态路径上限 52 字节，所以脚本把
`data.directory` 改成 `<work>/d`，`--work` 请用短路径。`luvus-session.mjs` 经 MCP 完成 machines → providers →
discover（33 个方法）→ describe → `workspace.list` → `session.snapshot`；设置 `LUVUS_WRITE` 后再 `workspace.new` 并读回
workspace 计数（1→2）。

默认（`--luvus-mode attach`）走附着方式：没有实例时 Connector 在 Connector 用户的 `~/.luvus` 里自建 default 会话。
附加选项把附着链路的几种情形也跑一遍（都用真实 Luvus 0.14.3，`LUVUS_WRITE='{}'` 读回写入）：

- `--pre-existing`：先像用户那样启动 `luvus --session default server`，部署后断言 Connector 附着了它（进程不变、没有第二个）。
- `--pre-existing --kill-luvus`：就绪后 `kill -9` 该 server，断言 Connector 自行重建（新 PID）并重连，随后的读写调用通过。
- `--crash`：就绪后 `kill -9` Connector 再重启，断言 claim 锁自动接管并重新附着仍在运行的 Luvus；`--luvus-mode managed` 则是隔离实例的同一验证。

Luvus 故障场景（`--pre-existing`，经 `e2e/luvus-faults.mjs` 分步驱动，同样用真实 Luvus 0.14.3）：

- `--unknown-outcome`：先对 Luvus server 发 `SIGSTOP`，再提交 `workspace.new`，随后 `kill -9` Connector 并恢复 Luvus、重启 Connector。断言该调用收敛为
  `outcome_unknown`，workspace 数最多比调用前多 1 且 10 秒内保持稳定（没有第二次执行），同一设备上的新写调用照常成功。
- `--revoke`：停止两个角色，经正式 Store 离线撤销设备，再重启。断言 `machines_get` 为 `revoked`、调用被拒绝、Connector 始终不会就绪。

这条路径发现过两个只有真实 Luvus 才暴露的缺陷（均已修复并有回归测试）：Luvus 自建 `sessions` 目录继承宿主
umask（022 → 0755）而被 0700 门禁拒绝，托管 Luvus 在普通用户环境根本起不来；MCP 默认 `validation:"strict"` 与
Luvus 通用方法要求的 `raw-contract` 不符时，Wire 编码失败发生在派发之后，调用变成 `outcome_unknown` 并断开设备连接
——现在省略 `validation` 按方法选择，显式不符在登记前拒绝。

## 真实 LLM Agent（可选）

```sh
npm i opencode-ai   # 放在仓库之外的临时目录
DEEPSEEK_API_KEY=… bun e2e/agent.mjs dist/release/bun-linux-x64/candidate/rovloom /tmp/herdr <opencode可执行文件>
```

provider 与模型在 opencode 配置中显式声明并关闭模型目录拉取（`models.opencode.ai` 在受限网络下不可达）。
密钥只经环境变量传入，Agent 只继承代理/证书变量。通过条件由 Rovloom 侧独立读回，不采信 Agent 自述。

## 已记录的结果（2026-10-21，Linux 6.18 x64，Bun 1.4.3，Herdr 0.9.5）

7/7 通过；真实 Agent 冒烟通过（opencode 1.19.3 + deepseek-chat，29 秒，workspace 0→1）。过程中发现并修复一个产品缺陷：同 key 不同意图的 `request_key_conflict` 原先以 `internal_error` 暴露，
现映射为公开码 `conflict`。

## 诚实的边界

- **单台主机**：默认场景里 Gateway 与 Connector 是两个独立进程，经回环 WebSocket 通信；“两台机器”场景用两个容器（独立文件系统与网络命名空间、真实 TCP）
  验证了跨网络路径，但仍在同一台宿主上，不等同真实跨机的 NAT / TLS / 防火墙 / 公网延迟。
- **Luvus 的故障场景**：真实 Luvus 0.14.3 已覆盖首次配对 → 发现 → 描述 → 只读/写调用读回，以及崩溃接管、Luvus 被杀后重建、未知结果不重发、离线撤销（见下节）；“终端开关”“重复请求幂等”这类与 provider 无关的 Gateway 行为只在 Herdr 场景里验证。
- **设备撤销是离线撤销**：管理员写入走带确认的 HTTP 管理接口，这里停 Gateway 后用正式 `Store.revoke` 代替，没有走 WebUI。
- **崩溃自动恢复仅限 Linux**：证据是 owner 进程已死（PID + 内核启动 tick）且端点无监听；其它平台、旧格式记录、孤儿 native 仍活着时保持 fail-closed（见 [#167](https://github.com/ArnoChenFx/Rovloom/issues/167)）。
- **LLM Agent 单独脚本**：`e2e/agent.mjs` 让 opencode（1.19.3，DeepSeek `deepseek-chat`）经 MCP 完成 list → discover → ping → `workspace.create`，再由独立 MCP 客户端读回 workspace 数（0→1）。依赖模型 API 域名可达与 `DEEPSEEK_API_KEY`，不在默认场景集里；模型输出有随机性，仅作冒烟。
- `unknown-outcome` 证明“新 native 未被重发”；被暂停后又恢复的旧 native 是否执行了该请求，不在 Rovloom 可观察范围内
  （这正是 `outcome_unknown` 的含义）。
