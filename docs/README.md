# Rovloom 文档导航

[DESIGN](DESIGN.md)是当前唯一权威系统设计（目标架构）。实现与设计的差距用 [GitHub issues](https://github.com/ArnoChenFx/Rovloom/issues) 跟踪（阶段 S0–S8，见 [简化方案](proposals/SIMPLIFICATION.md)）；专项规范目前描述现有实现，冲突时以 DESIGN 为准；历史版本、改名过程和开发进度使用 Git、CI 与 PR，不在当前规范追加修订流水。

| 需要了解 | 唯一维护职责/入口 |
|---|---|
| 安装前提、角色配置路径、启动连接、HTTP MCP 与 Agent 使用 | [Quick Start](QUICK-START.md) · [快速开始](QUICK-START-zh.md) |
| 每角色唯一用户配置、全部参数与安装要求 | [Configuration](CONFIGURATION.md) · [配置参考](CONFIGURATION-zh.md) |
| GHCR 镜像、Linux Gateway Compose 部署、持久卷与容器运行边界 | [Docker deployment](DOCKER.md) · [Docker 部署](DOCKER-zh.md) |
| 开机注册、服务启停、账户/路径权限与 CLI 接缝 | [SERVICE](SERVICE.md) |
| 系统目标、角色、Target/provider、授权、结果、去重、恢复和默认预算 | [DESIGN](DESIGN.md) |
| 尚需交付的能力、依赖和联合验收 | [GitHub issues](https://github.com/ArnoChenFx/Rovloom/issues) |
| 管理页、管理员确认、状态展示和管理 API | [GATEWAY-WEBUI](GATEWAY-WEBUI.md) |
| Wire 帧、协商、精确字段、编码、方向和协议限额 | [Wire 协议](protocol/WIRE-PROTOCOL.md) |
| Native validator、handle、可信宿主与调用顺序 | [原生契约](protocol/NATIVE-CONTRACT.md)；准确签名见对应源码类型 |
| SQLite 宿主接线、保留/预算、备份隔离恢复与 unknown 对账 | [存储运行指引](STORAGE.md) |
| Gateway 普通配置文件、持久化与六平台原生单文件验收 | [Gateway 平台边界](GATEWAY-PLATFORMS.md) |
| WSS/loopback 通道、ready、配对 custody、重连与 transport 限额 | [通道接线](TRANSPORT.md) |
| MCP Streamable HTTP、受信 caller/服务接口、双角色 CLI 与预览限制 | [MCP Streamable HTTP 契约](protocol/MCP-HTTP.md) |
| 通用 provider 角色、原 caller/锚点与结果预算接缝 | [Provider 角色](PROVIDER-RUNTIME.md) |
| Connector 本地终端开关、替代输入入口、cwd/PATH 与原生结果边界 | [终端执行](TERMINAL-EXECUTION.md) |
| Luvus 窗口、Agent、静态 CLI 工厂与同机 managed/attach | [Luvus 操作装配](LUVUS-OPERATIONS.md) |
| 受管运行时的自有实例、来源与清理隔离验收方法 | [受管运行时隔离验收](MANAGED-RUNTIME-VERIFICATION.md) |
| 共享管理写事务、确认/回执、窄 HTTP handler 与生产接线边界 | [管理写服务](MANAGEMENT-WRITES.md) |
| 工具链、构建、隔离验证、固定原生输入和回放 | [开发指引](DEVELOPMENT.md) |
| Bun 单文件、tag 门禁、发布资产/manifest、Worker/静态资源、Windows 图标及本机验收 | [发行构建](DISTRIBUTION.md) |
| 现行决策理由和外部研究边界 | [ADR 索引](#现行决策) |

系统语义由 DESIGN 统一；专项规范只定义所属细节，源码维护精确实现签名。出现差距时修正文档细节或登记实施项，不能以旧代码给 provider/权限/恢复补默认值。协议/依赖版本、外部源码 hash 和不可变测试 provenance 可以保留在对应来源说明；仓库 main SHA、分支、PR 流水和测试批次不属于长期规范。

## 现行决策

- [0003：Bun 执行与开发工具链（版本不固定）](adr/0003-bun-toolchain.md)
- [0004：多 runtime provider 与 Herdr 证据边界](adr/0004-multi-runtime-provider.md)

已归档（早期设计，含已移除的机制）：[0001](adr/archive/0001-p0-version-and-contract-baseline.md)、[0002](adr/archive/0002-safety-retention-recovery-late-evidence.md)。
