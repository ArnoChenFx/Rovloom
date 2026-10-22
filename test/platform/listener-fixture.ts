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
let compiled: string | undefined

/**
 * 编译一次并返回可执行文件路径；体积只有几十 KB，满足安装二进制的大小上限
 * （独立编译的 bun 可执行文件会超过 64 MiB）。被复制成“已安装的 herdr/luvus”后，进程镜像就是那份拷贝。
 */
export function listenerExecutable(): string {
  if (!compiled) {
    const directory = mkdtempSync(join(tmpdir(), 'rovloom-listener-fixture-'))
    const file = join(directory, 'listener.c')
    writeFileSync(file, source)
    compiled = join(directory, 'listener')
    execFileSync('cc', ['-O1', '-o', compiled, file], { stdio: 'ignore' })
  }
  return compiled
}
