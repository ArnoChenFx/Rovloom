import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const badSource = 'export const reviewProduct=(value: number)=>value == 1;\n';

function write(project, path, content) {
  const destination = join(project, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function hashes(root) {
  const result = {};
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else
        result[relative(root, path)] = createHash('sha256')
          .update(readFileSync(path))
          .digest('hex');
    }
  }
  walk(root);
  return result;
}

function isolated(check) {
  const project = mkdtempSync(join(tmpdir(), 'rovloom-quality-coverage-'));
  try {
    for (const name of [
      'package.json',
      'bunfig.toml',
      '.gitignore',
      '.oxlintrc.json',
      '.oxfmtrc.json',
    ]) {
      cpSync(join(repo, name), join(project, name));
    }
    symlinkSync(join(repo, 'node_modules'), join(project, 'node_modules'), 'dir');
    for (const name of ['src', 'test', 'scripts']) mkdirSync(join(project, name));
    write(project, 'src/product.ts', 'export const product = true;\n');
    write(project, 'tsconfig.json', '{}\n');
    return check(project);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function run(project, args, expected = 0) {
  const result = spawnSync(process.execPath, ['--no-env-file', ...args], {
    cwd: project,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, expected, `${args.join(' ')}\n${output}`);
  return output;
}

function rejectsProduct(project, paths) {
  const before = Object.fromEntries(paths.map((path) => [path, readFileSync(join(project, path))]));
  const lint = run(project, ['run', 'lint'], 1);
  assert.match(lint, /eqeqeq/);
  const format = run(project, ['run', 'format:check'], 1);
  for (const path of paths) {
    assert(lint.includes(path), `lint omitted ${path}: ${lint}`);
    assert(format.includes(path), `format:check omitted ${path}: ${format}`);
    assert.deepEqual(readFileSync(join(project, path)), before[path], `check changed ${path}`);
  }
}

test('product code in schema/evidence and other data-like paths is checked', () => {
  isolated((project) => {
    const paths = [
      'src/schema/review-product.ts',
      'src/evidence/review-product.ts',
      'src/review-product.schema.ts',
      ...[
        'schemas',
        'fixtures',
        '__fixtures__',
        '__snapshots__',
        'golden',
        'goldens',
        'archive',
        'archives',
        'third-party',
        'third_party',
        'vendor',
        'docs',
        'coverage',
      ].map((name) => `src/${name}/review-product.ts`),
      'src/LICENSE-product.ts',
      'src/COPYING-product.ts',
    ];
    for (const path of paths) write(project, path, badSource);
    rejectsProduct(project, paths);
  });
});

test('moving identical bytes from fixtures into src activates both checks', () => {
  isolated((project) => {
    const fixture = 'fixtures/quality/moved-product.schema.ts';
    const product = 'src/fixtures/moved-product.schema.ts';
    write(project, fixture, badSource);
    run(project, ['run', 'lint']);
    run(project, ['run', 'format:check']);
    assert.equal(readFileSync(join(project, fixture), 'utf8'), badSource);
    mkdirSync(dirname(join(project, product)), { recursive: true });
    renameSync(join(project, fixture), join(project, product));
    rejectsProduct(project, [product]);
  });
});

test('whole-checkout formatting preserves real fixture, schema, archive and license bytes', () => {
  const source = join(repo, 'fixtures');
  const beforeSource = hashes(source);
  isolated((project) => {
    cpSync(source, join(project, 'fixtures'), { recursive: true });
    const example = 'test/wire/v2-examples.json';
    write(project, example, readFileSync(join(repo, example)));
    const before = hashes(join(project, 'fixtures'));
    assert.deepEqual(before, beforeSource);
    const exampleBefore = readFileSync(join(project, example));
    run(project, ['node_modules/oxfmt/bin/oxfmt', '--config', '.oxfmtrc.json', '--write', '.']);
    assert.deepEqual(hashes(join(project, 'fixtures')), before);
    assert.deepEqual(readFileSync(join(project, example)), exampleBefore);
    assert(existsSync(join(project, 'fixtures/p0/LICENSE.luvus')));
  });
  assert.deepEqual(hashes(source), beforeSource);
});
