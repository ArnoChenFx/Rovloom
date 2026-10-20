# Docker deployment

[中文](DOCKER.md) · [User Quick Start](QUICK-START.md)

The Docker setup runs the **Gateway**, including its management page and MCP service. Run the Luvus/Herdr Connector on the Linux host that owns the native application.

## Availability

Image publication is being prepared for review. The pinned pull commands below become usable only after the complete `v0.1.0` product release succeeds, its GitHub Release is public, the subsequent GHCR workflow succeeds, and the package permits reads. This document does not claim the image already exists.

The targets are native Linux rootful Docker Engine on `linux/amd64` and `linux/arm64`. CI starts each image on a matching native runner; compilation alone is insufficient acceptance. This Compose file uses Linux host networking to preserve the product's loopback listeners. Rootless Engine and Docker Desktop have not been accepted by these tests.

## Start a Gateway

Install and start Docker Engine and Docker Compose v2 on your Linux host. Running the Gateway image requires no Bun, Node, Luvus, or Herdr installation.

Once the release and image are available, save the versioned Compose file in an empty directory:

```sh
mkdir rovloom && cd rovloom
curl --fail --location --output compose.yaml \
  https://raw.githubusercontent.com/ArnoChenFx/Rovloom/v0.1.0/compose.yaml
docker compose pull
docker compose up -d
docker compose ps
```

The only image location is `ghcr.io/arnochenfx/rovloom:0.1.0`. Separate named volumes preserve configuration and data; ordinary `docker compose down` keeps them. First startup creates one user configuration file at `/home/rovloom/.config/rovloom/gateway.json`. Its default data directory is `/home/rovloom/.local/share/rovloom/gateway`.

Default local endpoints:

| Purpose | Address | First startup |
| --- | --- | --- |
| Management page | `http://127.0.0.1:9445/` | Anonymous page, without an administrator session |
| MCP | `http://127.0.0.1:9444/mcp` | Unauthenticated requests receive 401 |
| Connector device listener | `127.0.0.1:9443` | Identity and provider configuration are still required |

`healthy` means the real MCP authentication listener responds. It does not establish pairing, an administrator login, or native Agent readiness. The initial `pairing_required` diagnostic means setup is pending. Follow the [User Quick Start](QUICK-START.md) for the configuration and pairing capabilities currently delivered.

Host networking uses the host's ports directly. Leave those ports free and do not add `ports` mappings. Defaults do not create a public listener. Remote Connectors require an explicitly configured standard TLS reverse proxy; these files do not configure a proxy or change host networking.

## Configure, stop, and update

The image runs as UID/GID `10001:10001` with a read-only root filesystem. Default named volumes inherit that ownership. For custom bind mounts, use that UID, `0700` for the configuration directory, and `0600` for the configuration file. Do not use `chmod 777` to bypass ownership checks.

Export the generated configuration for editing:

```sh
docker compose cp gateway:/home/rovloom/.config/rovloom/gateway.json ./gateway.json
chmod 600 gateway.json
```

Keep the single file's `data`, `mcp`, `devices`, and `management` groups. After editing, replace it atomically as the container's original user and restart:

```sh
docker compose exec -T gateway sh -c \
  'umask 077; cat > /home/rovloom/.config/rovloom/gateway.json.next && mv /home/rovloom/.config/rovloom/gateway.json.next /home/rovloom/.config/rovloom/gateway.json' \
  < gateway.json
docker compose restart gateway
```

If you change the MCP port, also set `ROVLOOM_MCP_PORT` in the Compose directory's `.env` for the health check. That variable does not change the configuration's listener port. Keep data inside its persistent volume. The user configuration contains no old `runtime.json`, ref list, or private CA paths. Program-managed identity/provider state is not a user configuration template.

```sh
docker compose stop       # SIGTERM and graceful shutdown
docker compose start      # Reuse configuration and data
docker compose down       # Remove containers and networks; retain named volumes
```

`docker compose down -v` deletes persistent volumes, including configuration and data. Use it only when you intend to discard them. Before upgrading, stop normally and back up the volumes. Set `ROVLOOM_VERSION` to an explicit new version, then run `docker compose pull && docker compose up -d`. Publication assigns `latest` only to the current official latest stable release; Compose always defaults to a pinned version.

## Where to run the Connector

Keep the Connector on a supported Linux x64 host running Luvus/Herdr. The native process owners currently reject other architectures; the Linux arm64 Gateway image does not establish support for an arm64 native Connector. It must verify the actual native binary/schema, process ownership, private file permissions, Unix socket peer, and instance lifecycle. Container users, PIDs, and paths differ from those of the host; mounting a host socket does not establish those guarantees.

The default Compose file therefore has no Connector, `/var/run/docker.sock` mount, `privileged` flag, host PID namespace, or additional capabilities. A containerized Connector would need a correctly installed and managed native application in the same container and separate acceptance. That path is not currently claimed as available.

## Publication and acceptance

PR and main container workflows build and test without registry login or publication. Official publication follows only a successful official `Tagged product release`: verify its tag, commit, public Release, six-platform manifest, and `SHA256SUMS`, then build from its two Linux binaries. After both native image tests pass, the publishing job uses its short-lived `GITHUB_TOKEN` with minimal `packages: write` to publish to GHCR and create a pinned multi-architecture manifest. An existing version is reused without rewriting only when its two complete image descriptors exactly match the current tested artifacts, allowing a failed latest step to resume. Different bytes and uncertain registry lookups block overwriting.

GitHub documents that a new GHCR package [defaults to private visibility](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry). A maintainer must verify the first GHCR package's public visibility and permission for an existing package. The workflow does not change account or package settings. If anonymous pulls fail, check public visibility and repository access rather than adding a long-lived token to configuration or documentation.

Container smoke tests use isolated containers without external networking and private named volumes. They verify non-root execution, the exact binary digest, first-run single-file configuration, real databases, MCP 401, embedded management resources, graceful termination, and restart persistence. They do not call models or create real external identities. Complete native provider/Worker acceptance remains a prerequisite in the product release gate; an unpaired first startup does not replace it.
