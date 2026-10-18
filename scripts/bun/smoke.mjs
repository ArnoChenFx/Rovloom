import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolchain } from './toolchain.mjs';

toolchain();
// 必须导入构建后的 JavaScript，不能回到源码 .ts。
const contracts = await import('../../dist/src/contracts.js');
const { Store } = await import('../../dist/src/store.js');
const { Router } = await import('../../dist/src/router.js');
const protocol = await import('../../dist/src/protocol.js');
assert.deepEqual(Object.keys(contracts).sort(),
  ['GatewayError', 'authorize', 'canonical', 'digest', 'validateRequest', 'validateTarget'].sort());
assert.deepEqual(Object.keys(protocol).sort(),
  ['MAX_FRAME_BYTES', 'PROTOCOL_MAJOR', 'PROTOCOL_MINOR', 'decodeFrame', 'encodeFrame'].sort());
assert.equal(typeof Router, 'function');
const dir = mkdtempSync(join(tmpdir(), 'luvus-bun-artifact-'));
try {
  const store = new Store(join(dir, 'db'));
  const machine = store.register('artifact');
  assert.equal(store.machine(machine.machine_id).name, 'artifact');
  // 共享 chunk 必须保留不同构建入口之间的类身份。
  assert.throws(() => store.machine('missing'), contracts.GatewayError);
  store.close();
  const reopened = new Store(join(dir, 'db'));
  assert.equal(reopened.machine(machine.machine_id).name, 'artifact');
  reopened.close();
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('Built ESM exports, shared error class and real SQLite reopen: pass');
