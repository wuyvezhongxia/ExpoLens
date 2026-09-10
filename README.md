# ExpoLens

通用 **Response Preview**：任意 Expo/RN 项目可用，**不改业务项目文件**，**不抢 RN DevTools**。

## 重要

不要连 `/inspector/debug`。那样会触发：

> Disconnected due to opening a second DevTools window for the same app.

ExpoLens 只被动接收 preload 推送的 Network 事件。

## 用法

### 1. 启动 ExpoLens

```bash
cd ~/Documents/ChatGPT/ExpoLens
npm start
```

打开终端打印的地址。

### 2. 用包装命令启动任意业务项目（不改项目文件）

```bash
cd /path/to/your-app
node ~/Documents/ChatGPT/ExpoLens/bin/with-expolens.mjs npx expo start
```

日志应出现：`[ExpoLens] metro network tee attached`

### 3. Preview

App 里发请求 → ExpoLens 左侧出现 → 点开看 JSON。

RN DevTools 可同时开；若刚才被挤掉，点 **Reconnect DevTools**。

## 清旧端口

```bash
for port in 8787 8788 8789 8790 8791 8792 8793 8794; do
  pids=$(lsof -nP -iTCP:$port -sTCP:LISTEN -t 2>/dev/null)
  [ -n "$pids" ] && kill -9 $pids && echo "freed :$port"
done
```
