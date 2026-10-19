# Rovloom 文档导航

[DESIGN](DESIGN.md)是当前唯一权威系统设计。实现与设计的差距维护在[实施计划](IMPLEMENTATION-PLAN.md)；历史版本、改名过程和开发进度使用 Git、CI 与 PR，不在当前规范追加修订流水。

| 需要了解 | 唯一维护职责/入口 |
|---|---|
| 开机注册、服务启停、账户/路径权限与 CLI 接缝 | [SERVICE](SERVICE.md) |
| 系统目标、角色、Target/provider、授权、结果、去重、恢复和默认预算 | [DESIGN](DESIGN.md) |
| 尚需交付的能力、依赖和联合验收 | [IMPLEMENTATION-PLAN](IMPLEMENTATION-PLAN.md) |
| 管理页、管理员确认、状态展示和管理 API | [GATEWAY-WEBUI](GATEWAY-WEBUI.md) |
| Wire 帧、协商、精确字段、编码、方向和协议限额 | [Wire 协议](protocol/WIRE-PROTOCOL.md) |
| Native validator、handle、可信宿主与调用顺序 | [原生契约](protocol/NATIVE-CONTRACT.md)；准确签名见对应源码类型 |
| SQLite 宿主接线、保留/预算、备份隔离恢复与 unknown 对账 | [存储运行指引](STORAGE.md) |
| WSS/loopback 通道、ready、配对 custody、重连与 transport 限额 | [通道接线](TRANSPORT.md) |
| 工具链、构建、隔离验证、固定原生输入和回放 | [开发指引](DEVELOPMENT.md) |
| Bun 单文件候选、Worker/静态资源接入、Windows 图标及本机验收 | [发行构建](DISTRIBUTION.md) |
| 现行决策理由和外部研究边界 | [ADR 索引](#现行决策) |

系统语义由 DESIGN 统一；专项规范只定义所属细节，源码维护精确实现签名。出现差距时修正文档细节或登记实施项，不能以旧代码给 provider/权限/恢复补默认值。协议/依赖版本、外部源码 hash 和不可变测试 provenance 可以保留在对应来源说明；仓库 main SHA、分支、PR 流水和测试批次不属于长期规范。

## 现行决策

- [0001：安装契约与协议版本](adr/0001-p0-version-and-contract-baseline.md)
- [0002：分类、有限保留、隔离恢复与晚到证据](adr/0002-safety-retention-recovery-late-evidence.md)
- [0003：Bun 执行与开发工具链](adr/0003-bun-toolchain.md)
- [0004：多 runtime provider 与 Herdr 证据边界](adr/0004-multi-runtime-provider.md)
