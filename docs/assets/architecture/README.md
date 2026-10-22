# Architecture / 架构

Sources: [English](target.en.mmd) · [中文](target.zh.mmd).
The matching Mermaid fences are embedded in the [English README](../../../README.md#architecture)
and [中文 README](../../../README-zh.md#架构). Update each source and its README
fence together; keep node IDs, roles and edges consistent across languages.

源文件与双语 README 中的 Mermaid 代码块同步维护；两种语言的节点 ID、职责与连线须一致。

The layout has three tiers: AI Agent / AI Bot and CLI at the top, one Gateway in the middle,
and separate devices below. Each device has one identity and one outbound
Connector, with multiple provider adapters bound to local Luvus or Herdr instances.

图分三层：上方 AI Agent / AI Bot 与 CLI、中间一个 Gateway、下方多台设备。每设备一套身份、一个主动出站
Connector；多个 Provider Adapter 分别绑定本地 Luvus 或 Herdr 实例。

- Dashed arrows show **outbound connection initiation**, from Connector to Gateway.
- Solid bidirectional arrows show **application traffic**, not who opens a socket.
  Requests go Gateway → Connector → adapter → local runtime; results and events
  return along that path.
- Provider adapters preserve each runtime's native contract. Luvus exposes Host/session;
  Herdr uses session runtimes. The management UI belongs to the Gateway.

- 虚线箭头表示 **出站连接发起方向**：Connector → Gateway。
- 实线双向箭头表示 **业务流向**：请求向下，结果/事件沿原路返回；不表示 socket 发起方向。
- Provider Adapter 分别保留原生契约：Luvus 使用 Host/session，Herdr 使用 session runtime。
  管理 UI 属于 Gateway。

These sources describe the final target architecture. Keep implementation progress
and availability information outside the diagrams, in the README introduction.

图源只描述最终目标架构；当前可用范围在双语 README 的引言中简短说明。

Normative references: [DESIGN](../../DESIGN.md),
[ADR 0004](../../adr/0004-multi-runtime-provider.md),
[issues](https://github.com/ArnoChenFx/rovloom/issues), [Web UI plan](../../GATEWAY-WEBUI.md).
