# Rovloom Quick Start

**English** · [简体中文](QUICK-START-zh.md) · [Configuration reference](CONFIGURATION.md)

Rovloom has two roles:

- **Gateway** — the MCP entry point your AI client talks to.
- **Connector** — runs on each machine that has Herdr or Luvus and connects out to the Gateway.

Both roles can run on the same machine. The Gateway runs on Linux, macOS and Windows; the
Connector runs on Linux x64, macOS (x64, arm64) and Windows x64. On macOS and Windows it attaches to the Herdr or Luvus you already run.

## 1. Install

**Linux / macOS** (x64 or arm64; Linux needs glibc). No Bun, Node or root access required:

```sh
curl --fail --silent --show-error --location https://raw.githubusercontent.com/ArnoChenFx/rovloom/main/scripts/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
```

**Windows PowerShell** (x64 or arm64):

```powershell
Invoke-RestMethod https://raw.githubusercontent.com/ArnoChenFx/rovloom/main/scripts/install.ps1 | Invoke-Expression
$env:Path = "$env:LOCALAPPDATA\Rovloom\bin;$env:Path"
```

Both installers verify the binary against the release `SHA256SUMS`, install only the binary
(to `~/.local/bin/rovloom` or `%LOCALAPPDATA%\Rovloom\bin\rovloom.exe`), and do not create
configuration or services. Add that directory to your PATH permanently, then check:

```sh
rovloom --version
```

