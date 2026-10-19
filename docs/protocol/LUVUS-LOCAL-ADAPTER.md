# Luvus 本地普通 RPC adapter

本地 adapter 是尚未接入服务入口的模块，遵循现行
[DESIGN](../DESIGN.md)、
[Native contract](NATIVE-CONTRACT.md) 和 Wire v2。
它不提供 Gateway listener、Connector 认证通道、生产身份验证器或默认许可。

`src/connector/luvus/index.ts` 导出 `LuvusRpcAdapter`、`createLuvusCatalog`、
`createLuvusResultAccess` 及所需宿主类型。
构造参数只能来自受保护本机配置，不能由 MCP 参数、设备广告或 Wire 消息构造。
一个 adapter 固定一个完整 session Target、provider revision 和 opaque config_ref。
Host、流、access/machines 和 Herdr 不在本目录范围内。

## 本地资源与传输

固定管理员 binary 的 SHA-256、绝对路径、state root、HOME、cwd 和 session。
仅执行以下 argv，全部 `shell: false`，请求只进入 stdin/socket：

```text
<binary> --session <fixed-session> session list --json
<binary> --session <fixed-session> uhp schema
<binary> --session <fixed-session> uhp proxy
```

子进程只接收代码列明的 HOME/XDG/LUVUS_HOME/PATH/SHELL/LANG，不继承进程环境。
目录须提前存在，不自动安装软件、创建 session、启动 server 或读取默认用户 HOME。
仅支持 Linux POSIX 检查：私有目录当前 uid/0700，socket 当前 uid/0600；
全部祖先禁止 symlink、非目录、非当前/系统根目录属主的 uid 和 group/world write。
系统根目录属主从 OS 独立读取，支持用户命名空间下的 uid 映射，不使用 caller 自报 uid。
因此 `/tmp` 等可写祖先下的 endpoint 被拒绝；测试使用 `/workspace` 下的自建私有目录。
Windows ACL、命名管道和其它 OS 需要另行实现与验收。

session list 只选择显式配置的唯一 running session，endpoint 必须是 state root
内的规范绝对 Unix socket。地址不能来自 caller。连接前、身份验证后、派发前及
结果读取前重新检查目录链/socket 的 dev/inode、属主、mode 和 socket ctime。
这种路径检查不能替代连接到的 peer 身份测量。

IPC 对同一已连接 Socket 要求 `verifyPeer` 返回独立测量的 pid/uid/gid；必须与
受保护来源的期望身份核对，uid 匹配并不单独证明进程身份。模块没有可移植的
SO_PEERCRED 实现，缺回调即拒绝。CLI 的 native socket 隐藏在子进程内，必须由
`verifyProxy` 独立证明固定子进程/binary/root 与原生实例归属；仅提供 child.pid 或
复述 discovery JSON 不能满足该证明。没有生产实现时 CLI 也保持关闭。

`verifyProxy` 在写入 stdin 前执行。固定 Luvus 0.14.3 的 `uhp proxy` 读完请求才
建立 native 连接，因此该回调不能等待尚不存在的 socket 来测量 peer；仅观察启动
成功、child.pid 或派发后的 trace 都不能替代派发前证明。宿主没有独立可信的实例
归属方案时，必须继续拒绝 CLI 派发，不能为连通而返回固定成功。

## 宿主接线与拒绝边界

`LuvusRpcHost.backend` 必须实现现行 `NativeWireBackend` 的全部可信来源。
adapter 内部直接构造现有 `createLuvusWireAdapter`，不复制认证/策略逻辑，不提供
跳过 Wire 的公开 execute 函数。请求解码先核对登记 attempt、双端 binding、契约、
能力、许可和完整原请求；额外核对本地 config_ref/Target/revision 与 binary hash。
原生 method descriptor 的 transport 还必须为 `single_request_rpc`，不能仅凭
Wire request 或账本 rpc 标记判断；即使 backend 同时支持持久流，也在本地发现、
认证、claim 和原生写入前拒绝流方法及未分类 transport。

宿主还必须提供：

- `verifyPeer` 或 `verifyProxy`：独立的实际原生连接/实例来源证明，并与 backend 的
  nativeSource 保持同一份完整 binding；该接口没有默认信任实现。
- `nativeAuth`：来自受保护 custody 的受限 delegated token，绑定本次来源与目标；
  空值或不符合安装 schema 的 token 被拒绝，不回退到 local_owner，不生成 token。
- `claimDispatch`：原子持久登记唯一派发、核对当前 epoch/generation、双方授权和
  deadline；禁止重新认领旧 attempt。接口不负责执行原生副作用。

现行 `persistentBackend(store, services)` 可复用 Store 的原 attempt、provider、
响应锚点和内容期限；认证、原生来源及当前双端权限仍由 services 独立提供。
`Store.dispatch` 是取得原登记 binding 的持久步骤，不能把对同一 attempt 再次
调用它当作 `claimDispatch`。Connector 的唯一发送登记仍需宿主实现。
响应提交须通过持有原请求 Wire 状态的 `commitLuvusResponse`，事务成功后才能
发布 durable responded；本模块的 `RpcResult` 不代替该提交。

