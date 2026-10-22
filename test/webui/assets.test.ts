/** 验证宿主静态资产只读白名单；临时假文件仅用于加载边界，绝不进入生产dist。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadManagementAssets } from '../../src/admin/assets.js'
import { createManagementReadHandler } from '../../src/admin/read-http.js'

/** 创建最小隔离文件树，不从用户目录或生产数据取样。 */
function files() {
  const directory = mkdtempSync(join(tmpdir(), 'rovloom-admin-assets-'))
  for (const name of [
    'index.html',
    'browser.js',
    'theme.js',
    'manage.css',
    'rovloom-mark-transparent.png',
    'rovloom-logo.png',
    'chunk-abc123.js',
    'browser.js.map',
    'fixture.js'
  ]) {
    writeFileSync(join(directory, name), 'ISOLATED_ASSET_TEST_ONLY')
  }
  return directory
}

test(
  '固定资产加载忽略fixture和source map，并把缓冲区与handler隔离',
  /** 静态壳不含管理数据，API即使同源仍需认证。 */ async () => {
    const directory = files()
    const origin = 'http://127.0.0.1:12345'
    try {
      const assets = loadManagementAssets(directory)
      assert.equal(assets.size, 7)
      assert(!assets.has('/browser.js.map'))
      assert(!assets.has('/fixture.js'))
      const handler = createManagementReadHandler({
        origin,
        assets,
        service: {
          execute: /* 未认证时绝不进入业务服务。 */ async () => {
            throw new Error('must not execute')
          }
        },
        authenticate: /* 静态壳不代替真实登录。 */ async () => null
      })
      try {
        assets.get('/')!.fill(0)
        const shell = await handler.fetch(new Request(origin + '/', { headers: { host: '127.0.0.1:12345' } }))
        assert.equal(await shell.text(), 'ISOLATED_ASSET_TEST_ONLY')
        const api = await handler.fetch(
          new Request(origin + '/admin/v1/status', { headers: { host: '127.0.0.1:12345' } })
        )
        assert.equal(api.status, 401)
        const map = await handler.fetch(
          new Request(origin + '/browser.js.map', { headers: { host: '127.0.0.1:12345' } })
        )
        assert.equal(map.status, 404)
      } finally {
        handler.stop()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

test(
  '缺失核心资产 超限文件和符号链接均不能被宿主加载',
  /** 资产目录只能是明确的有界普通构建文件。 */ () => {
    const directory = files()
    try {
      rmSync(join(directory, 'theme.js'))
      assert.throws(
        /** 首屏脚本是必需资源，不能交付回退系统主题的缺包页面。 */
        () => loadManagementAssets(directory),
        /management_assets_missing/u
      )
      writeFileSync(join(directory, 'theme.js'), 'ISOLATED_ASSET_TEST_ONLY')
      rmSync(join(directory, 'browser.js'))
      assert.throws(
        /* 缺少入口不能交付不完整页面。 */ () => loadManagementAssets(directory),
        /management_assets_missing/u
      )
      writeFileSync(join(directory, 'browser.js'), 'x'.repeat(1_048_577))
      assert.throws(/* 超过单文件预算直接失败。 */ () => loadManagementAssets(directory), /management_assets_invalid/u)
      rmSync(join(directory, 'browser.js'))
      symlinkSync(join(directory, 'manage.css'), join(directory, 'browser.js'))
      assert.throws(
        /* 不能让固定文件名变成磁盘路径旁路。 */ () => loadManagementAssets(directory),
        /management_assets_invalid/u
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
