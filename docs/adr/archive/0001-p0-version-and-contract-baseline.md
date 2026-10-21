# ADR 0001：安装契约与独立协议版本

> **已归档。** 本 ADR 记录早期设计的取舍，其中一部分机制（隔离恢复、逐 input permit 等）已在[简化设计](../../DESIGN.md)中移除。章节锚点指向旧版 DESIGN，请用 `git log -- docs/DESIGN.md` 查阅。

状态：采纳。系统要求以 [DESIGN](../../DESIGN.md)为准；本 ADR 记录契约选择理由，固定原生输入及其来源维护在 [固定输入指引](../../DEVELOPMENT.md#固定输入与维护用途)，当前工具链选择见 [ADR 0003](../0003-bun-toolchain.md)。

## 决策

以安装 binary 导出的原生 schema 原文、binary 身份及对应运行实例能力建立契约来源。Luvus 的 `luvus uhp schema` 不是在线权限表；session 与 Host 能力分别发现，专用 access_machines 不映射到 Rovloom 设备注册。网页可以帮助理解协议，不能覆盖安装版约束。

使用支持安装版方言的离线 JSON Schema 校验，保留完整根、条件和传递引用，不改写原生数据。bundle documents 的 URL 仅是本地索引，禁止联网补引用或当文件路径读取。缺文档/fragment、未知方言或无法应用的约束失败关闭。

原生响应、事件及终端帧使用各自适用的完整契约；结构成立还需原请求、身份和方法/模式关联。参数枚举/通用 object 不证明方法参数完整，有条件分支也不证明业务语义完备；安全分类与参数覆盖的系统门禁由 DESIGN 统一定义。

MCP、Rovloom Wire、Luvus UHP 和 Herdr JSON 分别版本化。MCP 采用 SDK 实证协商的 `2025-11-25` 路径；升级 revision 必须评审实现及客户端兼容，不能把网页 latest 或依赖类型版本当支持证明。Wire 的 provider 破坏性版本选择理由见 [ADR 0004](../0004-multi-runtime-provider.md)。

## 理由与取舍

安装 binary、运行 server 与网站可能不同步；固定原文和独立实时发现可以让差异可追踪，同时避免错误地向未知方法派发。离线引用闭包减少网络/文件解析面，但新增契约形式需要明确支持和重验证，不能静默忽略。

固定 Luvus 版本的证据揭示了参数覆盖缺口、原生语义拒绝、endpoint 身份与终端 ack 边界，因此方法总数不能作为“全功能”或参数验证的替代指标。精确方法覆盖、版本/hash 和原始记录只维护在测试输入/来源说明，避免 ADR 与 fixture 漂移。

MCP SDK Streamable HTTP 兼容探针只能证明记录中的客户端和 revision，不证明商业Host、OAuth、其它revision 或产品 Gateway 已接线。当前 CI 使用锁定 Bun 执行真实 SDK 协商，历史运行报告不作为持续验收输入。当前依赖精确版本以 package/lock 为准，类型包不代表执行运行时。

## 证据入口

- [原生来源](../../../test/fixtures/luvus/0.14.3/provenance.json)与 [SDK 实际协商回归](../../../test/mcp/sdk-compatibility.test.mjs)：分别维护不可变契约来源与当前依赖的实际兼容验证。
- MCP `2025-11-25`：[生命周期](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)、[传输](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[授权](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)。
- [固定 Luvus endpoint 规则](https://github.com/RizRiyz/luvus/blob/54003ce9568acb2977e4bbdbb30a61f99faa0465/protocol/uhp/v1/terminal/endpoint-validation.md)：平台验证输入，不是所有平台已通过的证明。

平台/版本/部署的未完成项由实施计划维护，不在本 ADR 追加测试批次或仓库提交状态。
