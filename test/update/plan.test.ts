// 验证稳定版本选择、只读检查、固定平台命名与远端清单拒绝边界，不联网或改安装。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_BINARY_BYTES,
  UPDATE_MANIFEST,
  UpdateError,
  updateAssetName,
  updatePlatform
} from '../../src/update/contract.js'
import { checkForUpdate, parseUpdateManifest, validateDownloadPlan } from '../../src/update/plan.js'
import { compareVersions, stableVersion } from '../../src/update/version.js'
import { fixture } from './fixtures.js'

test(
  'SemVer comparison is strict, numeric and never orders build metadata',
  /* 核对正式、预发行与非法版本。 */ () => {
    for (const [a, b, result] of [
      ['1.10.0', '1.9.9', 1],
      ['1.0.0', '1.0.0-dev', 1],
      ['1.0.0+build', '1.0.0+other', 0],
      ['1.0.0-alpha.2', '1.0.0-alpha.10', -1],
      ['1.0.0-1', '1.0.0-a', -1],
      ['1.0.0-a', '1.0.0-a.1', -1],
      ['9007199254740993.0.0', '9007199254740992.0.0', 1]
    ] as const) {
      assert.equal(compareVersions(a, b), result)
    }
    for (const invalid of ['v1.0.0', '01.0.0', '1.0', '1.0.0-01', '../1.0.0', '1.0.0\n', '1'.repeat(129)]) {
      assert.throws(/* 非法当前版本不能参与更新判断。 */ () => compareVersions(invalid, '1.0.0'), {
        code: 'invalid_current_version'
      })
    }
    assert(stableVersion('1.0.0+build'))
    assert(!stableVersion('1.0.0-rc.1'))
  }
)

test(
  'check reads release and manifest only for every supported OS/arch tuple',
  /* 六个平台形状仅为模型测试。 */ async () => {
    for (const os of ['linux', 'darwin', 'windows'] as const) {
      for (const arch of ['x64', 'arm64'] as const) {
        const f = fixture({ os, arch })
        const plan = await checkForUpdate(f.network, '0.1.0-dev', { os, arch })
        assert.equal(plan.status, 'available')
        assert.equal(plan.asset.name, updateAssetName({ os, arch }))
        assert.equal(f.requests.length, 2)
        assert(f.requests[1]!.endsWith(UPDATE_MANIFEST))
        assert(Object.isFrozen(plan) && Object.isFrozen(plan.asset) && Object.isFrozen(plan.platform))
      }
    }
    assert.deepEqual(updatePlatform('win32', 'x64'), { os: 'windows', arch: 'x64' })
  }
)

test(
  'equal and newer current versions never authorize a download or downgrade',
  /* 无更新状态不下载 payload。 */ async () => {
    for (const [current, status] of [
      ['1.2.0', 'up_to_date'],
      ['2.0.0', 'newer_than_release']
    ] as const) {
      const f = fixture()
      const plan = await checkForUpdate(f.network, current, updatePlatform('linux', 'x64'))
      assert.equal(plan.status, status)
      assert.equal(f.requests.length, 2)
      assert.throws(/* 修改状态也不能授权降级。 */ () => validateDownloadPlan({ ...plan, status: 'available' }), {
        code: 'invalid_manifest'
      })
    }
  }
)

test(
  'unsupported runtime and malformed current version fail before network',
  /* 参数失败没有副作用。 */ async () => {
    const f = fixture()
    assert.throws(/* 不回退 x64 或另一 OS。 */ () => updatePlatform('freebsd', 'x64'), { code: 'unsupported_platform' })
    assert.throws(/* 不把未知 CPU 当 arm64。 */ () => updatePlatform('linux', 'ia32'), { code: 'unsupported_platform' })
    await assert.rejects(
      /* 当前版本必须由原 CLI 提供合法值。 */ () => checkForUpdate(f.network, 'dev', updatePlatform('linux', 'x64')),
      { code: 'invalid_current_version' }
    )
    assert.equal(f.requests.length, 0)
  }
)

