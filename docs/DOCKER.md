# Docker deployment

[中文](DOCKER-zh.md) · [Quick Start](QUICK-START.md)

The Docker setup runs the **Gateway**, including its management page and MCP service. Run the Luvus/Herdr Connector on the Linux host that owns the native application.

## Supported platforms

The official image is `ghcr.io/arnochenfx/rovloom`. It is public and can be pulled anonymously. It supports native Linux rootful Docker Engine on `linux/amd64` and `linux/arm64`. The Compose file uses host networking to keep the product's loopback listeners. Rootless Engine and Docker Desktop are not supported.

## Start a Gateway

Install Docker Engine and Docker Compose v2 on a Linux host. The Gateway image needs no Bun, Node, Luvus or Herdr.

Save the maintained Compose file in an empty directory and start it:

```sh
mkdir rovloom && cd rovloom
curl --fail --location --output docker-compose.yaml \
  https://raw.githubusercontent.com/ArnoChenFx/rovloom/main/docker-compose.yaml
docker compose pull
docker compose up -d
docker compose ps
```

The image defaults to `ghcr.io/arnochenfx/rovloom:latest`. To pin a version, set `ROVLOOM_VERSION=<version>` in the Compose directory's `.env` before pulling. Two named volumes keep configuration and data, and `docker compose down` does not delete them. First startup creates `/home/rovloom/.config/rovloom/gateway.json`. The data directory is `/home/rovloom/.local/share/rovloom/gateway`.

Default local endpoints:

| Purpose | Address | First startup |
| --- | --- | --- |
| Management page | `http://127.0.0.1:9445/` | Empty page, no administrator yet |
| MCP | `http://127.0.0.1:9444/mcp` | Unauthenticated requests receive 401 |
| Connector device listener | `127.0.0.1:9443` | Pairing is still required |

`healthy` means the MCP authentication listener responds. It does not mean a device is paired, an administrator exists or an Agent is ready. The `pairing_required` log line means setup is pending.

Host networking uses the host's ports directly. Keep those ports free and do not add `ports` mappings. The defaults open no public listener. For remote Connectors, put a standard TLS reverse proxy in front yourself (see [OPERATIONS](OPERATIONS.md)).

## First pairing

The background service has no interactive terminal. In a real terminal in the Compose directory, stop it and run a foreground Gateway on the same volumes:

```sh
docker compose stop gateway
docker compose run --rm gateway
```

Keep this terminal open for pairing and native installation approval. On the Linux x64 Connector host, run `rovloom connector` in another local terminal and follow [Start and pair](QUICK-START.md#2-start-and-pair). Never run a second Gateway on the same data.

When setup reaches `connector_ready`, stop the Connector, then stop the foreground Gateway with Ctrl-C. Run `docker compose up -d` and restart the host Connector. Configuration and pairing stay in the volumes.

To add another device or re-pair a device, stop the background Gateway and run `docker compose run --rm gateway gateway --add-device` (or `gateway --repair-device`). Then continue on the Connector host as in the Quick Start.

## Configure, stop and upgrade

The image runs as UID/GID `10001:10001` with a read-only root filesystem. The default volumes already have that owner. For bind mounts, use that UID, mode `0700` for the configuration directory and `0600` for the file. Do not use `chmod 777`.

Export the generated configuration to edit it:

```sh
docker compose cp gateway:/home/rovloom/.config/rovloom/gateway.json ./gateway.json
chmod 600 gateway.json
```

Keep the `data`, `mcp`, `devices` and `management` groups. Fields are listed in the [configuration reference](CONFIGURATION.md). After editing, replace the file as the container's user and restart:

```sh
docker compose exec -T gateway sh -c \
  'umask 077; cat > /home/rovloom/.config/rovloom/gateway.json.next && mv /home/rovloom/.config/rovloom/gateway.json.next /home/rovloom/.config/rovloom/gateway.json' \
  < gateway.json
docker compose restart gateway
```

If you change the MCP port, also set `ROVLOOM_MCP_PORT` in `.env` so the health check follows. The variable does not change the listener port. Keep the data directory inside its volume.

```sh
docker compose stop       # SIGTERM and graceful shutdown
docker compose start      # Reuse configuration and data
docker compose down       # Remove containers and networks; keep volumes
```

`docker compose down -v` deletes the volumes, including configuration and data. To upgrade, stop normally, back up the volumes, then run `docker compose pull && docker compose up -d`. `latest` always points to the newest stable release. `rovloom --version` inside the container reports the actual version.

## Where to run the Connector

Run the Connector on the Linux x64 host that runs Luvus/Herdr. It verifies the native binary and schema, process ownership, private file permissions, the Unix socket peer and the instance lifecycle. A container has different users, PIDs and paths, and mounting a host socket does not preserve those guarantees. The Compose file therefore has no Connector, no `/var/run/docker.sock` mount, and no `privileged`, host PID or extra capabilities.

## Image build

Images are built from the released Linux binaries and published to GHCR by the release workflow. Maintainers: see [DISTRIBUTION](DISTRIBUTION.md).
