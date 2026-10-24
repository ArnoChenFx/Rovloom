# Architecture artwork / 架构图片

The [English README](../../../README.md#how-it-works) and
[中文 README](../../../README-zh.md#工作方式) display hand-designed, bilingual
architecture images. These are ordinary committed images; GitHub does not need
Mermaid or JavaScript to display them.

- [English PNG](architecture.en.png) · [SVG](architecture.en.svg)
- [中文 PNG](architecture.zh.png) · [SVG](architecture.zh.svg)

The 2880 × 3280 PNGs preserve the exact typography on any viewer. Each links to a
1440 × 1640 self-contained SVG for zooming; SVGs have a title and text description,
and embed the original brand mark without external resource requests. The pale
canvas deliberately stays consistent in light and dark README themes.

双语 README 直接显示高清 PNG，点击可查看 SVG 矢量图；无需 Mermaid 插件或客户端脚本。
PNG 保留完整中文字体，SVG 提供标题和文字描述，品牌图标内嵌，所有图片均使用浅色画布。

## Source and regeneration / 源文件与生成

The source of truth is [render-architecture.py](../../../scripts/maintenance/render-architecture.py).
It draws both languages from a shared layout and localized copy. The former Mermaid
files have been replaced so there is only one diagram source to maintain.

From the repository root:

```sh
# Generate the two SVGs with the Python standard library only.
python3 scripts/maintenance/render-architecture.py

# Also generate the two 2x PNGs. Requires Playwright, Chromium and Noto Sans CJK SC.
python3 scripts/maintenance/render-architecture.py --png
# Use --chromium /path/to/chromium when needed.
```

Commit all four generated assets after changing the script. Inspect both languages
at README width and full size; check labels, arrow endpoints and device boundaries.
The generator makes no network requests and never starts Gateway or Connector.

布局和双语文案统一维护在生成脚本中。修改后重新生成并提交四张图片，检查双语文字、箭头方向和设备边界。
图片导出需 Python Playwright、Chromium 和 Noto Sans CJK SC；只生成 SVG 不依赖这些工具。

## Architecture semantics / 架构含义

- The deployment regions are clients, one self-hosted Gateway, and separate devices.
  Inside each device, the hierarchy continues through Connector → adapters → runtime → session Agents.
- Every device has one identity and one outbound Connector. Provider adapters
  bind separately to local Luvus Host/session and Herdr session runtimes.
- Each runtime contains an explicit session Agent layer, illustrated with Claude Code,
  Codex, Pi, OpenCode, Fx and an ellipsis. These are examples, not a per-runtime
  compatibility matrix; actual capabilities depend on local installation and runtime support.
- Solid bidirectional arrows show application traffic: requests travel downward;
  results/events return. They do not describe who opens the socket.
- Dashed orange arrows show Connector → Gateway outbound WSS initiation.
- Gateway and Connector use the same original Rovloom orange R mark; both are Rovloom components.
- The management UI, call ledger and result storage belong to Gateway.
- Workspaces, sessions and Agent logins stay on the original devices.

部署区域分为客户端、一个自部署 Gateway 和各台设备；设备内依次展示 Connector、Adapter、Runtime 与会话 Agent。
每台设备一套身份、一个 Connector，
Adapter 独立绑定各原生实例。实线双向表示业务通信，橙色虚线表示主动出站连接；
Gateway 与 Connector 均使用 Rovloom 原始橙色 R 标识，体现两者同属 Rovloom。
管理页、调用账本和结果存储属于 Gateway，工作区与 Agent 登录留在原设备。
每个 Runtime 内进一步展示会话中的 Agent 层，以 Claude Code、Codex、Pi、OpenCode、Fx 等为例；
这些是层级示意，实际能力取决于本机安装与对应 Runtime 的支持。

References: [DESIGN](../../DESIGN.md), [ADR 0004](../../adr/0004-multi-runtime-provider.md),
[Gateway Web UI](../../GATEWAY-WEBUI.md).
