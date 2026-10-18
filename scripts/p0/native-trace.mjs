import assert from 'node:assert/strict';

// 从原始 request/response 与进程记录重建最小门禁，不把 assertions.json 的自报当证据。
export function verifyNativeTrace(transcript, environment, artifacts) {
  const processRows = transcript.filter((r) => r.kind === 'process');
  const one = (label) => {
    const rows = processRows.filter((r) => r.label === label);
    assert.equal(rows.length, 1, `process evidence missing/duplicated: ${label}`);
    return rows[0];
  };
  const received = (channel) =>
    transcript
      .filter((r) => r.kind === 'receive' && r.channel === channel)
      .map((r) => JSON.parse(r.wire));
  const result = (channel) => {
    const rows = received(channel).filter((r) => r.id === channel);
    assert.equal(rows.length, 1, `response evidence missing/duplicated: ${channel}`);
    return rows[0].result;
  };
  const errorCode = (channel, code) =>
    assert.equal(received(channel)[0]?.error?.code, code, channel);
  const noRunning = (label) =>
    assert(
      JSON.parse(one(label).stdout).sessions.every((s) => !s.running),
      label,
    );
  const session = environment.session;
  assert.equal(session, 'p0-issue3');
  assert.equal(
    environment.binary_sha256,
    '895073022da8edd231c9d4c810d68627b954b61e4e9f9f2d5d19e2c2fcf282a9',
  );
  assert.equal(environment.child_environment.LUVUS_HOME, '/fixture/issue3/state');
  assert.equal(environment.child_environment.HOME, '/fixture/issue3/child-home');
  const failures = new Set([
    'session-rpc-before-server',
    'proxy-no-final-lf',
    'proxy-malformed-json',
    'proxy-unknown-method',
    'native-wait-timeout',
  ]);
  for (const row of processRows) {
    assert.deepEqual(row.argv.slice(0, 3), ['/fixture/bin/luvus', '--session', session]);
    assert.equal(typeof row.stdout === 'string' || row.stdout_file === 'schema-bundle.json', true);
    assert.equal(typeof row.stderr, 'string');
    if (row.label === 'client-deadline') {
      assert.equal(row.timed_out, true);
      assert.equal(row.exit_code, -15);
      assert.equal(row.stdout, '');
    } else {
      assert.equal(row.timed_out, false, row.label);
      assert.equal(row.exit_code, failures.has(row.label) ? 1 : 0, row.label);
    }
  }
  assert.equal(one('binary-version').stdout, 'luvus 0.14.3\n');
  assert.match(one('server-status').stdout, /version\s+v0\.14\.3/);
  for (const label of ['discovery-before-host', 'discovery-after-host', 'discovery-after-cleanup'])
    noRunning(label);
  for (const label of ['session-rpc-before-server', 'proxy-no-final-lf', 'proxy-malformed-json']) {
    assert.equal(one(label).stdout, '');
    assert(one(label).stderr.length > 0, label);
  }
  assert.match(one('proxy-no-final-lf').stderr, /missing LF/);
  const host = JSON.parse(one('host-capabilities-before-server').stdout);
  const capabilities = JSON.parse(one('session-capabilities').stdout);
  assert.deepEqual(host, artifacts.host);
  assert.deepEqual(capabilities, artifacts.session);
  assert.equal(host.result.profile, 'host');
  const protocol = { major: 1, minor: 0, name: 'luvus-uhp' };
  assert.deepEqual(host.result.protocol, protocol);
  assert.deepEqual(capabilities.result.protocol, protocol);
  assert.equal(capabilities.result.session, session);
  assert.equal(JSON.parse(one('host-info-before-server').stdout).result.version, '0.14.3');
  assert(
    JSON.parse(one('host-session-list-before-server').stdout).result.sessions.every(
      (s) => !s.running,
    ),
  );
  const ping = one('proxy-ping');
  assert.equal(ping.stdout.split('\n').length, 2);
  assert.equal(ping.stderr, '');
  assert.equal(result('direct-ping').version, '0.14.3');
  assert(transcript.some((r) => r.kind === 'eof' && r.channel === 'direct-ping'));
  assert.equal(JSON.parse(one('proxy-two-requests').stdout).id, 'first');
  assert.equal(JSON.parse(one('proxy-unknown-method').stdout).error.code, 'invalid_request');
  assert.equal(JSON.parse(one('native-wait-timeout').stdout).error.code, 'timeout');

  const started = transcript.filter((r) => r.kind === 'server_start');
  assert.equal(started.length, 1);
  assert.deepEqual(started[0].argv, ['/fixture/bin/luvus', '--session', session, 'server']);
  const running = processRows
    .filter((r) => r.label === 'discovery-startup')
    .flatMap((r) => JSON.parse(r.stdout).sessions)
    .filter((s) => s.name === session && s.running);
  assert(running.length > 0, 'running endpoint was not discovered');
  const endpoint = running.at(-1).endpoint;
  assert.equal(endpoint.transport, 'unix_socket');
  assert(endpoint.address.startsWith('/fixture/issue3/state/'));
  let validation;
  let peer;
  let socketIdentity;
  let connections = 0;
  for (const row of transcript) {
    if (row.kind === 'endpoint_validation') {
      validation = row;
      const socket = row.components.at(-1);
      assert.equal(socket.path, endpoint.address);
      assert.equal(socket.uid, environment.uid);
      assert.equal(socket.mode, '0o600');
      assert(
        row.components.some(
          (c) =>
            c.path === '/fixture/issue3/state' && c.uid === environment.uid && c.mode === '0o700',
        ),
      );
      for (const component of row.components.slice(0, -1)) {
        assert.equal(Number.parseInt(component.mode.slice(2), 8) & 0o022, 0);
        if (component.path.startsWith('/fixture/issue3')) {
          assert.equal(component.uid, environment.uid);
          assert.equal(component.mode, '0o700');
        }
      }
      assert.equal(row.identity.length, 3);
      if (socketIdentity) assert.deepEqual(row.identity, socketIdentity);
      socketIdentity = row.identity;
    }
    if (row.kind === 'peer_credentials') {
      assert(validation, 'peer must follow endpoint validation');
      assert.equal(row.uid, environment.uid, 'peer uid');
      assert.equal(row.pid, started[0].pid, 'peer server pid');
      peer = row;
      validation = undefined;
      connections++;
    }
    if (row.kind === 'send' && JSON.parse(row.wire).method) {
      assert.equal(peer?.channel, row.channel, 'request needs its own validated connection');
      peer = undefined;
    }
  }
  assert(connections > 0);
  const identity = artifacts.identity;
  const created = result('terminal-create');
  for (const key of ['server_generation', 'terminal_id', 'pane_id'])
    assert.equal(created[key], identity[key]);
  assert.equal(identity.server_generation, capabilities.result.server_generation);
  assert.equal(created.dispatch, 'executed');
  assert.equal(created.restore, false);
  assert.deepEqual(result('terminal-inventory'), artifacts.inventory);
  assert(
    artifacts.inventory.terminals.some((t) => t.terminal_id === identity.terminal_id && !t.restore),
  );
  const before = result('snapshot-before-create');
  const after = result('snapshot-after-create');
  assert.equal(after.server_generation, identity.server_generation);
  const matchingEvent = (channel, event) =>
    received(channel).find((r) => r.event === event && r.data.terminal_id === identity.terminal_id);
  const createdEvent = matchingEvent('events-primary', 'terminal.created');
  assert(
    before.event_sequence < createdEvent.sequence && createdEvent.sequence <= after.event_sequence,
  );
  assert.deepEqual(matchingEvent('events-independent', 'terminal.created'), createdEvent);
  assert(
    after.workspaces.some((w) =>
      w.tabs.some((t) => t.panes.some((p) => p.terminal_id === identity.terminal_id)),
    ),
  );
  const eventChannels = new Map();
  for (const row of transcript.filter((r) => r.kind === 'receive')) {
    const event = JSON.parse(row.wire);
    if (!event.event) continue;
    const previous = eventChannels.get(row.channel) ?? 0;
    assert(event.sequence > previous, 'native event sequence must increase within each channel');
    eventChannels.set(row.channel, event.sequence);
  }
  errorCode('control-stale-generation', 'stale_server');
  errorCode('control-wrong-terminal', 'stale_terminal');
  if (received('control-wrong-pane').length) errorCode('control-wrong-pane', 'stale_route');
  errorCode('control-lease-conflict', 'control_conflict');
  assert.equal(result('terminal-control').mode, 'control');
  assert.equal(result('terminal-observe').mode, 'observe');
  for (const channel of ['terminal-control', 'terminal-observe']) {
    for (const key of ['server_generation', 'terminal_id', 'pane_id'])
      assert.equal(result(channel)[key], identity[key]);
  }
  assert.equal(
    received('terminal-control').find((r) => r.id === 'input-1')?.result.dispatch,
    'queued',
  );
  assert(
    received('terminal-observe').some((r) => r.data?.text?.includes('CONSUMED:321cba-tupni-0p')),
  );
  assert.equal(
    received('terminal-control').find((r) => r.id === 'input-invalid')?.error.code,
    'invalid_params',
  );
  assert(transcript.some((r) => r.kind === 'client_close' && r.channel === 'terminal-control'));
  assert(
    transcript
      .filter((r) => r.kind === 'receive' && r.channel.startsWith('control-reacquire-'))
      .some((r) => JSON.parse(r.wire).result?.mode === 'control'),
  );
  for (const channel of ['validate-after-stream-close', 'validate-after-deadline'])
    assert.equal(result(channel).state, 'alive');
  assert.equal(result('terminal-close').dispatch, 'executed');
  const closed = matchingEvent('events-primary', 'terminal.closed');
  assert(closed.sequence > after.event_sequence);
  const replayRequest = JSON.parse(
    transcript.find((r) => r.kind === 'send' && r.channel === 'events-replay').wire,
  );
  assert.equal(replayRequest.params.after_sequence, after.event_sequence);
  assert.deepEqual(matchingEvent('events-replay', 'terminal.closed'), closed);
  assert.equal(result('validate-after-terminal-close').state, 'gone');
  errorCode('input-after-close', 'stale_terminal');
  assert(transcript.some((r) => r.kind === 'eof' && r.channel === 'terminal-observe'));
  const exits = transcript.filter((r) => r.kind === 'server_exit');
  assert.equal(exits.length, 1);
  assert.equal(exits[0].exit_code, 0);
  assert.equal(
    transcript.some((r) => r.kind === 'collection_failure'),
    false,
  );
  if (typeof environment.cleanup === 'object') {
    assert.deepEqual(environment.cleanup, {
      server_stopped: true,
      no_running_sessions: true,
      temporary_root_removed: true,
      errors: [],
    });
    assert.deepEqual(
      transcript.find((r) => r.kind === 'cleanup'),
      { kind: 'cleanup', ...environment.cleanup },
    );
  }
  return { connections, event_channels: eventChannels.size, lifecycle_reconstructed: true };
}
