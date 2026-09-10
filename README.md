# ExpoLens

本地 Expo / React Native Response 详细分析。**默认不抢 RN DevTools 调试通道。**

## 刚才发生了什么

旧版会连接 `/inspector/debug`，和 React Native DevTools 互斥，所以你会看到：

> Disconnected due to opening a second DevTools window for the same app.

现已改为 **ingest-only**：只被动接收复制过来的 Network 事件。

## 立刻恢复你的 RN DevTools

1. 关掉所有 ExpoLens 页面 / 终端里的旧 `node src/server.js`
2. 在 RN DevTools 弹窗点 **Reconnect DevTools**
3. Network 应恢复

若仍被抢占，在终端执行：

```bash
lsof -nP -iTCP:8787-8800 -sTCP:LISTEN
# 把占用这些端口的 node 进程杀掉（旧 ExpoLens）
kill -9 <PID>
```

## 并存用法

`lovie-app/metro.config.js` 已加入：

```js
require('/Users/apple/Documents/ChatGPT/ExpoLens/metro-tee.cjs')
```

然后：

1. **重启 Expo**（必须，tee 才会生效）
2. 启动 ExpoLens：

```bash
cd "$HOME/Documents/ChatGPT/ExpoLens"
npm start
```

3. 打开终端打印的地址（通常 http://127.0.0.1:8787）
4. RN DevTools 可同时开着；App 发请求后，两边都能看到

## 分析能力

点开 ExpoLens 里的请求 → 本地详细分析（形态、字段、敏感键、Tree/JSON/Raw）。不上传、不接公司 API。
