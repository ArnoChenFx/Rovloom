<p align="center">
  <img src="docs/assets/brand/rovloom-logo-panel.svg" alt="Rovloom — 橙红编织 R 与 ovloom 字标" width="600">
</p>

<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>

# Rovloom

让 MCP Agent 通过统一入口访问多台设备上的本地 Luvus 与 Herdr runtime。
Rovloom 采用一个 Gateway、每设备一个主动出站 Connector 的架构，
让 runtime 留在各自机器上，客户端通过同一入口访问。

**当前可用范围：** Linux 源码构建预览，尚未提供可部署的 Gateway/Connector 服务或远程 runtime 执行。

## 核心能力

目标产品提供以下能力：

- **多设备接入：** 各设备的 Connector 主动出站连接到同一个 Gateway。
- **显式目标：** 每次操作明确选择设备、runtime 实例与 session。
- **原生适配：** Luvus 与 Herdr 分别保留各自的契约和能力边界。
- **受控访问：** Gateway 与本地策略共同约束调用、结果和流，并提供内置设备与 runtime 管理。

## 架构

上层是客户端，中层是 Gateway；下层每台设备运行一个 Connector 与本地 Provider Adapter。
同一个 Connector 可以管理多个 runtime 实例。

<!-- Keep this fence identical to docs/assets/architecture/target.zh.mmd. -->
```mermaid
flowchart TB
  subgraph CLIENTS["客户端 / CLI / MCP"]
    direction LR
    MCP["MCP 客户端 / Agent"]
    CLI["CLI"]
  end

  GW["Gateway<br/>MCP 入口 · 注册 · 路由 · 策略<br/>调用账本 · 结果存储 · 管理 UI"]

  subgraph DEVICE_A["设备 A"]
    direction TB
    CA["一个 Connector<br/>一套设备身份 · 本地策略"]
    PA["Provider Adapter 适配层<br/>各实例独立可信绑定"]
    LA["本地 Luvus<br/>Host / session"]
    HA["本地 Herdr<br/>session runtime"]
    CA <--> PA
    PA <--> LA
    PA <--> HA
  end

  subgraph DEVICE_B["设备 B"]
    direction TB
    CB["一个 Connector<br/>一套设备身份 · 本地策略"]
    PB["Provider Adapter 适配层<br/>各实例独立可信绑定"]
    LB["本地 Luvus<br/>Host / session"]
    HB["本地 Herdr<br/>session runtime"]
    CB <--> PB
    PB <--> LB
    PB <--> HB
  end

  MCP <-->|"MCP 请求 / 结果"| GW
  CLI <-->|"命令 / 结果"| GW
  GW <-->|"请求 ↓ · 结果 / 事件 ↑"| CA
  GW <-->|"请求 ↓ · 结果 / 事件 ↑"| CB
  CA -.->|"主动发起出站 WSS"| GW
  CB -.->|"主动发起出站 WSS"| GW
```

## 快速开始

使用 **Bun 1.4.3** 构建源码预览：

```sh
git clone https://github.com/ArnoChenFx/Rovloom.git
cd Rovloom
bun install
bun run build
```

以上命令构建当前核心；服务启动、设备配对及端到端 runtime 访问将在后续预览中提供。

## 文档

- [系统架构与部署](docs/DESIGN.md)
- [Runtime 接口](docs/adr/0004-multi-runtime-provider.md)
- [实施路线](docs/IMPLEMENTATION-PLAN.md)
- [管理 UI 设计](docs/GATEWAY-WEBUI.md)
