# Luvus 窗口和 Agent 角色装配

> 本文描述所属细节的现行实现；系统语义以 [DESIGN](DESIGN.md) 为准，冲突时以 DESIGN 为准（导航见 [文档索引](README.md)，总览见 [协议总览](PROTOCOL.md)）。

`createLuvusProductionSources()` 供唯一 CLI 的 `ProductionCliSources` 静态调用。
它消费 CLI 已解析的 `{reference,value}`，不读取第二份 CLI 配置、不实现 MCP/HTTP
入口。Gateway 返回 `providers/release`；Connector 返回去掉 `transport` 的
`ConnectorRuntimeOptions`。Connector 首版明确只接受一个引用；Gateway 可连接多个
明确配置的本机或远端实例，拒绝重复完整 Target。远端引用不要求 Gateway 安装 Luvus。

Connector 本机 Owner 引用的最小 JSON 如下。`reference` 必须与原 root record 内
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
child。同机 Gateway 兼容模式对同一本机 root 使用 `native.mode=attach`，通过
`attachExistingLuvus` 核对实际内核 peer、固定安装、启动目录和环境；不会再次启动
native。Gateway 关闭只释放观察者，Connector 关闭必须等待真实 child 退出确认。
本机 Owner 是显式身份模式，缺 token 不触发回退，也不签发 token 或消费有限批准。

`storage_mode=create` 仅用于明确首次建立 Connector 记录；既有文件会拒绝覆盖。
正常启动必须 `open`。固定文件为 CLI `state_dir` 下的 `luvus-claims.db`，默认 1024 条、4 MiB；缺库或不一致均拒绝，不自动重建；崩溃锁仅在锁内记录的持有进程已死（Linux，PID + 启动 tick）时自动接管，空锁/旧格式/无法判断仍拒绝。该目录必须与原生 HOME、状态根和工作目录分离。关闭不删除持久事实。

每个认证 epoch 使用独立原 Wire 后端；principal 固定于受保护完整 Target 路由。
Connector 用本机固定保留期的 attempt book 与持久 claims 去重。断连不重放、不刷新期限，旧 epoch 不复活。
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

## 远端 Gateway 的受保护 pin

Gateway 可使用 `LuvusProductionRemoteConfig`，由同一 `createLuvusProductionSources().gateway`
消费已解析引用，返回相同 `providers/release` 资源。以下 `schema_bundle` 占位符须由唯一
配置入口替换为原安装版 schema 的完整 UTF-8 文本；不先 JSON.parse 再序列化。
schema 是可独立交付的固定资料，Gateway 不运行 Luvus、读取 Connector HOME/root、
访问其 socket 或根据远端 JSON 重建本机 Owner。受保护配置仍由唯一入口读取与校验权限。

```json
{
  "reference": "remote_luvus",
  "value": {
    "kind": "luvus",
    "authentication": "remote_connector",
    "binding": {"machine_id":"machine1","provider_id":"provider1","kind":"luvus","config_ref":"remote_luvus","binding_revision":1,"enabled":true},
    "target": {"machine_id":"machine1","provider_id":"provider1","profile":"session","session":"work"},
    "peer_policy_revision": "local_policy_v1",
    "contract": {
      "binary_version": "0.14.3",
      "binary_sha256": "895073022da8edd231c9d4c810d68627b954b61e4e9f9f2d5d19e2c2fcf282a9",
      "schema_sha256": "00e3bb8862b9f3602164bdbe3f11cd7b466e7f7098aa2942dd3878d0b1abdbe6",
      "adapter_revision": "managed-owned-luvus-0.14.3-1",
      "classification_revision": "managed-owned-rpc-1",
      "schema_bundle": "<原始 schema 全文>"
    },
    "raw_grant": {"principal_id":"operator","methods":["workspace.list","agent.list","agent.read"]}
  }
}
```

`binding` 必须与唯一 Store 已注册的 canonical binding 完全一致，设备广告不能注册或重绑。
远端配置固定版本/hash/adapter/classification（标识修订，不再有逐调用分类快照），Gateway 启动时经原 2 秒 Bun Worker
编译固定原字节，监听器可以先启动，provider 保持 `ready=false`。`runtime_generation`
不由静态 pin 猜测；它与原 capabilities envelope 由 Connector 对真实受控实例实测后，
通过当前认证 WSS 的 `provider_snapshot` 交付。

