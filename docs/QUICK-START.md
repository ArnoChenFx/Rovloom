# Rovloom Quick Start

**English** · [简体中文](QUICK-START-zh.md) · [Configuration reference](CONFIGURATION.md)

Use one **Gateway** as the MCP entry point and one outbound **Connector** on each
device running Luvus or Herdr. They can share a machine, with separate state directories.

## 1. Install the product and prepare access

This preview currently requires **Linux x64** for Gateway/Connector runtime use.
There is no published Rovloom installation package yet. Obtain an approved
standalone executable and the matching configuration from your administrator;
place the executable at a private, executable location such as
`/absolute/protected/rovloom/bin/rovloom`. In the commands below, `rovloom` means
that executable on your PATH, or substitute its absolute path. Check it with:

```sh
rovloom --version
rovloom --help
```

On each runtime device, install the approved **Luvus 0.14.3** or **Herdr 0.9.5**
and the Agent you intend to use. Exact binary/schema requirements and the Agent's
controlled PATH are in [native installation](CONFIGURATION.md#native-installation-and-pins).
Rovloom does not install the native programs or configure their model access.

Before starting, obtain the Gateway address, CA, already paired device credential,
provider configuration and an existing MCP Bearer from your administrator.
Fresh-device setup is not yet available as a complete user flow. If these are
missing, configuration templates alone will not produce a working connection.

## 2. Configure Gateway and Connector

Default files belong to the **user running the role**:

| Role | Default file | Main settings |
|---|---|---|
| Gateway | `~/.config/rovloom/gateway.json` | `state_dir`, loopback `mcp_hostname`, `mcp_port`, `authentication_ref` |
| Connector | `~/.config/rovloom/connector.json` | Separate `state_dir`, `gateway_url`, `provider_config_refs` |

`~` denotes the current user's home. Windows uses the same home-relative layout,
but current protected runtime loading requires Linux; there is no AppData/XDG
override. No working-directory search or cross-role fallback occurs.
`--config /absolute/path.json` overrides the default. All configured paths must
be normalized absolute paths: JSON does not expand `~`, environment variables or
paths relative to the configuration file.

Use the [complete minimal configurations and parameter tables](CONFIGURATION.md).
Each role also needs `state_dir/runtime.json` and its administrator-supplied
`state_dir/refs/` files. The role directory and state directories are private
`0700`; files are `0600` and owned by the role user. Keep Gateway and Connector
state separate. Empty provider lists are templates, not a ready-to-start Connector.

To view non-secret templates or check your saved files:

```sh
rovloom config template gateway
rovloom config template connector
rovloom config template runtime gateway
rovloom config template runtime connector
rovloom config check --config /absolute/protected/gateway.json
rovloom config check-runtime --config /absolute/protected/gateway.json
```

Use your actual role-file path; run the same checks for Connector. `config_valid`
and `runtime_config_valid` confirm structure only, not pairing, credentials or
Agent readiness. Templates do not change existing files.

## 3. Start and connect

On the Gateway machine and the runtime device, respectively:

```sh
rovloom gateway
rovloom connector
```

Keep both foreground processes running. With custom file locations use
`rovloom gateway --config /absolute/protected/gateway.json` and
`rovloom connector --config /absolute/protected/connector.json`.

The template MCP endpoint is `http://127.0.0.1:9444/mcp`. The separate template
device listener uses TLS on loopback port 9443. To connect another device, configure
its reachable WSS listener and matching certificate/CA explicitly. Connector's
`gateway_url` is an origin such as `wss://gateway.example:9443`, without credentials
or an endpoint path; the product chooses `/connector`.

If your administrator enabled the optional management page, open
`http://127.0.0.1:<management-port>/` on the Gateway. There is no default management
port. Use the supplied principal ID and independent management proof in the
browser login prompt; an MCP Bearer is not a management login. Check the selected
device's connection and provider readiness. Pairing progress is checked manually;
pending does not mean credentials have been issued. With permission, the page
can disable a selected provider; re-enabling is currently unavailable. After a
management session expires, refresh and authenticate again; refresh does not
extend the upstream login expiry. A pending registration still needs completed
pairing before Connector can connect.

## 4. Connect your AI Agent's MCP client

In a client supporting **Streamable HTTP**, enter:

| Setting | Template value |
|---|---|
| Transport | Streamable HTTP |
| URL | `http://127.0.0.1:9444/mcp` |
| Authorization header | `Bearer <EXISTING_MCP_BEARER>` |

Use the existing Bearer supplied for this exact endpoint and caller, stored in
the client's secret storage. The Gateway stores its digest and expiry through
`authentication_ref`. Management proof and device credentials are different
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
explicit local permission. Both native runtimes use `PATH=/usr/bin:/bin` and
private HOME/XDG locations. An Agent installed only in your login shell may not
be found. Ask your administrator to verify official Agent availability and its
private HOME configuration. There is no user-configurable Agent path in this
version; do not modify system permissions or bypass it with custom argv/env.

Send a harmless message with a unique phrase, read the actual reply, then ask
the same Agent to recall the phrase. Keep the same complete Target, generation,
pane/Agent, terminal ID and native Agent session when provided. `ready`, `queued`,
`submitted`, terminal echo or idle alone does not establish a model reply.
Herdr does not guarantee prompt completion or native cancellation. Report model
failures without automatically resending or switching models.

## 6. Stop and troubleshoot

Stop Connector with Ctrl-C, wait for exit, then stop Gateway with Ctrl-C.
Disconnecting the MCP client leaves Gateway running. Shutdown does not promise
native rollback. Preserve state and ownership records if shutdown fails.

Use foreground roles in this preview: service install/uninstall/start/restart/stop
are unavailable in the product CLI (`backend_unavailable`), even though
`service --help` exists. `update --check` checks official stable releases and
requires network; with no published release it may return `release_unavailable`.
`update` does not currently provide an operational replacement/upgrade flow.

| Problem | Next action |
|---|---|
| Configuration missing / home unavailable | Check user and role filename; supply an absolute `--config`. |
| Invalid path/configuration/role | Remove unknown fields, normalize absolute paths, match role and references; run configuration checks. |
| Configuration unreadable/not protected | Correct ownership, 0700 directories and 0600 files; avoid symlinks and hard-linked runtime files. |
| Startup unavailable/failed | Check supplied refs, TLS/CA, paired credential, provider installation and state. |
| HTTP 401 | Check exact `/mcp` URL, existing Bearer and expiry; management proof is separate. |
| Device offline / provider not ready | Check WSS reachability, TLS name/CA, pairing and native binary/schema match. |
| Permission/contract/revision error | Refresh provider and method descriptions; ask the administrator to check grants. |
| Agent executable missing | Check controlled PATH and private HOME configuration; custom args/env are not a PATH workaround. |
| Uncertain call / storage error | Keep the original call and state; ask the administrator to recover it, without deleting ledgers or resending blindly. |

Diagnostics use stderr. Role exit codes: 0 success/normal shutdown, 2 arguments or
configuration, 3 unavailable backend, 1 runtime/shutdown failure. Share error codes
when seeking help; keep credentials, real configuration, databases and runtime output private.
