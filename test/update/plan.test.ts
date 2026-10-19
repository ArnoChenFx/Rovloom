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
import { assetName, validateReleaseManifest, versionFromTag } from '../../src/release/contract.js'

test(
  'shared release contract accepts publisher prereleases while default update rejects them',
  /* 同一语法服务发布和更新策略。 */ () => {
    const stable = fixture().manifest
    assert.equal(versionFromTag('v1.2.0-rc.1'), '1.2.0-rc.1')
    const platform = updatePlatform('linux', 'x64', 'glibc')
    const prerelease = {
      ...stable,
      tag: 'v1.2.0-rc.1',
      version: '1.2.0-rc.1',
      assets: [{ ...stable.assets[0], name: assetName('1.2.0-rc.1', platform) }]
    }
    assert.equal(validateReleaseManifest(prerelease, prerelease.tag).version, prerelease.version)
    assert.throws(
      /* 默认 update 不因发布端支持预发行而放行。 */ () => parseUpdateManifest(prerelease, prerelease.tag),
      { code: 'invalid_manifest' }
    )
  }
)

test(
  'tag commit mismatch, unknown object types and annotation cycles fail before binary download',
  /* 真实提交身份来自固定 tag 元数据查询。 */ async () => {
    for (const kind of ['mismatch', 'unknown', 'cycle', 'malformed']) {
      const f = fixture()
      if (kind === 'mismatch') {
        f.tagRef.object.sha = 'b'.repeat(40)
      }
      if (kind === 'unknown') {
        f.tagRef.object.type = 'tree'
      }
      if (kind === 'malformed') {
        f.tagRef.object.sha = 'short'
      }
      if (kind === 'cycle') {
        f.tagRef.object.type = 'tag'
        f.tagObjects.set(f.tagRef.object.sha, { object: f.tagRef.object })
      }
      await assert.rejects(
        /* 有界解引用只允许最终提交与 manifest.commit 一致。 */ () =>
          checkForUpdate(f.network, '1.0.0', updatePlatform('linux', 'x64', 'glibc')),
        { code: kind === 'mismatch' ? 'invalid_manifest' : 'invalid_release' }
      )
      assert(f.requests.length <= 7)
      assert(!f.requests.some(/* 检查失败时不能下载二进制。 */ (url) => url.endsWith(f.name)))
    }
    const f = fixture()
    f.tagRef.object.type = 'tag'
    f.tagObjects.set(f.tagRef.object.sha, { object: { type: 'commit', sha: f.manifest.commit } })
    assert.equal(
      (await checkForUpdate(f.network, '1.0.0', updatePlatform('linux', 'x64', 'glibc'))).commit,
      f.manifest.commit
    )
  }
)

test(
  'Linux requires positive glibc proof and manifest enforces commit, Bun and libc fields',
  /* 不以 linux 名称猜测 libc。 */ () => {
    for (const libc of [undefined, null, 'musl', 'unknown']) {
      assert.throws(/* musl 和未知都不能接收 glibc 资产。 */ () => updatePlatform('linux', 'x64', libc), {
        code: 'unsupported_platform'
      })
    }
    const original = fixture().manifest
    for (const patch of [{ commit: 'short' }, { commit: 'A'.repeat(40) }, { bun: '1.4.2' }]) {
      assert.throws(/* 新字段不能被忽略。 */ () => parseUpdateManifest({ ...original, ...patch }, original.tag), {
        code: 'invalid_manifest'
      })
    }
    for (const libc of [null, undefined, 'musl']) {
      assert.throws(
        /* 清单也必须明确 glibc。 */ () =>
          parseUpdateManifest({ ...original, assets: [{ ...original.assets[0], libc }] }, original.tag),
        { code: 'invalid_manifest' }
      )
    }
  }
)

test(
  'SemVer comparison is strict, numeric and rejects build aliases',
  /* 核对正式、预发行与非法版本。 */ () => {
    for (const [a, b, result] of [
      ['1.10.0', '1.9.9', 1],
      ['1.0.0', '1.0.0-dev', 1],
      ['1.0.0-alpha.2', '1.0.0-alpha.10', -1],
      ['1.0.0-1', '1.0.0-a', -1],
      ['1.0.0-a', '1.0.0-a.1', -1],
      ['9007199254740991.0.0', '9007199254740990.0.0', 1]
    ] as const) {
      assert.equal(compareVersions(a, b), result)
    }
    for (const invalid of [
      'v1.0.0',
      '01.0.0',
      '1.0',
      '1.0.0-01',
      '1.0.0+build',
      '9007199254740992.0.0',
      '1.0.0-9007199254740992',
      '../1.0.0',
      '1.0.0\n',
      '1'.repeat(129)
    ]) {
      assert.throws(/* 非法当前版本不能参与更新判断。 */ () => compareVersions(invalid, '1.0.0'), {
        code: 'invalid_current_version'
      })
    }
    assert(!stableVersion('1.0.0+build'))
    assert(!stableVersion('1.0.0-rc.1'))
  }
)

test(
  'check reads release, manifest and tag metadata only for every supported OS/arch tuple',
  /* 六个平台形状仅为模型测试。 */ async () => {
    for (const os of ['linux', 'darwin', 'windows'] as const) {
      for (const arch of ['x64', 'arm64'] as const) {
        const platform = updatePlatform(os, arch, os === 'linux' ? 'glibc' : null)
        const f = fixture(platform)
        const plan = await checkForUpdate(f.network, '0.1.0-dev', platform)
        assert.equal(plan.status, 'available')
        assert.equal(plan.asset.name, updateAssetName(plan.targetVersion, platform))
        assert.equal(f.requests.length, 3)
        assert(f.requests[1]!.endsWith(UPDATE_MANIFEST))
        assert(Object.isFrozen(plan) && Object.isFrozen(plan.asset) && Object.isFrozen(plan.platform))
      }
    }
    assert.deepEqual(updatePlatform('win32', 'x64'), { os: 'windows', arch: 'x64', libc: null })
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
      const plan = await checkForUpdate(f.network, current, updatePlatform('linux', 'x64', 'glibc'))
      assert.equal(plan.status, status)
      assert.equal(f.requests.length, 3)
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
      /* 当前版本必须由原 CLI 提供合法值。 */ () =>
        checkForUpdate(f.network, 'dev', updatePlatform('linux', 'x64', 'glibc')),
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
        /* 每类危险元数据都返回固定类别。 */ () =>
          checkForUpdate(f.network, '1.0.0', updatePlatform('linux', 'x64', 'glibc')),
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
      /* arm64 资产缺失时不能拿 x64。 */ () =>
        checkForUpdate(f.network, '1.0.0', updatePlatform('linux', 'arm64', 'glibc')),
      { code: 'unsupported_platform' }
    )
    assert.equal(f.requests.length, 3)
    assert(new UpdateError('invalid_release') instanceof Error)
  }
)