test(
  'latest metadata rejects draft, prerelease, malformed tag, asset aliases and foreign URLs',
  /* 无稳定发行时不猜其它资产。 */ async () => {
    const mutations = [
      /* 草稿不能参与更新。 */ (f: ReturnType<typeof fixture>) => {
        f.release.draft = true
      },
      /* 预发行不能参与更新。 */ (f: ReturnType<typeof fixture>) => {
        f.release.prerelease = true
      },
      /* tag 必须是稳定 SemVer。 */ (f: ReturnType<typeof fixture>) => {
        f.release.tag_name = 'v1.2.0-rc.1'
      },
      /* tag 中不能放路径。 */ (f: ReturnType<typeof fixture>) => {
        f.release.tag_name = 'v../1.2.0'
      },
      /* 同名重复资产存在歧义。 */ (f: ReturnType<typeof fixture>) => {
        f.release.assets.push({ ...f.release.assets[0]! })
      },
      /* 其它仓库 URL 不可覆盖固定来源。 */ (f: ReturnType<typeof fixture>) => {
        f.release.assets[0]!.browser_download_url = 'https://github.com/other/repo/file'
      },
      /* 未上传完的资产不能消费。 */ (f: ReturnType<typeof fixture>) => {
        f.release.assets[0]!.state = 'new'
      },
      /* 二进制声明大小必须与清单一致。 */ (f: ReturnType<typeof fixture>) => {
        f.release.assets[1]!.size += 1
      }
    ]
    for (const mutate of mutations) {
      const f = fixture()
      mutate(f)
      await assert.rejects(
        /* 每类危险元数据都返回固定类别。 */ () => checkForUpdate(f.network, '1.0.0', updatePlatform('linux', 'x64')),
        { code: 'invalid_release' }
      )
    }
  }
)

test(
  'closed manifest schema rejects mismatches, URLs, duplicates and invalid byte/hash ranges',
  /* 清单所有可执行输入都由本地约束。 */ () => {
    const original = fixture().manifest
    const cases: unknown[] = [
      { ...original, schemaVersion: 2 },
      { ...original, repository: 'other/repo' },
      { ...original, tag: 'v1.2.1' },
      { ...original, version: '1.2.1' },
      { ...original, version: '1.2.0-rc.1' },
      { ...original, url: 'https://evil.invalid/binary' },
      { ...original, assets: [] },
      { ...original, assets: [original.assets[0], original.assets[0]] }
    ]
    for (const patch of [
      { size: 0 },
      { size: -1 },
      { size: 1.5 },
      { size: MAX_BINARY_BYTES + 1 },
      { size: '20' },
      { name: '../rovloom' },
      { name: 'rovloom-linux-arm64' },
      { os: 'win32' },
      { arch: 'ia32' },
      { sha256: 'a'.repeat(63) },
      { sha256: 'A'.repeat(64) },
      { sha256: 'g'.repeat(64) },
      { url: 'https://evil.invalid' }
    ]) {
      cases.push({ ...original, assets: [{ ...original.assets[0], ...patch }] })
    }
    for (const value of cases) {
      assert.throws(/* 逐项拒绝而非宽松补全。 */ () => parseUpdateManifest(value, original.tag), {
        code: 'invalid_manifest'
      })
    }
    assert.equal(
      parseUpdateManifest({ ...original, assets: [{ ...original.assets[0], size: MAX_BINARY_BYTES }] }, original.tag)
        .assets[0]!.size,
      MAX_BINARY_BYTES
    )
  }
)

test(
  'missing current-platform asset fails without fallback to older release or another arch',
  /* 匹配失败不能尝试旧发行。 */ async () => {
    const f = fixture()
    await assert.rejects(
      /* arm64 资产缺失时不能拿 x64。 */ () => checkForUpdate(f.network, '1.0.0', updatePlatform('linux', 'arm64')),
      { code: 'unsupported_platform' }
    )
    assert.equal(f.requests.length, 2)
    assert(new UpdateError('invalid_release') instanceof Error)
  }
)
