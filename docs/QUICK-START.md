# Rovloom Quick Start

**English** · [简体中文](QUICK-START-zh.md) · [Configuration reference](CONFIGURATION.md)

Use one **Gateway** as your AI client's MCP entry point. Run one **Connector**
on each machine where Luvus or Herdr runs; it connects out to the Gateway.
Both roles can run on the same machine.

Gateway runs on Linux/macOS/Windows. The guided first-pairing and native Connector
flow below requires Linux x64. Guided Agent/model login is not available yet. A new installation cannot complete model setup through Rovloom alone.

## 1. Prepare the programs

### Linux and macOS

Install the latest stable release on x64 or arm64 (Linux requires glibc):

```sh
curl --fail --silent --show-error --location https://raw.githubusercontent.com/ArnoChenFx/Rovloom/main/scripts/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
```

The default destination is `~/.local/bin/rovloom`. The installer requires `curl`
and `sha256sum` or `shasum`; it does not require Bun, Node or root access.

### Windows PowerShell

Install the latest stable release for the native x64 or arm64 architecture:

```powershell
Invoke-RestMethod https://raw.githubusercontent.com/ArnoChenFx/Rovloom/main/scripts/install.ps1 | Invoke-Expression
$env:Path = "$env:LOCALAPPDATA\Rovloom\bin;$env:Path"
```

The default destination is `%LOCALAPPDATA%\Rovloom\bin\rovloom.exe`.
Both installers verify the binary against the release's `SHA256SUMS` before
replacing an existing program. They install only the binary; they do not create
role configuration or services. The PATH commands above affect the current
terminal; add the installation directory to your user PATH for future terminals.
Check the installation:

```sh
rovloom --version
rovloom --help
```

