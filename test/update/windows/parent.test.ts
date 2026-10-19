// 注入模型检验父句柄能力；原生 Windows 用例另列，Linux 模型不声称 Win32 实测。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WindowsBoundParent, nativeWindowsParent, type WindowsParentPort } from '../../../src/update/windows/parent.js'

const expected = Object.freeze({ image: 'C:\\Program Files\\Rovloom\\rovloom.exe', born: '134000000000000000' })

// 只有自己固定的一份内核对象模型，没有 PID/按名查找或终止进程能力。
function model() {
  let state: 'running' | 'exited' = 'running'
  let acquisitions = 0
  let closed = 0
  const handle = 0x123456780000n
  const port: WindowsParentPort = {
    self: /* 当前身份只供 producer 封存，不参与选择任意 PID。 */ () => expected,
    parent: /* 每次派生父关系只生成固定的自有模型句柄。 */ () => {
      acquisitions++
      return { ...expected, handle }
    },
    poll: /* 验证每次都使用原句柄；PID 重用不能重新绑定对象。 */ (actual) => {
      assert.equal(actual, handle)
      return state
    },
    close: /* 只能关闭该模型自己的能力一次。 */ (actual) => {
      assert.equal(actual, handle)
      closed++
    }
  }
  return {
    port,
    counts: /* 公开安全计数，检查无重复派生或关闭。 */ () => ({ acquisitions, closed }),
    exit: /* 真实 native 版本必须由 signaled 进程对象证明。 */ () => {
      state = 'exited'
    }
  }
}

test(
  'bound Windows parent waits on one object and cannot treat IPC as process exit',
  /* 模型中只有内核对象状态变化能允许继续；没有 EOF/kill 便利通路。 */ async () => {
    const m = model()
    const parent = WindowsBoundParent.bind(expected, m.port)
    assert.throws(/* 父进程尚活，不能授予替换能力。 */ () => parent.assertExited(), { code: 'update_busy' })
    await assert.rejects(/* 等待超时只返回非零，不发起任何终止。 */ () => parent.waitForExit(undefined, 2), {
      code: 'update_io_pending'
    })
    assert.deepEqual(m.counts(), { acquisitions: 1, closed: 0 })
    m.exit()
    await parent.waitForExit()
    parent.assertExited()
    parent.close()
    parent.close()
    assert.deepEqual(m.counts(), { acquisitions: 1, closed: 1 })
    assert.throws(/* 已关闭句柄不得重用。 */ () => parent.assertExited(), { code: 'update_busy' })
  }
)

test(
  'Windows parent identity mismatch, malformed stamp and extra PID fields fail before use',
  /* 封闭身份字段，路径 alias 不能变成任意 PID 或任意安装目标入口。 */ () => {
    for (const change of [{ image: 'C:\\other.exe' }, { born: '134000000000000001' }]) {
      const m = model()
      assert.throws(
        /* 已取得但不匹配的自有句柄立即关闭。 */ () => WindowsBoundParent.bind({ ...expected, ...change }, m.port),
        { code: 'target_changed' }
      )
      assert.deepEqual(m.counts(), { acquisitions: 1, closed: 1 })
    }
    for (const change of [
      { image: '\\\\server\\share\\rovloom.exe' },
      { image: 'C:\\app.exe:ads' },
      { born: '0' },
      { born: '18446744073709551616' }
    ]) {
      const m = model()
      assert.throws(
        /* 不合法期望值不能触发 native 查询。 */ () => WindowsBoundParent.bind({ ...expected, ...change }, m.port),
        { code: 'unsafe_installation' }
      )
      assert.deepEqual(m.counts(), { acquisitions: 0, closed: 0 })
    }
    const m = model()
    assert.throws(
      /* 即使 TypeScript 外直接传入 PID，也明确拒绝该字段。 */ () =>
        WindowsBoundParent.bind({ ...expected, pid: 1 } as never, m.port),
      { code: 'invalid_arguments' }
    )
    assert.deepEqual(m.counts(), { acquisitions: 0, closed: 0 })
  }
)

test(
  'Windows parent cancellation cannot become success even if exit has been observed',
  /* 撤销只停止向前推进，不能终止父进程或自动放弃句柄所有权。 */ async () => {
    const m = model()
    const parent = WindowsBoundParent.bind(expected, m.port)
    const controller = new AbortController()
    controller.abort()
    m.exit()
    await assert.rejects(/* 已取消的交接不能授权文件变更。 */ () => parent.waitForExit(controller.signal), {
      code: 'update_io_pending'
    })
    assert.deepEqual(m.counts(), { acquisitions: 1, closed: 0 })
    parent.close()
  }
)

if (process.platform === 'win32') {
  test(
    'native Windows kernel captures its own stamp and waits on its direct parent without termination rights',
    /* Windows CI 只查询测试进程与其直接父对象；不操作真实安装、服务或任意 PID。 */ async () => {
      const self = nativeWindowsParent.self()
      assert.match(self.image, /^[A-Za-z]:\\.+\.exe$/iu)
      assert.match(self.born, /^[1-9]\d+$/u)
      const found = nativeWindowsParent.parent()
      nativeWindowsParent.close(found.handle)
      const bound = WindowsBoundParent.bind({ image: found.image, born: found.born })
      try {
        assert.throws(/* 执行测试的父宿主尚活，不接受 IPC/轮询时限冒充退出。 */ () => bound.assertExited(), {
          code: 'update_busy'
        })
        await assert.rejects(/* 小期限只停止等待，不发出任何终止请求。 */ () => bound.waitForExit(undefined, 2), {
          code: 'update_io_pending'
        })
      } finally {
        bound.close()
      }
    }
  )
} else {
  test(
    'native Windows parent loading is unavailable on other operating systems',
    /* 不以 Linux ffi/模型冒充 Win32 原生验证。 */ () => {
      assert.throws(/* 非 Windows 在加载 DLL 前失败关闭。 */ () => nativeWindowsParent.self(), {
        code: 'replacement_unavailable'
      })
    }
  )
}
