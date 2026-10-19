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
同一 Agent 的等待串行执行；超时、queued 或 observed_state 不能代表模型回复完成。
两轮须核对完整 Target、server_generation、选定 pane/alias、terminal_id 和有值时的
Agent session；第二轮验证真正回复对第一轮随机内容的记忆，不能以终端回显代替。
界面应同时展示 `status` 与 `authority/state_source`；缺少正面状态证据时投影为
unknown，不能把 idle、queued 或 TUI 文本当作完成或模型回复。

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

同一维护脚本可额外传 `--opencode-binary /absolute/protected/opencode`，固定核对官方
OpenCode 1.19.3 的安装摘要。它只在本轮临时 HOME 写入免费 Big Pickle 白名单和
固定 Agent 模型，保留保存环境原代理及证书变量，不读取用户账户；随后经同一原
Wire 执行一次 `agent.start`、读取状态、提交一次 prompt、读取真实输出并核对原
终端身份。报告里的 `queued` 只表示原生输入准入，`model_reply_verified:false`
明确表示尚未证明模型回复；该模式也不把终端回显算作两轮上下文。

稳定 ID 的独立原生复核使用版本化维护入口。完成上述 build 后执行：

```sh
bun --no-env-file scripts/runtime/verify-luvus-stable-selection.mjs \
  --binary /absolute/protected/luvus \
  --temporary-parent /absolute/protected/parent \
  --acknowledge-nonproduction
```

该模式在本轮新建空白 root 中运行窗口/pane/Agent 发现及缺失 Agent 原生错误检查，
再用固定官方 `uhp proxy` 逐项复跑稳定选择：前项关闭后的
workspace/tab ID、原生旧 revision 冲突、跨 workspace tab 写入的 not_found、其它对象
不变，以及 terminal snapshot pane 解析稳定 ID。代码位于
[luvus-stable-selection.mjs](../scripts/runtime/luvus-stable-selection.mjs)，不依赖作者的
`/tmp` 文件或固定机器路径。成功报告的 `stable_selection` 包含逐项检查和实际 RPC
计数；窗口数量会影响坐标检查数量。该入口报告明确为 `native_only`，不建立
Gateway、设备认证、claims 或 Wire 结果句柄，不替代上面的真实 WSS 验收。
`model_requests:0`、`tokens_issued:0` 仅描述该入口；它不接受 OpenCode 选项，不启动 Agent、不提交 prompt，
不连接模型端点，不将空 Agent 列表或状态发现算作真实模型两轮验收。

仅接受明确的固定官方 0.14.3 binary 和受保护临时父目录，使用自己的临时 HOME，
不读取产品配置或用户会话。每项失败直接结束，不重放或更新原 revision；退出后按
现有受控 child 清理流程释放资源，退出未确认时保留本轮 root。每个 proxy 调用固定
10 秒、1 MiB 限额，并校验原 ID 与受控安装 schema；不重试。只打印安全检查名和
计数，配置、凭据、数据库及原生正文不作为验收材料上传。

稳定 ID 复核的正例和跨 workspace `not_found` 检查不附加可选全局 CAS，仍逐项核对
原稳定 ID、名称、当前 workspace 与其它对象。CAS 另作明确过期负例：在一次发事件的
close 前保存旧序号，close 后读取并断言新序号更大，再只发送一次旧值变更，要求原生
`revision_conflict` 且目标 ID/名称未变。snapshot 与后续 list 不要求全局序号相等；
按单份 snapshot 的坐标类型、同一路径和 terminal pane 发现的稳定 ID 比较拓扑。
这不改变真实 caller 传入 `if_revision` 的行为，也不更新并重发失败操作。
