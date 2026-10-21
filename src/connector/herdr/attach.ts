/** 附着用户已在运行的 Herdr：只连接、只观察，不拥有也不终止该进程。 */
import { herdrDeadline, withHerdrSocket } from './io.js'
import {
  HerdrLocalError,
  bindAttachedHerdr,
  herdrEndpoint,
  inspectHerdrServerProcess,
  peerIsCurrentUser,
  pinHerdrConfig,
  readHerdrPeer,
  verifyHerdrInstallation
} from './local.js'
import type { HerdrAttachedBinding, HerdrLocalConfig } from './local.js'

/**
 * 连接配置指向的端点，用内核 SO_PEERCRED 取得对端进程，并证明它是本机已安装的 herdr 服务端
 * （Linux：同一 inode 的可执行文件、当前用户、命令行为 server；Windows：管道服务端 pid 的镜像是同一文件）后签发绑定。
 * 端点不存在、无监听者或身份不符一律拒绝，不回退到自建，也不信任 socket 路径本身。
 */
export async function observeHerdrServer(input: HerdrLocalConfig, signal?: AbortSignal): Promise<HerdrAttachedBinding> {
  const scope = herdrDeadline(signal, 5000)
  try {
    const config = pinHerdrConfig(input)
    if (config.attach !== true) {
      throw new HerdrLocalError('herdr_native_instance_untrusted')
    }
    const installation = verifyHerdrInstallation(config)
    const endpoint = herdrEndpoint(config)
    const peer = await withHerdrSocket(endpoint, scope.signal, async (socket) => readHerdrPeer(socket, endpoint))
    if (!peerIsCurrentUser(peer)) {
      throw new HerdrLocalError('herdr_native_instance_untrusted')
    }
    const observed = inspectHerdrServerProcess(config, peer.pid)
    // 观察期间安装与端点不得变化，否则这次证据不能代表连接上的那个实例。
    if (verifyHerdrInstallation(config) !== installation || herdrEndpoint(config).stamp !== endpoint.stamp) {
      throw new HerdrLocalError('herdr_installation_changed')
    }
    return bindAttachedHerdr(config, observed)
  } finally {
    scope.close()
  }
}