You can also download a binary and `SHA256SUMS` from the
[official releases](https://github.com/ArnoChenFx/Rovloom/releases/latest).
See [distribution details](DISTRIBUTION.md#用户安装器) for installer options.

### Docker Gateway on Linux

With Docker Engine and Compose v2 on a native Linux x64 or arm64 host, run the
Gateway without installing the binary on that host:

```sh
mkdir rovloom && cd rovloom
curl --fail --location --output docker-compose.yaml \
  https://raw.githubusercontent.com/ArnoChenFx/Rovloom/main/docker-compose.yaml
docker compose pull
docker compose up -d
docker compose ps
```

The official image is `ghcr.io/arnochenfx/rovloom:latest`; to pin the published
version, set `ROVLOOM_VERSION=0.1.1` in this directory's `.env` before pulling.
The Compose file uses Linux host networking and persistent configuration/data
volumes. Keep ports 9443, 9444 and 9445 free; no `ports` mappings are needed.
Rootless Docker and Docker Desktop are not validated deployment targets.

The management page is at `http://127.0.0.1:9445/`, and MCP at
`http://127.0.0.1:9444/mcp`. A fresh Gateway is unpaired: `healthy` confirms the
listener responds, and MCP returns 401 without authentication. Continue with
the terminal pairing below. Run the Connector on the supported Linux x64 host
that owns Luvus/Herdr. See [Docker deployment](DOCKER.md) for configuration,
backup and upgrades; `docker compose down` keeps volumes, while `down -v`
deletes configuration and data.

### Luvus, Herdr and your Agent

For the guided setup below, install official [latest Luvus](https://github.com/RizRiyz/luvus/releases/latest),
[latest Herdr](https://github.com/herdrdev/herdr/releases/latest), or both on the Connector machine. Install your chosen Agent separately if you want a
conversation. Rovloom does not install these programs or sign in to a model provider.

By default, Rovloom looks for the selected native programs and the Agent in `/usr/bin:/bin`.
For another installation directory, set `native.runtime_bin_dir` and/or
`native.agent_bin_dir` in the Connector's single configuration **before approving
native setup**. See the [installation settings](CONFIGURATION.md#agent-installation-directory).
To select Herdr or both programs, set `native.provider` to `herdr` or `mixed`
before native approval; omitting it selects Luvus.
An Agent login in your ordinary home is not reused; ask the machine owner to
prepare model access in Rovloom's isolated Agent environment. The login guide
for that environment is still missing.

## 2. Start and pair

Run these commands in two real local terminals, keeping both open:

| Gateway machine | Connector machine |
|---|---|
| `rovloom gateway` | `rovloom connector` |

For a Docker Gateway, use these commands in a real terminal in the Compose
directory instead of `rovloom gateway`:

```sh
docker compose stop gateway
docker compose run --rm gateway
```

This foreground instance reuses the same volumes and shows the pairing prompts.
Keep it open throughout approval; do not run two Gateways against the same data.
The Connector command still runs on its host, outside the container.

1. In the Gateway terminal, approve pairing to obtain a private one-time code,
   valid for five minutes.
2. In the Connector terminal, enter the Gateway address. For the same machine,
   use `ws://127.0.0.1:9443`. Paste the code and confirm that you trust this Gateway.
3. Approve discovery and initialization of each selected installation on the Connector.
   Then return to the Gateway terminal and approve the displayed installation
   and workspace/Agent access.
4. Save the MCP connection details displayed privately by the Gateway in your
   MCP client's secret storage. Wait for **`connector_ready`** before trying a call.

After completing Docker setup, stop the Connector and then the foreground Gateway
with Ctrl-C. Run `docker compose up -d`, then restart `rovloom connector` on its
host. The saved pairing remains in the volumes.

Each role automatically creates its own missing user file, then uses that same
file on later starts. **Default configuration and user configuration are the
same file.** You do not need to prepare other configuration files.

| Role | The one user configuration |
|---|---|
| Gateway | `~/.config/rovloom/gateway.json` |
| Connector | `~/.config/rovloom/connector.json` |

For Docker, the Gateway file is inside the configuration volume at
`/home/rovloom/.config/rovloom/gateway.json`.

Existing files are read without being reset, including when an error needs your
attention. To change an installation directory, stop the Connector before native
approval, edit `connector.json`, then start it again. The
[configuration reference](CONFIGURATION.md) has complete examples and every option.

For a Connector on another device, first configure Gateway `devices.hostname`
to listen beyond loopback and enter its reachable WS/WSS address in the Connector.
Defaults accept local connections only. Public access needs your administrator's
HTTPS/WSS proxy or tunnel arrangement; see [network settings](CONFIGURATION.md#network-access).

## 3. Connect your MCP client

Add a server in an AI client that supports **Streamable HTTP**:

| Client setting | Value |
|---|---|
| Transport | Streamable HTTP |
| URL | `http://127.0.0.1:9444/mcp` with the default Gateway settings |
| Authorization header | `Bearer <MCP_BEARER_FROM_GATEWAY>` |

Use the Bearer displayed after Gateway approval, or the existing credential
provided by the Gateway administrator for this endpoint. The pairing code is
not the MCP Bearer. The Bearer expires after 30 days; renewal guidance is not yet
available. Remote clients need access to the Gateway's loopback MCP listener
through the administrator's proxy or tunnel. Rovloom is not a stdio MCP server.

Let the client finish loading the server's tools. Ask it to list the connected
machine's workspaces and panes, then its available Agents. If asked which
device/runtime/session to use, use the selection displayed by the Gateway.
Detailed tool invocation is in the [MCP reference](protocol/MCP-HTTP.md#client-call-sequence).

Once your Agent and model access are prepared, select an Agent and ask it to send
a short message, read the reply, and continue in the same conversation. A ready
Connector or a queued prompt does not mean the model has replied. If a call's
outcome is uncertain, check that call before sending the message again.

## 4. Check, stop and troubleshoot

After editing, check the saved file without starting the role:

```sh
rovloom config check --role gateway
rovloom config check --role connector
```

Run only the command for the role installed on that machine. Plain
`rovloom config check` reads **both default files** and reports each result;
it does not create missing files. An optional `--config /absolute/path.json`
selects a different file for either startup or checking. Paths inside JSON must
also be absolute; `~` and environment variables are not expanded there.

Stop the Connector with Ctrl-C and wait for it to exit, then stop the Gateway.
Next time, run the same commands with the same user files and data. Gateway can
also run as a Linux systemd or macOS system LaunchDaemon; native Connector service
support remains Linux x64. See [boot services](SERVICE.md) for the five commands,
required OS authorization and account/configuration choices. Windows Gateway uses
an existing user's boot-triggered task and the same config file; native Connector
service remains Linux x64. Automatic update replacement remains unavailable.

| Problem | What to do |
|---|---|
| `configuration_required` / `pairing_required` | Complete the Linux local-terminal prompts and approvals. A saved Gateway address alone does not pair the device. |
| Configuration or permission error | Check the role file, absolute paths and whether your account can access the file and data directory through normal OS permissions. Existing files are not reset automatically. |
| `native_state_path_too_long` | Before pairing, choose a shorter `data.directory`; its path plus `/n` must fit within 52 UTF-8 bytes. |
| Address in use / cannot connect | Check the configured ports, Gateway listener address and network reachability. |
| HTTP 401 | Check the `/mcp` URL, Bearer and expiry; pairing must be complete. |
| Agent executable missing / no model reply | Check the Agent installation directory and model login in the isolated Agent environment; shell login alone is insufficient. |
| Setup or shutdown interrupted with an uncertain outcome | Keep the existing data and ask your administrator for help; do not delete it and register again. |

Keep error codes when asking for help; keep your Bearer and private data secret.