认证 Connector 可通过逐会话 `ConnectorWireSession.executeWire(raw, signal)` 直接将
收到的原始已验证 Wire request 交给本模块 `dispatch`。该 hook 与 `nativeInput`/`execute`
互斥，不能剥掉字段后重包装原生请求，失败也不回退到另一执行路径。每个新 epoch 新建
本模块及 transport 的独立 Wire adapter，并由会话 close 关闭本模块。
接缝及响应对象/活读取 port 见 [transport 接线](../TRANSPORT.md#原始-wire-执行接缝)。
`RpcResult.binding` 必须匹配 transport 的原 attempt；原生 auth 只在本模块注入，
唯一 durable claim 仍由可信宿主实现。两端分别保留原请求状态，Gateway 通过原 adapter
调用 `commitLuvusResponse`，不能让本模块的完成返回代替 durable responded。

auth 仅在通过 Wire 校验后注入；原生 ID 来自登记 attempt。加入 id/auth 并加上 LF
之后才计算本地与在线 general/terminal 上限交集，并复用原生 validator 校验完整请求；
超限在持久 claim 和原生写入前拒绝，不用新的候选替换原 Wire permit。
claim 返回后重验 binary/endpoint，最后一次 await 后在实际 write 的同步栈内重查
当前许可、完整帧和 deadline。传输终结会中止尚未完成的 prepare，禁止延迟 auth
返回后再新增 claim；已调用的 custody/持久 claim 操作仍由宿主负责其幂等和终结。
返回前使用现有
`checkResult` 重新检查原生响应与当前读许可。

内存 attempt 集合默认 128，满后拒绝、不淘汰、不重试；它不能代替持久 dedup。
该上限属于同一 adapter 的 seen 防重放记录，普通 RPC 模式不承诺同 epoch 连续成功 130 次。
每次完成、取消或失败后回收无人执行的私有 Wire 原文，不删除 seen，也不释放 Gateway 的独立
结果读取上下文。重复请求或取消不能清理另一个仍在途的执行；满额意图在 auth/claim 前拒绝，
transport 关闭后以 fresh epoch 创建新 adapter，只有宿主明确创建的新意图才可继续。
重启或新建 adapter 后仍须由宿主 durable claim 阻止重放。`close()`/Wire cancel/
AbortSignal 只关闭本 adapter 的 socket/桥接进程；不会发送 native rollback、关闭
terminal 或终止原生 session。派发后超时、取消、断线和未知退出保守为
`outcome_unknown`，不得据此重发写入。
`close()` 还会释放私有 Wire 的请求/响应上下文、维护定时器及账本失效订阅；
重复关闭安全。单次取消不会关闭整个 Wire，也不会删除已见 attempt 的重放防线。

## framing、输出与发现

普通 RPC 接收一个有界 JSON + LF，随后 EOF；拒绝额外 frame、CRLF、缺 LF、非法
UTF-8、重复键及精度损失。CLI exit=1 的合法原生 error 保留原始 id/error/data；
原始 response 的空白与 LF 同样计入本地及在线 general/terminal response 上限交集，
不能靠解析后重序列化缩小字节数来通过 transport 预算。
进程/传输失败使用独立 `LuvusAdapterError`，不往 native error 中添加网关字段。
stderr 只有有界字节计数，不向普通错误回显内容；不输出 token、参数或私人路径。

默认 request/response 各 1 MiB、stderr 64 KiB、discovery/schema 至多 2 MiB、
单次本地等待最多 30 秒，登记 deadline 可以进一步缩短；配置只能收紧。
这些是有界输入/输出计量，不是进程 CPU/heap 的硬隔离。schema 初始化等待
Bun Worker 完整编译并生成 standalone，随后 NativeValidator 同步校验；编译接纳期限、
取消、迟到拒绝及首版无硬 heap 保证见[原生契约](NATIVE-CONTRACT.md#编译-worker-与生成物接纳)。

`installedSchema` 仅运行固定安装的 CLI schema 命令，保留原字节并等待 `compileBundle`，
向工厂传播本次取消/期限信号；完成后再次核验安装身份、取消和 adapter 关闭状态，才返回契约。
在线 `uhp.capabilities` 必须由宿主经授权取得并发布到 registry，不能用不存在的
`uhp.schema` RPC，也不能为完成发现而授予 Owner/raw。普通 `dispatch` 不豁免
`uhp.capabilities` 的现行 strict schema/许可门禁；生产 bootstrap 未提供时拒绝。

`createLuvusCatalog` 用既有 validator 绑定在线能力和可信来源，提供关键词、精确
describe 和有界分页。cursor 绑定完整 native binding、query 与有效期；generation、
binary/schema、provider、epoch、策略或分类 revision 变化均失效。发现描述中的
`classification_status: not_evaluated` 不构成执行许可；未知方法仍受现行门禁拒绝。
原生 method contract 的 `read` 标记也不能替代独立安全分类：固定版本的
`task.next` 虽列为 read，却可认领或在 `start: true` 时启动任务。宿主必须审核
具体 method 与参数，不得从 token scope 或 read 标签自动生成无副作用白名单。

## 持久结果访问

`createLuvusResultAccess` 复用现有 Store 和 Router，提供 `open(callId)`、
`read(resultId, cursor, maxBytes)` 和 `discard(callId)`。它不拥有 Store/Wire 的
生命周期，不缓存正文、许可或截止时间，不提供 MCP 工具或服务入口。

结果访问要求受保护宿主遵守原 Wire 的可信接口契约。`localPolicies` 可以返回
独立策略快照，不要求返回活对象；旧对象引用或摘要都不作为当前授权版本的证明。
宿主不得替换原 Wire 的安全方法，再将包装对象冒充登记原请求的真实上下文。

受保护宿主必须提供当前 `principal()`、`localPolicies(target)` 和
`resolveOriginalRead(callId)`。
全部接口同步完成；Promise 被拒绝，晚到拒绝被消费。`resolveOriginalRead`
只能返回登记原请求持有的完整 `binding` 和真实原 Wire 实例；上下文缺失、
关闭或仅响应态均拒绝内容读取，不能从 Store、JSON 或相同摘要重建派发许可。
open 还必须调用原 Wire 的 `checkResultRetention(binding, nativeFrame)`，独立
检查原派发分类和当前分类均允许保留。现行 Wire 已提供该真实能力；旧宿主若缺少
该能力，open 在 `saveResult` 前以 `result_retention_context_unavailable` 拒绝。不能以
`checkResult` 成功或分类 JSON 代替原 permit 保留门禁，不能填入固定成功回调。
基础 read/discard 测试仍使用依法保留阶段在 Store 预置的句柄；通道组合测试则由
真实 `executeWire`、对象重组及证据提交取得响应，再通过原 Wire 保留门禁 open。
组合使用自建 IPC 和合成身份，不代表真实 Luvus 会话或授权一致性验收。
分页直接使用现有 `Store.readResult` 的 `ResultPage`，其中 `expires` 是实际
results 记录的绝对毫秒截止时间，以 `now < expires` 为有效条件。没有独立元数据
注入或期限缓存；读取不调用 `saveResult`、不创建句柄或刷新期限。

open/read 使用完整 binding 核对 Store 的原响应锚点，对保存的完整原生响应运行
原 Wire `checkResult`，并重新检查身份和双方 ACL。策略回调返回后重新读取调用
状态，最终授权后重新查询实际句柄及结果页，避免交付回调前准备的 Store 副本。
最后一次策略回调后还须重新解析同一原 Wire 并执行原生门禁，防止回调关闭或释放
上下文、撤销来源或原生读取权限；门禁返回后同步复核主体及实际正文。读取使用
最终真实门禁的成功作为原生读取授权判断点，与读取重叠的后续撤权约束后续操作。
实现中的策略对象摘要比较只是附加防御，不能替代 Router 或原 Wire 授权，也不能
证明背后的当前策略版本。对真实门禁成功后主动注入副作用的替代方法，不承诺其
满足原 Wire 契约；不据此要求其它模块新增全局一致性框架。

保留门禁通过后，open 仅调用现有 `saveResult` 创建或复用句柄；
重复 open 不刷新有效句柄，read 从不重开已到期句柄或重发原生请求。

read 返回既有 base64 字节页、下一游标、eof、完整原生响应的字节数和 SHA-256，
另返回实际句柄 `expires`。每页最多 65,536 字节，游标是 UTF-8 字节偏移，单页
可能拆开多字节字符；应先拼接解码后的所有字节，再校验完整 hash 和解析 JSON。
保留原生 id/result/error/error.data 的解析字段和值；摘要针对 Store 保存的完整
原生 JSON，不承诺原始传输空白、键序或 Wire 外层对象的 hash 相同。
显式 discard 独立要求当前调用归属、双方读取 ACL 和 `discard_response` 权限，
通过 Store 删除正文和句柄；原读取上下文已回收也不妨碍获得专门授权的清理。

## 接入限制

生产 peer/CLI 证明、delegated auth custody、认证通道及 durable 派发账本必须由
宿主独立提供。本目录不能凭合成回调作为公开接入入口。大于配置上限的结果
直接失败。结果访问层直接复用 Store 的实际句柄期限，策略回调后重新读取真实
调用与结果页；Store 正文丢弃或句柄删除后不能交付旧副本。原 Wire 保留门禁、
对象编码/接收提交及原上下文查询已在受控测试中组合，真实原生会话、生产身份
及公开入口仍需独立验收，不能据此宣称大结果生产交付完成。
默认 build 入口尚未包含本目录，发行接线需要单独纳入。

`test/connector/luvus` 只使用仓库 P0 字节、自建私有 socket 和固定 Bun 测试子进程。
synthetic peer/CLI 回调仅用于测试，不能代表生产身份实现；这些测试不证明真实
Luvus 安装、私有会话、Owner/Host admin 或真实多机链路可用。
