// 验证固定来源、跳转白名单、流式大小/摘要与时限；全部 fetch 都是受控注入，没有外部下载。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_RELEASE_BYTES, UpdateError, updatePlatform } from '../../src/update/contract.js'
import { checkForUpdate } from '../../src/update/plan.js'
import { downloadUpdate } from '../../src/update/download.js'
import {
  LATEST_RELEASE_URL,
  officialAssetUrl,
  readOfficial,
  readOfficialJson,
  type UpdateFetch
} from '../../src/update/network.js'
import { fixture } from './fixtures.js'

// 固定只读块消费者，不把下载内容交给执行器。
async function discard(_chunk: Uint8Array): Promise<void> {}

test(
  'a stalled consumer times out and receives cancellation without claiming physical quiescence',
  /* consumer 等待也属于同一总期限。 */ async () => {
    let consumerSignal: AbortSignal | undefined
    await assert.rejects(
      /* 保持 consumer pending 复现独审发现的缺口。 */ () =>
        readOfficial(
          {
            fetch: /* 合成单块响应，不依赖网络进展。 */ async () => new Response('x'),
            timeoutMs: 10
          },
          { kind: 'release' },
          1,
          /* Promise 未静止前不能被调用方视为可复用副作用。 */ async (_chunk, signal) => {
            consumerSignal = signal
            await new Promise<void>(/* 模拟无法强退的底层异步操作。 */ () => {})
          }
        ),
      { code: 'request_timeout' }
    )
    assert.equal(consumerSignal?.aborted, true)
  }
)

test(
  'external metadata rejects duplicate and escaped duplicate keys, BOM and deep containers',
  /* 不允许 JSON.parse 覆盖歧义字段。 */ async () => {
    for (const raw of [
      '{"schemaVersion":1,"schemaVersion":1}',
      '{"name":"a","na\\u006de":"b"}',
      '{"assets":[{"size":10,"size":20}]}',
      '\uFEFF{}',
      '['.repeat(40) + '0' + ']'.repeat(40),
      '{"size":9007199254740992}'
    ]) {
      await assert.rejects(
        /* 所有响应在 schema 校验之前完成唯一键和资源检查。 */ () =>
          readOfficialJson(
            {
              fetch: /* 只返回受控坏元数据，不访问外网。 */ async () => new Response(raw)
            },
            { kind: 'asset', tag: 'v1.2.0', name: 'release-manifest.json' },
            128 * 1024
          ),
        { code: 'invalid_manifest' }
      )
    }
  }
)

test(
  'network budgets reject nonfinite bounds and zero-progress chunks',
  /* 防止无界分配或零进展流绕过计数。 */ async () => {
    let calls = 0
    const fetch: UpdateFetch = /* 只为合法请求构造无进展流。 */ async () => {
      calls++
      return new Response(
        new ReadableStream({
          // 零长度片段不能触发无限微任务读取。
          start(controller) {
            controller.enqueue(new Uint8Array())
            controller.close()
          }
        })
      )
    }
    for (const limit of [NaN, Infinity, 0, -1, 0.5, 268435457]) {
      await assert.rejects(
        /* 预算必须在本地先核验。 */ () => readOfficial({ fetch }, { kind: 'release' }, limit, discard),
        { code: 'invalid_arguments' }
      )
    }
    assert.equal(calls, 0)
    await assert.rejects(
      /* 零进展直接拒绝，不依赖远端结束。 */ () => readOfficial({ fetch }, { kind: 'release' }, 1, discard),
      { code: 'size_mismatch' }
    )
  }
)

test(
  'download checks SHA256 and byte size, with no executable invocation',
  /* 只验证流字节和摘要。 */ async () => {
    const f = fixture()
    const plan = await checkForUpdate(f.network, '1.0.0', updatePlatform('linux', 'x64', 'glibc'))
    const parts: Uint8Array[] = []
    const receipt = await downloadUpdate(
      f.network,
      plan,
      /* 仅把合成样例复制到内存。 */ async (chunk) => {
        parts.push(chunk.slice())
      }
    )
    assert.deepEqual(Buffer.concat(parts), f.payload)
    assert.equal(receipt.sha256, plan.asset.sha256)
    assert.equal(receipt.size, f.payload.byteLength)
    assert.equal(f.requests.length, 4)
  }
)

test(
  'download refuses corruption, truncation, excess bytes and forged downgrade plans',
  /* sink 内容在成功返回前均不可信。 */ async () => {
    const f = fixture()
    const plan = await checkForUpdate(f.network, '1.0.0', updatePlatform('linux', 'x64', 'glibc'))
    for (const [bytes, code] of [
      [Buffer.alloc(f.payload.byteLength), 'checksum_mismatch'],
      [f.payload.subarray(1), 'size_mismatch'],
      [Buffer.concat([f.payload, Buffer.from('x')]), 'size_mismatch']
    ] as const) {
      await assert.rejects(
        /* 仅返回合成字节，不访问网络。 */ () =>
          downloadUpdate(
            {
              fetch: /* 用替代响应复现传输破坏。 */ async () => new Response(bytes)
            },
            plan,
            discard
          ),
        { code }
      )
    }
    await assert.rejects(
      /* 较旧目标不可被外部计划对象放行。 */ () =>
        downloadUpdate(f.network, { ...plan, currentVersion: '2.0.0' }, discard),
      { code: 'invalid_manifest' }
    )
    assert.equal(f.requests.length, 3)
  }
)

