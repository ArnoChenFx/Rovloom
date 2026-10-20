#!/bin/sh
# 401证明实际MCP认证监听已建立；不将其称为已配对或原生provider就绪。
set -eu
port=${ROVLOOM_HEALTH_PORT:-9444}
case "$port" in ''|*[!0-9]*) exit 1 ;; esac
[ "$port" -ge 1 ] && [ "$port" -le 65535 ] || exit 1
code=$(curl --noproxy '*' --silent --show-error --connect-timeout 1 --max-time 3 \
  --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/mcp")
[ "$code" = 401 ]
