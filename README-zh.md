<p align="center">
  <img src="docs/assets/brand/rovloom-logo-panel.svg" alt="Rovloom — 橙红编织 R 与 ovloom 字标" width="600">
</p>

<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>

# Rovloom

Rovloom 为 AI Agent 和 Bot 提供统一的 MCP 入口，让它们操作你所有机器上运行的
[Herdr](https://github.com/herdrdev/herdr) 与 [Luvus](https://github.com/RizRiyz/luvus) 会话。
**Gateway** 提供 MCP 接口，每台机器上的 **Connector** 主动连接它：工作区和 Agent 登录留在原机器，
运行它们的机器无需开放任何入站端口。

## 特性

- **多设备接入**：每台设备运行一个 Connector，主动出站连接同一个 Gateway。
- **显式目标**：每次调用都指明设备、runtime 与 session，不做隐式选择。
- **原生 runtime**：Herdr 与 Luvus 各自保留自己的契约与能力。
- **分层访问控制**：每次调用同时受 Gateway 与设备本地策略约束；终端执行默认关闭，由设备所有者开启。
- **如实的结果**：断线后结果不确定的调用会标为未知，绝不自动重发。
- **管理页**：查看设备与 provider，重命名、断开或撤销；MCP Bearer 令牌通过 CLI 签发与轮换。

## 工作方式

AI Agent 与 CLI 通过 MCP 访问 Gateway。每台设备运行一个 Connector 和本地 provider 适配层，
可管理多个 runtime 实例。

<p align="center">
  <a href="docs/assets/architecture/architecture.zh.svg">
    <img src="docs/assets/architecture/architecture.zh.png" alt="Rovloom 架构：MCP 客户端接入 Gateway；每台设备一个主动出站的 Connector，通过 Provider Adapter 访问本地 Luvus 与 Herdr。" width="1200">
  </a>
</p>

实线表示请求与返回的结果/事件，虚线表示 Connector 主动建立出站 WSS 连接。点击图片可查看矢量大图。

## 典型用法：两台机器，一个 Agent

你的工作站上运行着日常使用的 Herdr（或 Luvus），里面有你的工作区和 Agent 登录；一台常开的小主机运行 Gateway。
AI 客户端通过 MCP 访问 Gateway，并操作工作站上的真实会话。

1. Gateway 主机：`rovloom gateway`。
2. 工作站：`rovloom connector`，输入 Gateway 地址和一次性码。
3. 把 Gateway 的 MCP 地址和 Bearer 加到 AI 客户端，让它列出工作站的工作区。

## 安装

```sh
curl --fail --silent --show-error --location https://raw.githubusercontent.com/ArnoChenFx/rovloom/main/scripts/install.sh | sh
```

已装 Bun（1.4.3 及以上）也可以用 npm 包：`bun add -g rovloom` 全局安装，`bunx rovloom` 免安装运行，无需下载内置运行时的单文件。

Windows PowerShell 与 Docker Gateway 见[快速开始](docs/QUICK-START-zh.md)。

| | Linux | macOS | Windows |
|---|---|---|---|
| Gateway | x64、arm64 | x64、arm64 | x64、arm64 |
| Connector | x64 | x64, arm64 | x64 |

配对 Connector 需要真实的本地终端。

## 文档

- [快速开始](docs/QUICK-START-zh.md) · [配置参考](docs/CONFIGURATION-zh.md) · [Docker 部署](docs/DOCKER-zh.md)
- [运维指南](docs/OPERATIONS.md) · [开机服务](docs/SERVICE.md)
- [系统架构](docs/DESIGN.md) · [协议总览](docs/PROTOCOL.md)
- [开发与验证](docs/DEVELOPMENT.md) · [贡献指南](CONTRIBUTING.md)
- [文档索引](docs/README.md)

## 许可证

[Apache-2.0 许可证](LICENSE)
