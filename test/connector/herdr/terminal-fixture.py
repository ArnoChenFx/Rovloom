#!/usr/bin/python3 -I
"""自有 Herdr 验收的静默终端：只报告 PID、累计输入和退出，不执行输入或启动模型。"""

import os
from pathlib import Path
import signal
import tty


def save(name, value):
    """只向本脚本所在的私有临时根写固定名称的计数文件。"""
    path = Path(__file__).resolve().parent / name
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        stream.write(str(value))


def terminate(_signum, _frame):
    """所属 PTY 关闭时退出，让 finally 留下本合成进程的退出记录。"""
    raise SystemExit(0)


def main():
    """保持原始模式并统计每个输入字节；任何内容都不作为命令解释。"""
    signal.signal(signal.SIGHUP, terminate)
    signal.signal(signal.SIGTERM, terminate)
    count = 0
    try:
        tty.setraw(0)
        save('terminal.pid', os.getpid())
        save('terminal.input.bytes', count)
        while True:
            try:
                data = os.read(0, 1024)
            except OSError:
                break
            if not data:
                break
            count += len(data)
            save('terminal.input.bytes', count)
    finally:
        save('terminal.exiting', True)


if __name__ == '__main__':
    main()
