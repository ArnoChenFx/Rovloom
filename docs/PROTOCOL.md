# 协议总览

三层接口各有一份细则；本页只给出现行事实的总览与入口，细节以细则和源码类型为准。系统语义以 [DESIGN](DESIGN.md) 为准。

```
AI 客户端 ──MCP Streamable HTTP──▶ Gateway ──Wire v2 (WSS)──▶ Connector ──原生契约──▶ Luvus / Herdr
```

## 1. MCP（客户端 ↔ Gateway）

- 传输：Streamable HTTP，`http://<mcp.hostname>:<mcp.port>/mcp`，每个请求带 `Authorization: Bearer <令牌>`；令牌由 `rovloom token` 管理（热生效），监听只在回环（远程访问经受信反向代理，见 `mcp.public_url`）。
- 不是 stdio MCP 服务器；客户端退出不影响 Gateway。
- 工具面共 11 个，参数形状见 `src/mcp/schema.ts`：

| 工具 | 作用 |
|---|---|
| `machines_list` / `machines_get` | 当前 caller 可见的设备（分页、计数都经 ACL）；`link` 对活动设备恒为 `unverified`，实时传输状态只在管理页 |
| `providers_list` / `providers_get` | 设备下已配置的 provider（kind、revision、readiness） |
| `runtime_discover` | 显式 Target + revision 下的有效能力与来源，不授予执行权限 |
| `runtime_describe` | 精确方法的原生参数、分类和限制 |
| `runtime_call` | 提交一次原生调用（显式 Target/revision/契约、绝对 `deadline`、可选 `client_request_key` 幂等键、`wait_ms` 短等） |
| `runtime_call_get` / `runtime_call_cancel` | 查询、取消 |
| `runtime_result_read` | 按句柄分页读结果（`max_bytes` ≤ 16 KiB，带摘要） |
| `runtime_response_discard` | 丢弃已保存的响应正文 |

- 调用终态：`responded`、`not_dispatched`（确定未写出）、`outcome_unknown`（可能已执行，**不会自动重发**）。同一 `client_request_key` + 同一意图返回原调用，不同意图为 `conflict`。
- 细则：[MCP Streamable HTTP 契约](protocol/MCP-HTTP.md)。

## 2. Wire v2（Gateway ↔ Connector）

- 传输：Connector 主动出站的 WebSocket（`ws://`/`wss://`，路径 `/connector`），每条消息一个 UTF-8 JSON envelope。
- 版本：单一 major 2；minor 取双方交集；能力（`rpc`、`dispatch_refusal`、`provider_snapshot`、`terminal_execution_state`、`provider_fence`、`late_evidence`）取双方广告的交集，未知 required 能力拒绝。不提供 v1 兼容。
- 限额：单帧 1 MiB（`LIMITS.frame_bytes`）、JSON 深度 64、节点 10 万；超限响应不截断，调用保持 `outcome_unknown`。
- 已认证帧都带 `machine_id`、`recovery_generation`、`connection_epoch`，逐项核对当前认证连接；心跳 5 秒，空闲 20 秒判断线。
- 细则：[Wire 协议](protocol/WIRE-PROTOCOL.md)、[通道接线](TRANSPORT.md)。

## 3. 原生契约（Connector ↔ Luvus / Herdr）

- 契约来自本机安装的程序（Luvus `uhp schema`、Herdr `api schema --json`），在 Worker 里用锁定的 Ajv 完整编译（冷编译约 0.7 秒，期限 10 秒）；Gateway 对照配对时批准的实测来源核对，任何版本/平台经批准后可用，不写死版本。
- 方法按静态表分为 `read / write / terminal / admin`，未知方法拒绝；`allow_terminal_execution` 默认关，见 [终端执行](TERMINAL-EXECUTION.md)。
- Luvus 经本机 IPC（Unix socket / Windows 命名管道），Herdr 经其 API 管道；对端身份（同用户、同一可执行文件）在附着时证明。
- 细则：[原生契约](protocol/NATIVE-CONTRACT.md)、[Luvus 本地适配](protocol/LUVUS-LOCAL-ADAPTER.md)、[Luvus 操作装配](LUVUS-OPERATIONS.md)。

## 4. 配对（Gateway ↔ Connector 的专用 HTTP）

`/pairing/redeem|ack|status|native` 只在 Gateway 前台真实终端运行时开放：一次性码兑换设备凭据（持久落盘后才确认）、原生来源批准。重新配对（`--repair-device` / `--repair`）与加入下一台设备（`--add-device`）复用同一组端点。细则见 [Quick Start](QUICK-START.md) 与 [配置参考](CONFIGURATION.md)。