Binaries are also on the [releases page](https://github.com/ArnoChenFx/rovloom/releases/latest);
installer options are in [Distribution](DISTRIBUTION.md).

**Already have Bun (1.4.3 or newer)?** Rovloom is on the npm registry; install it globally, or run it
once without installing:

```sh
bun add -g rovloom
rovloom --version
bunx rovloom --version
```

Prefer pinned releases? Every release also carries the same package tarball as a release asset:

```sh
bun add -g https://github.com/ArnoChenFx/rovloom/releases/download/v<version>/rovloom-<version>.tgz
bunx --package https://github.com/ArnoChenFx/rovloom/releases/download/v<version>/rovloom-<version>.tgz rovloom --version
```

Upgrade with `bun update -g rovloom` (or repeat `bun add -g` with the new release's URL). The package
only runs on Bun, and `rovloom service install` still requires the standalone binary above.

**Gateway in Docker (Linux x64/arm64, Docker Compose v2)** — optional, instead of installing the
binary on the Gateway host:

```sh
mkdir rovloom && cd rovloom
curl --fail --location --output docker-compose.yaml \
  https://raw.githubusercontent.com/ArnoChenFx/rovloom/main/docker-compose.yaml
docker compose pull
docker compose run --rm gateway config init gateway --container
```

Ports 9443, 9444 and 9445 must be free (the Compose file publishes them from a bridge network), and `config init gateway --container` prepares the container listeners on first setup. See
[Docker deployment](DOCKER.md) for volumes, backup and upgrades.

## 2. Prepare the Connector machine

Install [Herdr](https://github.com/herdrdev/herdr/releases/latest) and/or
[Luvus](https://github.com/RizRiyz/luvus/releases/latest), plus the Agent you want to use, and
sign in to your model provider. Rovloom installs none of these.

The Connector **attaches to the session you already run**, so remote calls act on your real
workspaces and Agent logins. It starts one in your own config directory only if none is running.
Programs are found through `PATH` (plus `/usr/bin:/bin`); for other locations see
[installation directories](CONFIGURATION.md#program-and-agent-installation-directories).

Luvus is the default. Before first pairing, choose Herdr explicitly (use `mixed` for both):

```sh
rovloom config init connector --provider herdr
```

This creates configuration without starting the Connector or asking for an address. Existing configuration is preserved; if it selects another provider, the command returns `config_exists` so you can review it before changing it.

## 3. Pair

Open two real local terminals and keep them open:

| Gateway machine | Connector machine |
|---|---|
| `rovloom gateway` | `rovloom connector` |

Docker Gateway: run `docker compose run --rm --service-ports gateway` in the Compose directory instead (stop
any running Gateway first with `docker compose stop gateway`).

1. **Gateway terminal:** approve pairing to get a one-time code (valid for five minutes).
2. **Connector terminal:** enter the Gateway address (`ws://127.0.0.1:9443` on the same machine) and
   the code, and confirm you trust this Gateway.
3. **Connector terminal:** approve discovery of the Herdr/Luvus installation.
4. **Gateway terminal:** approve the displayed installation and its workspace/Agent access.
5. Save the **MCP URL and Bearer** the Gateway prints (and the admin password, shown once).
   Wait for `connector_ready`.

For a Connector on another machine, set the Gateway's `devices.hostname` so it listens beyond
loopback, and put HTTPS/WSS in front of anything outside a trusted network; see
[network access](CONFIGURATION.md#network-access).

Adding another device later does not require stopping the Gateway: an
administrator can create a pairing application on the management page and the
new device joins online with `rovloom connector --claim`; see
[Pairing](CONFIGURATION.md#pairing).

After pairing, stop the Gateway and Connector with Ctrl-C. Docker users then run
`docker compose up -d` and restart `rovloom connector`; the pairing is kept in the volumes.
From then on, start them with the same commands.

## 4. Connect your MCP client

Add a **Streamable HTTP** server in your AI client:

| Setting | Value |
|---|---|
| URL | `http://127.0.0.1:9444/mcp` (default) |
| Authorization header | `Bearer <the Bearer printed by the Gateway>` |

The pairing code is not the Bearer. The Bearer expires after 30 days; renew it with
`rovloom token renew` or `rovloom token rotate`. Remote clients reach the MCP listener through
your proxy or tunnel. Rovloom is not a stdio MCP server.

Then ask the client to list the machine's workspaces and Agents, and send an Agent a short message.
A call whose outcome is uncertain after a disconnect is reported as unknown and is never resent
automatically. Tool details are in the [MCP reference](protocol/MCP-HTTP.md).

The management page is at `http://127.0.0.1:9445/`. Sign in as `admin` with the password printed
at pairing, or issue a new one with `rovloom admin create`. It shows each device's connection and
lets you rename, disconnect or revoke devices and disable providers.

## 5. Everyday tasks

| Task | How |
|---|---|
| Add another device | Stop the Gateway, run `rovloom gateway --add-device`, then pair the new machine as above. The existing Bearer covers it; tokens made with `rovloom token create --like` must be re-created. |
| Credential lost or leaked | Stop that Connector, run `rovloom gateway --repair-device`, then `rovloom connector --repair` on the device. Native setup and access are kept; in-flight calls become unknown. |
| Run at boot | `rovloom service install --role gateway` (or `connector`) — see [Boot services](SERVICE.md). |
| Validate configuration | `rovloom config check --role gateway` (or `connector`). |
| Tokens, backup, upgrades | [Operations guide](OPERATIONS.md) |

Each role keeps one configuration file, created on first run and never reset:
`~/.config/rovloom/gateway.json` and `~/.config/rovloom/connector.json`. Every option is in the
[configuration reference](CONFIGURATION.md).

## Troubleshooting

| Symptom | What to do |
|---|---|
| `configuration_required` / `pairing_required` | Finish the terminal prompts and approvals; a saved Gateway address alone does not pair the device. |
| Cannot connect / address in use | Check ports, the Gateway listener address and network reachability. |
| HTTP 401 | Check the `/mcp` URL, the Bearer and its expiry. |
| `native_state_path_too_long` | Choose a shorter `data.directory` before pairing (Unix socket path limit). |
| `invalid_device_credential` | Re-pair the same device with `--repair-device` / `--repair`. A revoked device cannot be re-paired. |
| No Agent reply | Check the Agent's installation directory and model login; a ready Connector does not mean the model replied. |
| Setup interrupted with an uncertain outcome | Keep the existing data and ask your administrator; do not delete it and register again. |

Keep error codes when asking for help, and keep your Bearer secret.
