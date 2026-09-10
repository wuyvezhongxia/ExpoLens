#!/usr/bin/env zsh
# 停掉会抢端口的旧 ExpoLens 进程，启动旁听模式 Preview 服务
set -euo pipefail

echo "Stopping old ExpoLens listeners on 8787-8794..."
for port in 8787 8788 8789 8790 8791 8792 8793 8794; do
  pids=$(lsof -nP -iTCP:$port -sTCP:LISTEN -t 2>/dev/null || true)
  if [[ -n "${pids:-}" ]]; then
    kill -9 ${(f)pids} 2>/dev/null || true
    echo "killed :$port"
  fi
done

cd "$(dirname "$0")"
echo "Starting ExpoLens Preview (listens to Metro /inspector/network)..."
PORT=8787 node src/server.js
