# Rovloom Quick Start

**English** · [简体中文](QUICK-START-zh.md) · [Configuration reference](CONFIGURATION.md)

Run one **Gateway** as the MCP entry point and one outbound **Connector** on each
machine running Luvus or Herdr. Each role owns one user configuration file and a
separate data directory.

## 1. Install and start

This preview's runtime requires **Linux x64**. There is no published installation
package yet; obtain the approved standalone executable from your administrator
and place it on your PATH. Check `rovloom --version` and `rovloom --help`.

On the Gateway machine:

```sh
rovloom gateway
```

On the runtime machine:

```sh
rovloom connector
```

The first command creates a missing `~/.config/rovloom/gateway.json`, opens the
local Gateway and reports `gateway_listening` and `pairing_required`. Its MCP URL
is `http://127.0.0.1:9444/mcp`; the device WS listener is on `127.0.0.1:9443` and
the local management page is `http://127.0.0.1:9445/`. The unpaired Gateway grants
no MCP identity or administrator access. Its page is not a default administrator login.

The second command creates a missing `~/.config/rovloom/connector.json` and exits
with `configuration_required` (2). **The interactive address/code wizard,
one-time pairing delivery and automatic native setup are not connected yet.**
There is no complete fresh-device deployment path in this preview. An existing
installation still needs its program-managed paired identity, provider state and
MCP caller access; changing JSON or receiving a pairing-progress display does
not create those resources. Do not construct hashes, bindings or credentials by hand.

On non-interactive input the Connector returns immediately; it does not wait for
stdin. There is no `init` or `pair` command. The remaining steps apply after an
administrator has supplied a working installation, and do not claim fresh setup
has completed.

## 2. Configuration and network

| Role | User configuration | Default data directory |
|---|---|---|
| Gateway | `~/.config/rovloom/gateway.json` | `~/.local/share/rovloom/gateway` |
| Connector | `~/.config/rovloom/connector.json` | `~/.local/share/rovloom/connector` |

`~` here means the current process user's home. Both roles generate only their own
missing file and never overwrite an existing file, including a malformed one.
`--config /absolute/path.json` selects that exact file, including for first
creation. There is no working-directory search, cross-role fallback or AppData/XDG
override. Windows uses the same home-relative path convention, but runtime and
first-file creation currently require Linux. Existing protected role JSON can be
checked on POSIX. Paths inside JSON are normalized absolute paths; `~`, variables
and paths relative to the JSON are not expanded.

Use the [complete examples and parameter tables](CONFIGURATION.md). File mode is
`0600`, its private directory is `0700`, owned by the role user. Program-managed
state, databases and credentials belong under the role's data directory. There is
no user `runtime.json`, ref list, CA or certificate file to prepare.

For another device, set Gateway `devices.hostname` to an appropriate listener and
Connector `gateway.url` to its reachable `ws://host:port` or `wss://host:port` origin,
without `/connector`, credentials or query parameters. Defaults are local only.
Use HTTP/WS for local or trusted-network access; public TLS is terminated by your
standard HTTPS/WSS reverse proxy. WSS uses system certificate validation, with no
CA override or skip-verification setting. MCP remains loopback HTTP; remote MCP
access requires an administrator's proxy or tunnel arrangement.

Check saved configuration without starting a role:

```sh
rovloom config check --config /absolute/path/gateway.json
rovloom config check-runtime --config /absolute/path/gateway.json
```

Repeat for Connector. Checks do not create missing files, pair devices, load
credentials or establish Agent readiness. Foreground roles keep running until
Ctrl-C; an MCP client disconnect does not stop Gateway.

## 3. Prepare the native programs

