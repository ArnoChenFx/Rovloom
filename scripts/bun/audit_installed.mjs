import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const lock = Bun.JSON5.parse(readFileSync(new URL('bun.lock', root), 'utf8'));
const installed = [],
  otherPlatforms = [];
for (const [key, entry] of Object.entries(lock.packages)) {
  // 锁文件的嵌套包路径需还原 node_modules，保留 scoped 包的两个路径段。
  const parts = key.split('/'),
    path = [];
  while (parts.length) {
    const name = parts.shift();
    path.push('node_modules', name);
    if (name.startsWith('@')) path.push(parts.shift());
  }
  const manifest = new URL(path.join('/') + '/package.json', root);
  const version = entry[0].slice(entry[0].lastIndexOf('@') + 1);
  if (existsSync(manifest)) {
    const actual = JSON.parse(readFileSync(manifest));
    assert.equal(actual.version, version, `${key}: installed version differs from lock`);
    installed.push({ package: key, version });
  } else {
    const options = entry[2];
    const incompatible =
      (options.os && options.os !== process.platform) ||
      (options.cpu && options.cpu !== process.arch);
    assert(incompatible, `${key}: missing current-platform dependency`);
    otherPlatforms.push({ package: key, version, os: options.os, cpu: options.cpu });
  }
}
console.log(
  JSON.stringify(
    {
      locked: Object.keys(lock.packages).length,
      installedCount: installed.length,
      otherPlatformsCount: otherPlatforms.length,
      installed,
      otherPlatforms,
    },
    null,
    2,
  ),
);