runtime 自动为远端 Gateway 及交付快照的生产 Connector 添加可选能力广告；Gateway
按受保护配置中的 machine 名单协商，远端机器必需快照，本机 attach 机器不协商该能力。
不同设备可分别使用两种来源；同一 machine 的 provider 不可混用本机 attach 与远端模式，
配置在 attach/编译前明确拒绝。需要远端来源的实际 session 未协商该能力即拒绝，已协商却
缺 source/receiver 同样拒绝。一个 provider 每 epoch 只发送一次单帧快照，仍受原 1 MiB
上限约束。Gateway 验实际 SocketChannel、设备认证、Store epoch、完整 binding/Target、
全部 source pin、能力摘要与原 schema；完整能力目录及 34 个普通方法的固定评审均通过后
才安装该 epoch 的来源。Gateway 信任受保护配置指定的 Connector 测量职责，
不声称自己在远端读取了 SO_PEERCRED 或 pidfd。

Connector 保留固定 binary/root/session、实际 socket peer、进程、原生 auth、Wire 和持久
claims 的全部核验。快照深冻结；实例/契约/能力/generation 失效时关闭 WSS，该 epoch
不能更新后继续执行。Gateway 的 ready/source/catalog 每次回到实际通道和 canonical
binding，断连、撤权、重绑或关闭即使旧来源失效；新 epoch 须独立接收快照。
原调用、结果句柄和可能执行但未确认的响应不会迁到新连接或自动重派。

`raw_grant` 是额外的受保护授权，可省略。缺省不授予 generic 方法的 raw 权限；严格
schema 方法仍按正常 ACL 使用。raw 授权只覆盖明确 principal 和方法，实际 permit 仍绑定
当前完整 Target、契约、能力、静态方法表、双方政策、实际 epoch 和原业务 deadline。
此授权不建立 `LocalOwnerLuvusInstance`、发行原生 token 或把 generic 参数称为完整 schema。

同机分目录真实 WSS 回归可在现有 `verify-luvus-operations.mjs` 加
`--remote-gateway --gateway-schema-bundle /absolute/approved/schema-bundle.json`；
仍需原 `--binary`、短私有父目录及非生产确认。Gateway 此时只收到上面的远端引用，
Connector 使用官方 binary。该报告明确 `deployment:same_host_isolated_regression`，
不证明真实两主机或文件系统隔离。两主机验收须另证 Gateway 无 Luvus 安装且不共享
Connector runtime 文件系统，并通过唯一 MCP 入口完成发现、描述、调用及原结果读取。

## 方法、选择和状态映射

