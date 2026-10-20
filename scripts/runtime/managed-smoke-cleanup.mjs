// 保留验收启动失败后尚未确认退出的原生所有权证据；只删除本脚本自有且已无清理缺项的临时 root。
import { lstatSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** 启动未返回 processOwner 也可能已留下真实 child；任何退出未确认事实都只能单调保留。 */
export function createManagedSmokeCleanup(root) {
  let nativePending = false
  let cleanupFailed = false

  /** 只读取固定清理标记，不保存或输出底层错误、路径、配置和凭据。 */
  function observeFailure(error) {
    try {
      if (error?.cleanup_pending === true || error?.exit_confirmed === false) {
        nativePending = true
      }
    } catch {
      // 无法读取清理状态时不猜测物理退出，更不能删除仍可能属于 owner 的目录。
      nativePending = true
    }
  }

  return Object.freeze({
    observeFailure,
    /** 单项清理失败不阻止其它资源释放，但整个 root 保留给后续显式处理。 */
    cleanupFailure(error) {
      cleanupFailed = true
      observeFailure(error)
    },
    /** 真实 owner 锁优先于局部变量；未确认退出时绝不越过 native-source 的保留决定。 */
    finish() {
      try {
        lstatSync(join(root, 'control', 'root.json.owner.lock'))
        nativePending = true
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          nativePending = true
        }
      }
      if (!nativePending && !cleanupFailed) {
        try {
          rmSync(root, { recursive: true, force: true })
        } catch {
          cleanupFailed = true
        }
      }
      return Object.freeze({
        cleanup_pending: nativePending || cleanupFailed,
        root_retained: nativePending || cleanupFailed,
        ...(nativePending ? { exit_confirmed: false } : {})
      })
    }
  })
}
