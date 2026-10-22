# Docker 部署

[English](DOCKER.md) · [快速开始](QUICK-START-zh.md)

Rovloom 的 Docker 方案运行 **Gateway**，包含管理页和 MCP 服务。Luvus/Herdr Connector 运行在原生程序所在的 Linux 主机上。

## 支持平台

官方镜像为 `ghcr.io/arnochenfx/rovloom`，公开，可匿名拉取。支持原生 Linux rootful Docker Engine 的 `linux/amd64` 与 `linux/arm64`。Compose 使用 host 网络以保留产品的回环监听。不支持 rootless Engine 和 Docker Desktop。

## 从零启动 Gateway

在 Linux 主机上安装 Docker Engine 与 Docker Compose v2。运行 Gateway 镜像不需要 Bun、Node、Luvus 或 Herdr。

在一个空目录保存维护的 Compose 文件并启动：

```sh
mkdir rovloom && cd rovloom
curl --fail --location --output docker-compose.yaml \
  https://raw.githubusercontent.com/ArnoChenFx/rovloom/main/docker-compose.yaml
docker compose pull
docker compose up -d
docker compose ps
```

默认镜像为 `ghcr.io/arnochenfx/rovloom:latest`。要固定版本，拉取前在 Compose 目录的 `.env` 写入 `ROVLOOM_VERSION=<版本>`。两个命名卷分别保存配置与数据，`docker compose down` 不会删除它们。首次启动生成 `/home/rovloom/.config/rovloom/gateway.json`，数据目录为 `/home/rovloom/.local/share/rovloom/gateway`。

默认本机入口：

| 用途 | 地址 | 首次启动状态 |
| --- | --- | --- |
| 管理页 | `http://127.0.0.1:9445/` | 空页面，尚无管理员 |
| MCP | `http://127.0.0.1:9444/mcp` | 未认证请求返回 401 |
| Connector 设备监听 | `127.0.0.1:9443` | 仍需配对 |

`healthy` 只说明 MCP 认证监听已响应，不表示设备已配对、管理员已存在或 Agent 已就绪。日志中的 `pairing_required` 表示等待配对。

host 网络直接使用主机端口，请保持这些端口空闲，不要另加 `ports` 映射。默认不开放公网监听。远程 Connector 需要你自行在前面放置标准 TLS 反向代理（见[网络访问](CONFIGURATION-zh.md#网络访问)）。

## 首次配对

后台服务没有交互终端。在 Compose 目录的真实终端中先停止后台服务，再用同一组卷启动前台 Gateway：

```sh
docker compose stop gateway
docker compose run --rm gateway
```

保持这个终端开启，用于配对和原生安装批准。在 Linux x64 Connector 主机的另一个本地终端运行 `rovloom connector`，按[配对](QUICK-START-zh.md#3-配对)继续。不要让第二个 Gateway 使用同一份数据。

到达 `connector_ready` 后，先停止 Connector，再按 Ctrl-C 停止前台 Gateway。执行 `docker compose up -d`，然后重新启动主机 Connector。配置和配对保留在卷中。

加入更多设备或重新配对某台设备时，先停止后台 Gateway，运行 `docker compose run --rm gateway gateway --add-device`（或 `gateway --repair-device`），再按快速开始在 Connector 主机上继续。

## 配置、停止与升级

镜像以 UID/GID `10001:10001` 运行，根文件系统只读。默认命名卷已按该身份初始化；自定义 bind mount 时，目录应属于该 UID，配置目录为 `0700`，配置文件为 `0600`。不要用 `chmod 777`。

导出生成的配置进行编辑：

```sh
docker compose cp gateway:/home/rovloom/.config/rovloom/gateway.json ./gateway.json
chmod 600 gateway.json
```

保留 `data`、`mcp`、`devices` 和 `management` 分组，字段见[配置参考](CONFIGURATION-zh.md)。编辑完成后，以容器用户替换配置并重启：

```sh
docker compose exec -T gateway sh -c \
  'umask 077; cat > /home/rovloom/.config/rovloom/gateway.json.next && mv /home/rovloom/.config/rovloom/gateway.json.next /home/rovloom/.config/rovloom/gateway.json' \
  < gateway.json
docker compose restart gateway
```

修改 MCP 端口时，同时在 `.env` 设置 `ROVLOOM_MCP_PORT`，让健康检查跟随；该变量不会修改监听端口。数据目录应保持在持久卷内。

```sh
docker compose stop       # SIGTERM，等待正常关闭
docker compose start      # 复用原配置和数据
docker compose down       # 删除容器和网络，保留命名卷
```

`docker compose down -v` 会删除卷，包括配置和数据。升级时先正常停止并备份卷，再执行 `docker compose pull && docker compose up -d`。`latest` 始终指向最新稳定版；容器内 `rovloom --version` 报告实际版本。

## Connector 运行位置

Connector 应运行在 Luvus/Herdr 所在的 Linux x64 主机上。它要核验原生 binary 与 schema、进程归属、私有文件权限、Unix socket 对端和实例生命周期；容器内的用户、PID 和路径与主机不同，挂载宿主 socket 无法保持这些保证。因此 Compose 不含 Connector，不挂载 `/var/run/docker.sock`，也不要求 `privileged`、主机 PID 或额外 capability。

## 镜像构建

镜像由发行流程基于已发布的 Linux 二进制构建并推送到 GHCR。维护者见 [DISTRIBUTION](DISTRIBUTION.md)。