test(
  'single HTTPS GitHub CDN redirect is allowed without forwarding credentials',
  /* 只模型验证官方 CDN 跳转形状。 */ async () => {
    const calls: string[] = []
    const source = { kind: 'asset', tag: 'v1.2.0', name: 'rovloom-1.2.0-linux-x64' } as const
    const fetch: UpdateFetch = /* 精确区分首个官方地址与 CDN。 */ async (url, init) => {
      calls.push(url)
      assert.equal(init.credentials, 'omit')
      assert.equal(init.redirect, 'manual')
      assert(!('Authorization' in (init.headers ?? {})))
      return calls.length === 1
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://release-assets.githubusercontent.com/controlled?signature=fixture' }
          })
        : new Response('x')
    }
    assert.equal(await readOfficial({ fetch }, source, 1, discard, 1), 1)
    assert.equal(calls[0], officialAssetUrl(source.tag, source.name))
    assert.equal(calls.length, 2)
  }
)

test(
  'redirect host/protocol/credentials/port and repeated or API redirects fail closed',
  /* 任意远端主机和多跳都不可接受。 */ async () => {
    const locations = [
      'https://evil.invalid/file',
      'http://release-assets.githubusercontent.com/file',
      'https://release-assets.githubusercontent.com.evil.invalid/file',
      'https://user:pass@release-assets.githubusercontent.com/file',
      'https://release-assets.githubusercontent.com:8443/file',
      'file:///tmp/payload',
      'https://github.com/ArnoChenFx/Rovloom/releases/download/v1.2.0/rovloom-linux-x64',
      'https://release-assets.githubusercontent.com/file#fragment'
    ]
    for (const location of locations) {
      let calls = 0
      await assert.rejects(
        /* 非白名单 Location 在下次 fetch 前被拒绝。 */ () =>
          readOfficial(
            {
              fetch: /* 注入受控跳转。 */ async () => {
                calls++
                return new Response(null, { status: 302, headers: { location } })
              }
            },
            { kind: 'asset', tag: 'v1.2.0', name: 'rovloom-1.2.0-linux-x64' },
            1,
            discard
          ),
        { code: 'untrusted_redirect' }
      )
      assert.equal(calls, 1)
    }
    for (const kind of ['release', 'asset'] as const) {
      let calls = 0
      await assert.rejects(
        /* API 禁跳转，资产最多一次。 */ () =>
          readOfficial(
            {
              fetch: /* 连续跳转不会无限循环。 */ async () => {
                calls++
                return new Response(null, {
                  status: 307,
                  headers: { location: 'https://release-assets.githubusercontent.com/file' }
                })
              }
            },
            kind === 'release' ? { kind } : { kind, tag: 'v1.2.0', name: 'rovloom-1.2.0-linux-x64' },
            1,
            discard
          ),
        { code: 'untrusted_redirect' }
      )
      assert.equal(calls, kind === 'release' ? 1 : 2)
    }
  }
)

test(
  'hidden fetch redirect, bad status/length and oversized or malformed JSON are rejected',
  /* 未声明网络行为不能通过。 */ async () => {
    const hidden = new Response('x')
    Object.defineProperty(hidden, 'redirected', { value: true })
    for (const [response, code] of [
      [hidden, 'untrusted_redirect'],
      [new Response('private', { status: 403 }), 'release_unavailable'],
      [new Response('x', { headers: { 'content-length': '2' } }), 'size_mismatch'],
      [new Response('x', { headers: { 'content-length': '-1' } }), 'size_mismatch'],
      [new Response(''), 'size_mismatch'],
      [new Response('x'.repeat(MAX_RELEASE_BYTES + 1)), 'size_mismatch'],
      [new Response('{bad json'), 'invalid_release'],
      [new Response(new Uint8Array([0xff])), 'invalid_release']
    ] as const) {
      await assert.rejects(
        /* 错误不包含响应原文。 */ () =>
          checkForUpdate(
            {
              fetch: /* 只有单个元数据响应。 */ async () => response
            },
            '1.0.0',
            updatePlatform('linux', 'x64', 'glibc')
          ),
        { code }
      )
    }
  }
)

test(
  'request and response-body stalls time out even when injected fetch ignores cancellation',
  /* 网络时限覆盖两种等待阶段。 */ async () => {
    const never: UpdateFetch = /* 模拟不可取消的传输适配器。 */ async () =>
      new Promise<Response>(/* 故意保持 pending，调用方必须有独立 watchdog。 */ () => {})
    await assert.rejects(
      /* 外部 fetch 不得使检查永久挂起。 */ () =>
        readOfficial({ fetch: never, timeoutMs: 10 }, { kind: 'release' }, 1, discard),
      { code: 'request_timeout' }
    )
    const hanging: UpdateFetch = /* 返回不产生内容的受控流。 */ async (url) => {
      assert.equal(url, LATEST_RELEASE_URL)
      return new Response(new ReadableStream())
    }
    await assert.rejects(
      /* 流无进展也受同一总时限限制。 */ () =>
        readOfficial({ fetch: hanging, timeoutMs: 10 }, { kind: 'release' }, 1, discard),
      { code: 'request_timeout' }
    )
    const failure: UpdateFetch = /* 私密底层错误不能进入用户诊断。 */ async () => {
      throw new Error('private signed URL')
    }
    await assert.rejects(
      /* 固定错误不会暴露签名地址。 */ () => readOfficial({ fetch: failure }, { kind: 'release' }, 1, discard),
      new UpdateError('network_failed')
    )
  }
)
