# Luvus 本机窗口和 Agent 装配

`createLuvusProductionSources()` 供唯一 CLI 的 `ProductionCliSources` 静态调用。
它消费 CLI 已解析的 `{reference,value}`，不读取第二份 CLI 配置、不实现 MCP/HTTP
入口。Gateway 返回 `providers/release`；Connector 返回去掉 `transport` 的
`ConnectorRuntimeOptions`。Connector 首版明确只接受一个引用；Gateway 可连接多个
明确已有的本机实例，拒绝重复完整 Target。

受保护引用的最小 JSON 如下。`reference` 必须与原 root record 内
`config.config_ref` 完全相同；binary、HOME、状态根、完整 Target、binding revision
只读取原 root record，不接受 caller 提供的替代路径或默认 session。

```json
{
  "reference": "local_luvus",
  "value": {
    "kind": "luvus",
    "authentication": "local_owner",
    "native": {
      "mode": "managed",
      "root_record": "/srv/rovloom-control/root.json",
      "expected_root_id": "registered_root_id",
      "expected_root_revision": 1
    },
    "peer_policy_revision": "local_policy_v1",
    "principal_id": "operator",
    "policies": {
      "caller": {
        "revision": "caller_policy_v1",
        "grants": [{
          "target": {"machine_id":"machine1","provider_id":"provider1","profile":"session","session":"work"},
          "methods": ["workspace.list","agent.list","agent.prompt","agent.read"],
          "actions": ["dispatch","read"]
        }]
      },
      "local": {
        "revision": "local_policy_v1",
        "grants": [{
          "target": {"machine_id":"machine1","provider_id":"provider1","profile":"session","session":"work"},
          "methods": ["workspace.list","agent.list","agent.prompt","agent.read"],
          "actions": ["dispatch","read"]
        }]
      }
    },
    "storage_mode": "open"
  }
}
```

Connector 使用 `native.mode=managed`，通过既有 `startManagedLuvus` 启动并持有实际
child。Gateway 对同一本机 root 使用 `native.mode=attach`，通过
`attachExistingLuvus` 核对实际内核 peer、固定安装、启动目录和环境；不会再次启动
native。Gateway 关闭只释放观察者，Connector 关闭必须等待真实 child 退出确认。
本机 Owner 是显式身份模式，缺 token 不触发回退，也不签发 token 或消费有限批准。

`storage_mode=create` 仅用于明确首次建立 Connector 记录；既有文件会拒绝覆盖。
正常启动必须 `open`。固定文件为 CLI `state_dir` 下的 `luvus-claims.db` 和
`luvus-admissions.json`，各自默认 1024 条、4 MiB；缺任一库、崩溃锁或不一致均拒绝，
不自动重建。该目录必须与原生 HOME、状态根和工作目录分离。关闭不删除持久事实。

两端资源均返回 `admission_context:true`，唯一入口据此把 `rpc`、`admission_receipt`、
`admission_context` 同时放入 WSS offer 的 `capabilities` 与 `required`。工厂不修改
CLI 维护的 transport 配置；未协商完整快照时拒绝建立准入 ledger。协议默认 offer
仍可保持 `rpc`，生产装配不会降级到缺少认证原截止的路径。

每个认证 epoch 使用独立原 Wire 后端；principal 固定于受保护完整 Target 路由。
持久 receipt 保留 Gateway 原 principal、登记摘要、原 ResponseAnchor 和三个固定
截止，claims 只使用该原 dedup 截止。断连不重放、不刷新期限，旧 epoch 不复活。
唯一 CLI 仍须让自己的 caller/local policies 与此引用精确一致，不能靠设备认证
建立 caller 授权。

Gateway 方法目录由 runtime 使用真实 `transport.currentConnection`、唯一 Store
和 provider `catalogSource` 建立。唯一入口应消费
`resource.catalog ?? gateway.catalog`；本工厂不通过伪造 attempt 或 connection
提供另一份目录。

普通方法清单与参数子集见
[luvus-operations.ts](../src/runtime/luvus-operations.ts)。官方 generic 参数契约保持
`raw-contract` 事实，由精确普通方法 guard 和真实 Owner 当前来源共同限制，不把
generic 外壳称为严格参数契约。两轮 Agent 对话应保存相同完整 Target、native
generation、选定 pane/alias、`terminal_id` 和已知 native `session`；`ready=true`
只表示识别就绪，`submitted/queued` 不表示 prompt 已消费或回复完成，应继续读真实
状态与输出。上游模型失败不触发重发或切换收费模型。

## 方法、选择和状态映射

Luvus 没有 `window.*` RPC；窗口选择沿原生 workspace → tab → pane 层级进行。

| 需求 | 普通 RPC | 原生字段 |
|---|---|---|
| 发现与选择 | `session.snapshot`、`workspace.list/get`、`tab.list/get`、`pane.list/get/current` | workspace 为零基位置，tab 为一基位置；pane 行使用 `pane`，保存 `workspace_id/tab_id/terminal_id` |
| 窗口管理 | `workspace.new/open/focus/rename/close`、`tab.new/focus/rename/close`、`pane.split/focus/rename/close` | 显式完整 Target 与 pane，不按标题或最近对象重选 |
| 状态及输出 | `pane.status/read`、`agent.list/get/explain/read/sessions/wait` | 原样使用 `status/authority/state_source/session`；terminal_id 从 agent.list 取得，未知 session 保留 null |
| Agent 操作 | `agent.start/prompt/send/keys/resume` | start 的 pane/anchor 互斥；prompt/send/keys 可绑定 terminal_id；resume 仅用于显式选择已有 session |

`pane.read` 只接 `pane/lines`；`agent.read` 接 `target/lines/source`，返回真实
`text/content_revision/terminal_id`。prompt 的 `until/timeout_s` 必须配合 `wait:true`。
同一 Agent 的等待串行执行；超时、queued 或 observed_state 不能代表模型回复完成。
两轮须核对完整 Target、server_generation、选定 pane/alias、terminal_id 和有值时的
Agent session；第二轮验证真正回复对第一轮随机内容的记忆，不能以终端回显代替。

## 隔离复核

先执行 `bun --no-env-file run build`，再从仓库根执行：

```sh
bun --no-env-file scripts/runtime/verify-luvus-operations.mjs \
  --binary /absolute/protected/luvus \
  --temporary-parent /absolute/protected/parent \
  --acknowledge-nonproduction
```

维护脚本只从构建产物调用公开工厂，在自有空白实例及合成身份上核对真实 WSS、
窗口/pane/Agent 发现、原生状态、实际 epoch 目录及原 Wire 结果分页。它不配置模型
Agent，因此不代表同 session 真实模型两轮验收。当前工厂是明确的同机 Gateway
attach + Connector managed 组合；跨机 Gateway 的独立 native 来源不能由本机
`/proc` 或设备广告补造。
