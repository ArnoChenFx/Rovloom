/** 测试用的极小 Unix socket 监听程序（C，macOS runner 自带 clang）：忽略命令行参数，监听 $FIXTURE_SOCKET。 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const source = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

int main(void) {
  const char *path = getenv("FIXTURE_SOCKET");
  if (!path) return 2;
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  struct sockaddr_un address;
  memset(&address, 0, sizeof address);
  address.sun_family = AF_UNIX;
  strncpy(address.sun_path, path, sizeof address.sun_path - 1);
  if (bind(fd, (struct sockaddr *)&address, sizeof address) != 0) return 3;
  chmod(path, 0600);
  if (listen(fd, 4) != 0) return 4;
  puts("up");
  fflush(stdout);
  for (;;) {
    if (accept(fd, 0, 0) < 0) pause();
  }
}
`
/**
 * 在 macOS 上于模块加载时编译一次（首次调用 Xcode 工具链可能要十几秒，不能算进单个用例的 5 秒超时），
 * 并返回可执行文件路径；体积只有几十 KB，满足安装二进制的大小上限（独立编译的 bun 可执行文件会超过 64 MiB）。
 * 被复制成“已安装的 herdr/luvus”后，进程镜像就是那份拷贝。其它平台不使用本夹具。
 */
function compile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'rovloom-listener-fixture-'))
  const file = join(directory, 'listener.c')
  writeFileSync(file, source)
  const output = join(directory, 'listener')
  execFileSync('cc', ['-O1', '-o', output, file], { stdio: 'ignore', timeout: 120_000 })
  return output
}

const compiled = process.platform === 'darwin' ? compile() : undefined

/** 返回预编译好的监听程序；只在 macOS 上可用。 */
export function listenerExecutable(): string {
  if (!compiled) {
    throw new Error('listener_fixture_requires_macos')
  }
  return compiled
}