Luvus 没有 `window.*` RPC；窗口选择沿原生 workspace → tab → pane 层级进行。
字段以固定官方 commit 的 [topology 选择器](https://github.com/RizRiyz/luvus/blob/54003ce9568acb2977e4bbdbb30a61f99faa0465/src/app/dispatch/topology.rs#L1546)
和 [mutation revision 分发](https://github.com/RizRiyz/luvus/blob/54003ce9568acb2977e4bbdbb30a61f99faa0465/src/app/dispatch.rs#L107)
为准；generic schema 不会另外声明这些完整参数规则。

| 需求 | 普通 RPC | 原生字段 |
|---|---|---|
| 发现与选择 | `session.snapshot`、`workspace.list/get`、`tab.list/get`、`pane.list/get/current` | 优先保存 `workspace_id/tab_id/terminal_id`；snapshot 的 `index` 与其它接口的位置字段坐标不同，见下表；pane.list/get 使用 `pane`，snapshot 使用 `pane_id` |
| 窗口管理 | `workspace.new/open/focus/rename/close`、`tab.new/focus/rename/close`、`pane.split/focus/rename/close` | 变更使用已发现的稳定 ID；可选 `if_revision` 对整个 session 做 CAS。完整 Target 保持不变，不按标题或最近对象重选 |
| 状态及输出 | `pane.status/read`、`agent.list/get/explain/read/sessions/wait` | 原样使用 `status/authority/state_source/session`；terminal_id 从 agent.list 取得，未知 session 保留 null |
| Agent 操作 | `agent.start/prompt/send/keys/resume` | start 的 pane/anchor 互斥；prompt/send/keys 可绑定 terminal_id；resume 仅用于显式选择已有 session |

原生结果原样返回，宿主不统一换算位置字段：

| 原生返回 | 坐标与类型 | 后续选择 |
|---|---|---|
| `session.snapshot.workspaces[].index`、其 `tabs[].index` | 都是**一基 number**；workspace/tab 行不含稳定 ID | `kind:"terminal"` 的 `pane_id` 是 string，可作为 `pane.get` 的 `pane`，从结果取得 `workspace_id/tab_id`；view 的占位 ID 不走此路径 |
| `workspace.list/get` 的 `workspace`；`pane.list/get`、Agent 行中出现的 `workspace` | **零基十进制 string**；`display_position` 另为显示顺序，不是对象 ID | 使用同一行的 `workspace_id`；不要把 snapshot 的一基 `index` 原样传给 `workspace` |
| `tab.list/get`、`pane.list/get` 的 `tab` | **一基十进制 string**；tab.list 只列当前 workspace | 使用 `tab_id`；tab.get 同时返回 `workspace_id` |

同一原生状态下，snapshot 的 workspace index 减一才对应 workspace.list 的位置，
tab index 则同为一基；这只是坐标关系，不能跨变更后用旧位置写入。
参数 guard 保留显式 number 或十进制 string 位置兼容，原样转发，不替调用者自动
换算、focus 或重试。主 Agent 应从 terminal `pane.get` 或最新 list/get 获取稳定 ID；
`kind:"view"` 或没有可解析 terminal pane 的 snapshot 行应重新通过 workspace
list/get 发现，不用占位 ID、标题或旧位置猜测同一对象。

workspace 的 get/focus/rename/close 接收互斥的 `workspace_id` 或 `workspace`。
`tab.get` 接收两组独立互斥选择器：`workspace_id/workspace` 与 `tab_id/tab`，可读取
明确的其它 workspace。tab 的 focus/rename/close **只在当前 workspace** 解析
`tab_id/tab`，不接受 workspace 选择器；当前 workspace 不含该 tab ID 时保留原生
`not_found`，不得隐式切换后重放。`tab.list/new` 不接受 workspace 选择器。

窗口/tab mutation 可带原生 `if_revision`（非负安全整数），读取不接收该字段。
它比较整个 session 的 EventBus sequence，不是某个 workspace/tab 的对象版本；
具体方法执行前，全局序号不等即返回 `revision_conflict`。
[可选全局 CAS 分发](https://github.com/RizRiyz/luvus/blob/54003ce9568acb2977e4bbdbb30a61f99faa0465/src/app/dispatch.rs#L101-L140)
和[事件序号](https://github.com/RizRiyz/luvus/blob/54003ce9568acb2977e4bbdbb30a61f99faa0465/src/ipc/api.rs#L1059-L1082)
表明每个发布事件都会推进序号，成功 mutation 本身却不一定发布事件。PTY ready、
输出或状态等后台事件也可能推进它；紧前 get 的 revision 不保证下一请求仍匹配。
明确按稳定 ID 变更对象时可省略此可选条件；要求“全局观察后未发生事件”时才传入
观察值。显式 CAS 失败须把原冲突展示给用户并重新读取状态，不得去掉条件、自动
换 revision 或重发原变更。以下示例分别展示稳定 ID 选择和可选 CAS，示例值须替换为原生
返回值；跨 workspace 的 tab 写入须先由用户明确选择 workspace，再重新读取状态：

```json
[
  {"method":"workspace.get","params":{"workspace_id":"observed_workspace_id"}},
  {"method":"workspace.rename","params":{"workspace_id":"observed_workspace_id","name":"project"}},
  {"method":"tab.get","params":{"workspace_id":"observed_workspace_id","tab_id":"observed_tab_id"}},
  {"method":"tab.rename","params":{"tab_id":"observed_tab_id","name":"agent","if_revision":43}}
]
```

`workspace.new` 与 `tab.new` 只接可选 `if_revision`，不接 `cwd` 或 workspace
选择器；指定路径使用 `workspace.open({path,focus?,if_revision?})`，`focus` 默认为
true，可明确设 false。新建/open 返回的位置不是稳定 ID，应再次 get/list 发现。

`pane.read` 只接 `pane/lines`；`agent.read` 接 `target/lines/source`，返回真实
`text/content_revision/terminal_id`。prompt 的 `until/timeout_s` 必须配合 `wait:true`。
Connector 本地 `allow_terminal_execution` 默认关闭；普通文本 `agent.send/prompt`
应由 caller 原请求显式指定 `strict:true`，省略或 false 保持上游宽松语义并被拒绝。
不由最终 IO 补参数；`agent.keys` 和自定义启动 argv/env 仍要求所有者明确开启本地开关。
该开关不隔离 Agent 自身工具，完整边界见[终端执行](TERMINAL-EXECUTION.md)。
同一 Agent 的等待串行执行；超时、queued 或 observed_state 不能代表模型回复完成。
两轮须核对完整 Target、server_generation、选定 pane/alias、terminal_id 和有值时的
Agent session；第二轮验证真正回复对第一轮随机内容的记忆，不能以终端回显代替。
界面应同时展示 `status` 与 `authority/state_source`；缺少正面状态证据时投影为
unknown，不能把 idle、queued 或 TUI 文本当作完成或模型回复。

## 验证

真实 Luvus 的验收见 [`e2e/README.md`](../e2e/README.md)：按 Quick Start 在真实终端配对后，经官方 MCP SDK 走 discover → describe → call → get → read，
以及崩溃接管、被杀重建、未知结果不重发、离线撤销（均用真实 Luvus 0.14.3）。
