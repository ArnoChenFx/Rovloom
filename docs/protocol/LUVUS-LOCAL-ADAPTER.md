# Luvus 本地普通 RPC adapter

本地 adapter 是尚未接入服务入口的模块，遵循现行
[DESIGN](../DESIGN.md)、
[Native contract](NATIVE-CONTRACT.md) 和 Wire v2。
它不提供 Gateway listener、Connector 认证通道、生产身份验证器或默认许可。

`src/connector/luvus/index.ts` 导出 `LuvusRpcAdapter`、`createLuvusCatalog` 及所需宿主类型。
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

现行认证 Connector 通道的 `nativeInput`/`execute` 接口处理已经注入 id/auth 的
原生 JSON，本模块的 `dispatch` 则接收完整 Wire request 并持有自己的校验状态。
两者尚未接线，不能直接把 `dispatch` 当作 `execute`，也不能剥掉认证或重新包装
原生请求来绕过许可。生产接入仍需宿主设计共享原请求状态和唯一派发登记的桥接。

auth 仅在通过 Wire 校验后注入；原生 ID 来自登记 attempt。加入 id/auth 并加上 LF
之后才计算本地与在线 general/terminal 上限交集，并复用原生 validator 校验完整请求；
超限在持久 claim 和原生写入前拒绝，不用新的候选替换原 Wire permit。
claim 返回后重验 binary/endpoint，最后一次 await 后在实际 write 的同步栈内重查
当前许可、完整帧和 deadline。传输终结会中止尚未完成的 prepare，禁止延迟 auth
返回后再新增 claim；已调用的 custody/持久 claim 操作仍由宿主负责其幂等和终结。
返回前使用现有
`checkResult` 重新检查原生响应与当前读许可。

内存 attempt 集合默认 128，满后拒绝、不淘汰、不重试；它不能代替持久 dedup。
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
这些是有界输入/输出计量，不是进程 CPU/heap 的硬隔离。schema 编译仍复用现行
同步 NativeValidator 内核；schema CPU/heap 硬隔离需要另外提供执行边界。

`installedSchema` 仅运行真实 CLI schema 命令、保留原字节并复用 `compileBundle`。
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

## 接入限制

生产 peer/CLI 证明、delegated auth custody、认证通道及 durable 派发账本必须由
宿主独立提供。本目录不能凭合成回调作为公开接入入口。大于配置上限的结果
直接失败；尚未连接受限结果对象、分页/TTL/清理与大结果完整重组，不能将有界普通 RPC 模块视为完整结果交付实现。默认 build 入口尚未包含本目录，发行接线需要单独纳入。

`test/connector/luvus` 只使用仓库 P0 字节、自建私有 socket 和固定 Bun 测试子进程。
synthetic peer/CLI 回调仅用于测试，不能代表生产身份实现；这些测试不证明真实
Luvus 安装、私有会话、Owner/Host admin 或真实多机链路可用。