Install the approved official Luvus or Herdr and the Agent you intend to use.
Current native version/byte checks and controlled PATH are described in
[native installation](CONFIGURATION.md#native-installation-and-pins).
Rovloom does not yet install them or configure model access. A running Gateway
or an accepted configuration does not establish a usable native provider.

## 4. Connect your AI Agent's MCP client

In a client supporting **Streamable HTTP**, enter:

| Setting | Template value |
|---|---|
| Transport | Streamable HTTP |
| URL | `http://127.0.0.1:9444/mcp` |
| Authorization header | `Bearer <EXISTING_MCP_BEARER>` |

Use the existing Bearer supplied for this exact endpoint and caller, stored in
the client's secret storage. The Gateway stores its digest and expiry in
program-managed identity state. Management proof and device credentials are different
credentials. MCP binds to loopback; remote clients need your administrator's
local/tunnel access arrangement. The CLI is not a stdio MCP server.

Let the client finish MCP initialization and load **all tool pages**. In its tool
runner, or by asking the Agent to perform these steps:

1. Use `machines_list`, then `providers_list` and `providers_get`, to choose an
   actual `machine_id` / `provider_id` and check the current `binding_revision`
   and readiness.
2. Obtain that provider's complete Target from your administrator: `machine_id`,
   `provider_id`, `profile` and, for a session profile, the exact `session`.
   `providers_list` / `providers_get` do not return `profile` or `session`; do not
   guess them or derive a session from the provider name. Check that the supplied
   device/provider IDs match your selection. Use this Target and the observed
   revision as `expected_binding_revision` for `runtime_discover`; follow every
   `next_cursor`.
3. Use `runtime_describe` for the selected native method. Use the returned
   `contract_ref`, parameter schema and validation requirements.
4. Use `runtime_call` once, preserving that full Target/revision/contract. Set
   `deadline` to a future absolute Unix time in milliseconds; `wait_ms` (0–5000)
   only controls the short frontend wait.
5. Save `call_id` and use `runtime_call_get` to observe it. Read the returned
   `result.result_id` with `runtime_result_read`, following its `next_cursor` to
   `eof` and honoring `encoding`. A timeout does not authorize resubmission.

Start with `workspace.list`, then `tab.list` / `pane.list`, using each provider's
described parameters. Luvus's generic methods such as `workspace.list` require
`validation:"raw-contract"` and explicit raw authorization. Herdr uses its own
schema and `validation:"strict"`. Do not copy IDs, revisions or hashes from another device.

## 5. Select an Agent and have a conversation

| Action | Luvus | Herdr |
|---|---|---|
| Select a window/pane | Keep observed `workspace_id`, `tab_id`, terminal pane ID | Keep native workspace/tab/pane IDs |
| Find/check an Agent | `agent.list`, `agent.get`, `agent.explain`, `agent.read` | Same method names, provider-specific parameters |
| Start an installed Agent if needed | `agent.start`: `name`, `kind`, observed `pane` | `agent.start`: `name`, `kind`, observed `pane_id` |
| Send text | `agent.prompt`: `target`, `text`, observed `terminal_id`, **`strict:true`** | `agent.prompt`: `target`, `text`; optional `wait` is an object |
| Check response | `agent.get`, `agent.wait`, `agent.read` | Same names; retain native status/authority information |

Use each method through `runtime_call` after describing it. Luvus `pane.list`,
`agent.prompt`, `agent.send`, `agent.wait`, `agent.keys` use strict validation;
other reviewed ordinary methods require raw authorization. The local
`allow_terminal_execution` switch defaults to false; strict text conversation
can remain available with it off. Custom argv/env and direct terminal input need
explicit local permission. The Agent must be available in the native runtime's controlled PATH and have model
access configured in its private HOME. The default PATH is `/usr/bin:/bin`.
An owner-selected Agent installation directory is supported by the existing
native integration, but the new user setup flow does not yet create that local
runtime configuration. Do not bypass `allow_terminal_execution:false` with
arbitrary argv/env. See [native installation](CONFIGURATION.md#native-installation-and-pins).

Send a harmless message with a unique phrase, read the actual reply, then ask
the same Agent to recall the phrase. Keep the same complete Target, generation,
pane/Agent, terminal ID and native Agent session when provided. `ready`, `queued`,
`submitted`, terminal echo or idle alone does not establish a model reply.
Herdr does not guarantee prompt completion or native cancellation. Report model
failures without automatically resending or switching models.

## 6. Stop and troubleshoot

Stop Connector with Ctrl-C and wait for exit, then stop Gateway with Ctrl-C.
Shutdown does not promise native rollback. Preserve data if shutdown fails.

Service install/uninstall/start/restart/stop remain unavailable in the product
CLI (`backend_unavailable`, 3). `service --help` documents their syntax;
installation enables boot startup and does not mean start now, while uninstall
removes boot startup and does not stop now. See the [complete CLI reference](CONFIGURATION.md#complete-cli-reference).
`update --check` checks official stable releases over the network; no published
release may produce `release_unavailable`. An operational replacement backend is
not connected.

| Problem | Next action |
|---|---|
| `pairing_required` / `configuration_required` | Gateway can wait locally, but fresh pairing/native setup is still a product gap. Address JSON alone cannot complete pairing. |
| Home/path/configuration/role error | Check process user, exact role file and absolute paths; use `--config` and configuration checks. Existing bad files are preserved. |
| Configuration unreadable/not protected | Check owner, private directory and file permissions; avoid links. Existing permissions are not silently repaired. |
| Listener failure | Check selected ports, address availability and data directory ownership. |
| HTTP 401 | Check exact `/mcp` URL, existing Bearer and expiry. An unpaired Gateway rejects every caller. |
| Offline / provider not ready | Check WS/WSS reachability, system TLS trust, pairing and native installation. |
| Permission/contract/revision error | Refresh provider/method descriptions and verify grants. |
| Agent executable missing | Verify the Agent is in the runtime's controlled PATH with model access in its private HOME; do not bypass the terminal switch. |
| Uncertain call / storage failure | Preserve original call and state; do not delete ledgers or blindly resend. |

Diagnostics use stderr. Role exit codes are 0 normal shutdown, 2 arguments,
configuration or setup required, 3 unavailable backend, 1 runtime/shutdown failure.
Share error codes when seeking help; keep secrets, real configuration and data private.
