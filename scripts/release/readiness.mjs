// Read-only HTTP readiness uses one elapsed-time deadline, independent of connection-refusal speed.
import { setTimeout as pause } from 'node:timers/promises'

/** Stop on child exit or the shared cold-start deadline; never treat a late response as ready. */
export async function waitHttpReady(url, alive, deadline, options = {}) {
  const now = options.now ?? (() => performance.now())
  const request = options.request ?? fetch
  while (alive() && now() < deadline) {
    try {
      const response = await request(url, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(1000, Math.ceil(deadline - now()))))
      })
      return alive() && now() < deadline ? response : undefined
    } catch {
      if (!alive() || now() >= deadline) {
        break
      }
      await pause(Math.min(25, Math.max(1, deadline - now())))
    }
  }
  return undefined
}
