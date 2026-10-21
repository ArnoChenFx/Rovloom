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
| `connector-crash` | `kill -9` 且 native 一并消失：Gateway 立即判不可用；**重启被拒（退出码 3，fail-closed）**；运维清理遗留记录后恢复 |
| `device-revoke` | Gateway 停止后经正式 Store 撤销设备，重启后设备为 `revoked`，调用不可达，Connector 持续重试而不得服务 |
| `unknown-outcome` | native 已收到请求但未应答时 Connector 被杀：调用为 `outcome_unknown`；Connector 重启后状态不变，新 native 收不到该请求（不自动重发） |

## 已记录的结果（2026-10-21，Linux 6.18 x64，Bun 1.4.3，Herdr 0.9.5）

7/7 通过。过程中发现并修复一个产品缺陷：同 key 不同意图的 `request_key_conflict` 原先以 `internal_error` 暴露，
现映射为公开码 `conflict`。

## 诚实的边界

- **单台主机**：Gateway 与 Connector 是两个独立进程，状态目录、`HOME`、`PATH` 各自独立，经真实回环 WebSocket 通信，
  但不是两台物理机；“Gateway 未安装 runtime”以空 `PATH` + 只含单文件产物来体现，不等同跨机网络（NAT / TLS / 防火墙）。
- **没有 Luvus 链路**：环境中没有可获取的真实 Luvus 二进制，故 Luvus 的 discover → read 链路未在此验证（Herdr 为唯一原生）。
- **设备撤销是离线撤销**：管理员写入走带确认的 HTTP 管理接口，这里停 Gateway 后用正式 `Store.revoke` 代替，没有走 WebUI。
- **崩溃恢复不是自动的**：Connector 在 `kill -9` 或整机掉电后，遗留的 owner 记录、native 端点与 claim 账本锁会使重启
  fail-closed；需要运维手动清理（`connector-crash` 场景列出具体文件）。这是有意不做“按 PID/JSON 接管”，但对运维不友好，见 [#167](https://github.com/ArnoChenFx/Rovloom/issues/167)。
- **真实 Agent（LLM）调用未覆盖**：本环境网络策略屏蔽了模型 API 域名，e2e 使用 MCP SDK 客户端而非 LLM Agent。
- `unknown-outcome` 证明“新 native 未被重发”；被暂停后又恢复的旧 native 是否执行了该请求，不在 Rovloom 可观察范围内
  （这正是 `outcome_unknown` 的含义）。
