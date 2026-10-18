import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { lockedDependencies } from '../bun/lock.mjs';
import { toolchain } from '../bun/toolchain.mjs';

export async function probeSdk() {
  const runtime = toolchain();
  const wire = [];
  class RecordingStdio extends StdioClientTransport {
    async start() {
      const onmessage = this.onmessage;
      this.onmessage = (message, extra) => { wire.push({ direction: 'server_to_client', message }); onmessage?.(message, extra); };
      return super.start();
    }
    async send(message) { wire.push({ direction: 'client_to_server', message }); return super.send(message); }
  }
  const transport = new RecordingStdio({ command: process.execPath,
    args: ['--no-env-file', fileURLToPath(new URL('./sdk-stdio-server.mjs', import.meta.url))],
    env: { PATH: process.env.PATH ?? '' }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', bytes => { stderr += bytes; });
  const client = new Client({ name: 'p0-sdk-client', version: '1.32.1' });
  try {
    await client.connect(transport, { timeout: 5000 });
    assert.deepEqual(await client.listTools({}, { timeout: 5000 }), { tools: [] });
    assert.deepEqual(await client.ping({ timeout: 5000 }), {});
  } finally { await client.close(); }
  const initialize = wire.find(r => r.message.method === 'initialize').message;
  const result = wire.find(r => r.message.id === initialize.id && r.message.result).message.result;
  assert.equal(result.protocolVersion, '2025-11-25');
  assert(wire.some(r => r.message.method === 'notifications/initialized'));
  assert.equal(stderr, '');
  const dependencies = lockedDependencies();
  for (const name of ['@modelcontextprotocol/sdk', 'ajv', 'ws']) {
    const installed = JSON.parse(readFileSync(new URL(`../../node_modules/${name}/package.json`, import.meta.url)));
    assert.equal(installed.version, dependencies[name].version, `${name}: installed version differs from lock`);
  }
  return { runtime,
    dependencies: Object.fromEntries(['@modelcontextprotocol/sdk', 'ajv', 'ws'].map(name => [name, dependencies[name]])),
    childRuntime: 'same verified Bun executable with --no-env-file',
    client: '@modelcontextprotocol/sdk Client over child-process stdio',
    sdk_latest_constant: LATEST_PROTOCOL_VERSION, sdk_supported_constants: SUPPORTED_PROTOCOL_VERSIONS,
    negotiated: result.protocolVersion, stderr, wire,
    scope: 'SDK compatibility probe only; no Gateway/UHP integration, commercial MCP Host, HTTP or OAuth claim' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await probeSdk();
  if (process.argv.includes('--write')) writeFileSync(new URL('../../docs/bun/sdk-compatibility.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
