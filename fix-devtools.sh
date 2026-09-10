#!/bin/zsh
# 停掉会抢 RN DevTools 的旧 ExpoLens 进程，只保留被动 ingest 服务
set -e
cd "$HOME/Documents/ChatGPT/ExpoLens"

echo "Stopping old ExpoLens listeners on 8787-8791..."
for port in 8787 8788 8789 8790 8791; do
  pids=$(lsof -nP -iTCP:$port -sTCP:LISTEN -t 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    echo "  kill $port -> $pids"
    kill -9 ${(f)pids} 2>/dev/null || true
  fi
done

sleep 0.5

if lsof -nP -iTCP:8792 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "ExpoLens ingest already on :8792"
else
  echo "Starting ingest-only ExpoLens on :8787 (or next free port)..."
  nohup node src/server.js > /tmp/expolens.log 2>&1 &
  sleep 0.6
fi

echo "Health:"
for p in 8787 8792; do
  curl -sS -m 1 "http://127.0.0.1:$p/api/health" 2>/dev/null && echo "  (:$p)" || true
done

echo
echo "Next:"
echo "1) In RN DevTools click Reconnect DevTools"
echo "2) Restart Expo (required once so Metro loads the network tee patch)"
echo "3) Open http://127.0.0.1:8792  (or the port printed by npm start)"
echo "4) Trigger requests in the App again"
