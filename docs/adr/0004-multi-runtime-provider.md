# ADR 0004：多 runtime provider 与 Herdr 适配边界

状态：采纳多 provider 架构与有限 Herdr 目标。系统语义唯一维护在 [DESIGN](../DESIGN.md)，精确类型/编码见 [Wire 协议](../protocol/WIRE-PROTOCOL.md)，实现差距和 P0-H/接线验收见 [实施计划](../IMPLEMENTATION-PLAN.md)。本 ADR 保存选择理由与外部研究依据，不另设公共字段字典或迁移算法。

## 一设备身份、一连接，多个可信 runtime bindings

一套 Connector 身份和出站 WSS 表达设备，各 binding 独立表达 Luvus/Herdr 实例。这样同机混合 runtime 或同 kind 多实例不必重复设备注册，也不会将原生安装实例误作物理设备身份。runtime provider 与 model provider 密钥/服务是不同领域。

选择完整 Target 与独立 binding revision fence：稳定 ID 便于历史关联，revision 防止升级、启停或配置变化后沿用旧授权/执行上下文。kind/root/实例替换用新 ID；仅凭设备广告、相同 hostname 或同名 session 不能建立/重绑实例。

代价是 registry、双端配置、授权、去重、契约、结果、流与历史都须在当前规范 schema 内完整 provider 隔离，不能只给 Target 加 optional 字段。项目未发布，旧库直接拒绝，不提供 legacy binding 或来源猜测；当前 history/key/TTL/discard 语义仍完整维护，旧工作不能经换范围变为新执行。规范见 DESIGN §5。

## 核心通用，原生保证分别表达

核心管理身份、策略、路由、预算和账本，adapter 管理本地来源、原生协议、能力与保证。选择通用 runtime_* 工具和 native_request/native_response，同时保留各协议原生字段/错误，不把 Herdr 模拟成 UHP。

权限以双方相同完整目标组合求交，设备权限只设上限，新 provider 不自动继承。provider 禁用与整设备撤销分离，故障及健康也分层。这能防止同名方法/终端 ID 混用和单实例故障误撤其它授权，但要求每个 provider 独立实证分类、传输和结果边界，不能继承 Luvus 的安全表。

event recovery、terminal fence、cancel、prompt completion 必须逐方法说明强度。原生没有的 incarnation、序号、原子性或完成归属不能由桥接字段制造；DESIGN §8–§12 定义其统一语义。

## Wire 版本与兼容边界

provider、契约来源及完整关联是执行安全必需字段，不能藏在 v1 optional/default 中，因此选择 Wire major 2。minor 仅承载双方已协商的可选扩展，不在失败后自动降级重发。Wire 与 MCP revision、管理 API 独立版本化。

项目尚未发布，取消 Wire v1 的兼容承诺并移除两套历史 decoder，仅维护当前 v2。旧帧直接拒绝，不分配默认 provider；缺少 provider 或可信 binding 时不得执行，不借旧 key 缺失重新派发。当前 history scope/TTL 保留，Store 只维护当前规范 schema；MCP、管理 API 及外部原生协议各自版本不受影响。

## Herdr 研究与有限目标

研究固定于官方 Herdr v0.9.5 源码 `2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01`，协议常量 22。这个 hash 锁定外部协议证据，不是 Rovloom 开发基线。研究不是安装 binary 的生产契约，也不是 P0-H 或 adapter 执行证明；运行时须重新取得安装 schema/hash、实际版本和独立 endpoint 来源。

| 固定源码/文档观察 | 选择理由与边界 |
|---|---|
| JSON 请求/响应有自己的 id/method/params 与 schema | 独立解析与校验，保留原生 result/error，不套 UHP 根/错误类型 |
| ping 给版本/协议与有限 capabilities，非完整逐方法 live catalog | 支持依据采用 schema_and_version；未实证方法保留 candidate，不凭 schema 枚举开放 |
| 无等价独立 Host、通用 cancel、通用原子 terminal incarnation fence | 不模拟 Host；桥接取消/身份核对不能声称原生停止或原子性，协议号不是实例 generation |
| 事件缺口须重建，snapshot 与事件无共同序号边界 | 只承诺当前状态重建，明确 gap，不能缓存载荷重放覆盖快照或伪造丢失历史 |
| recent 等读取路径可能滚动或送输入 | 被动只读必须按 method+params+实现逐项核实，不能凭 read 名或 schema 授 observer |
| prompt wait 观察状态，不能单凭状态归属本次提交 | 不宣称 turn-correlated 完成；写入/终端需单独研究与设计 |

因此首个目标限发现、状态、核实被动只读与事件失效后状态重建。P0-H 是必要原生证据门禁，之后还需 adapter、可信 backend、授权/持久化、MCP 及多 provider 集成验收；P0-H 通过不表示架构上线。精确被动读允许集、写入/终端、prompt 归属与取消未定部分保持拒绝，不为工具面一致降低 Luvus 保证。

## 官方来源与核验边界

以下固定引用属于外部协议 provenance；升级安装版本必须重核，不将结论扩展为未来版本永久断言。

- [官方源码](https://github.com/herdrdev/herdr/tree/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01)、[socket API](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/docs/next/website/src/content/docs/socket-api.mdx)：安装 schema、JSON socket、订阅和状态重建。
- [请求枚举](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/api/schema.rs)、[响应类型](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/api/schema/response.rs)、[ping 能力](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/api/schema/server.rs)、[协议常量](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/protocol/wire.rs)：有限能力与缺少等价通用接口的研究依据。
- [pane 分派](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/app/api/panes.rs)、[terminal recent 实现](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/pane/terminal.rs)、[agent 自动化](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/docs/next/website/src/content/docs/agent-automation.mdx)：读取副作用、等待与完成归属需独立验证。
