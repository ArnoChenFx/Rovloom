/** 验证真实编译产物在隔离目录运行，明确区分设施探针与尚未接线的产品候选。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { buildStandalone, sha256 } from '../../scripts/release/build.mjs'
import { smokeStandalone } from '../../scripts/release/smoke.mjs'

test(
  'single executable embeds Worker, controlled helper, management assets and SQLite without external Bun',
  { timeout: 60_000 },
  /** 本机实际运行 binary 并核对原资源字节，不能从 checkout 补包。 */ async () => {
    const incomplete = await buildStandalone({ entrypoint: 'test/release/probe.mjs', probe: true })
    assert.throws(
      /* 故意漏掉 Worker 后隔离启动必须失败，不能从工作目录找到源码。 */ () =>
        smokeStandalone(incomplete.binary, [{ args: [], code: 0 }]),
      /ModuleNotFound/u
    )
    const output = await buildStandalone({
      entrypoint: 'test/release/probe.mjs',
      workers: ['test/release/probe-worker.mjs'],
      probe: true
    })
    const [result] = smokeStandalone(output.binary, [{ args: [], code: 0, stderr: /^$/u }])
    const report = JSON.parse(result.stdout)
    assert.equal(report.scope, 'packaging-probe')
    assert.equal(report.helper, 'embedded-worker-helper')
    assert.equal(report.sqlite, 'pass')
    const paths = new Map(
      report.assets.map(/* 将探针实际读到的嵌入资源映射到摘要以逐项比对。 */ (asset) => [asset.path, asset.sha256])
    )
    for (const name of ['index.html', 'browser.js', 'manage.css', 'rovloom-mark-orange.png', 'rovloom-logo.png']) {
      assert.equal(
        paths.get(name === 'index.html' ? '/' : '/' + name),
        sha256(readFileSync(`${output.directory}/webui/${name}`))
      )
    }
    assert.equal(
      paths.get('/rovloom-mark-orange.png'),
      sha256(readFileSync('docs/assets/brand/rovloom-mark-orange.png'))
    )
    const ico = readFileSync(`${output.directory}/rovloom.ico`)
    assert.equal(ico.readUInt16LE(4), 1)
    assert.deepEqual(ico.subarray(22), readFileSync('docs/assets/brand/rovloom-mark-orange.png'))
    assert.equal(output.manifest.runtimeAcceptance, 'pending')
    assert.equal(output.manifest.productWiring, 'pending')
  }
)

test(
  'missing product/Worker inputs fail explicitly, and Windows icon cannot be accepted by Linux cross build',
  /** 输入缺失必须失败，不能临时生成替代 CLI 或忽略附加 Worker。 */ async () => {
    await assert.rejects(buildStandalone({ entrypoint: 'src/missing-product-cli.ts' }), /Missing standalone input/u)
    await assert.rejects(
      buildStandalone({ entrypoint: 'test/release/probe.mjs', workers: ['src/missing-worker.ts'] }),
      /Missing standalone input/u
    )
    if (process.platform !== 'win32') {
      await assert.rejects(
        buildStandalone({ entrypoint: 'test/release/probe.mjs', target: 'bun-windows-x64' }),
        /native Windows build/u
      )
    }
  }
)
