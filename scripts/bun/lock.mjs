import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 用 Bun 解析器将文本锁文件读取为数据，不执行其中内容。
export function lockedDependencies() {
  const lock = Bun.JSON5.parse(readFileSync(new URL('../../bun.lock', import.meta.url), 'utf8'));
  return Object.fromEntries(Object.entries(lock.packages).map(([name, entry]) => {
    assert.equal(typeof entry[0], 'string');
    assert.equal(typeof entry[3], 'string');
    return [name, { version: entry[0].slice(entry[0].lastIndexOf('@') + 1), integrity: entry[3] }];
  }));
}
