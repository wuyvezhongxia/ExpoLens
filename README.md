# ExpoLens

通用本地 **Response Preview** 工具：对**任意** Expo / React Native 项目可用。

## 硬约束

- **零改动业务项目**：不装依赖、不改 `metro.config.js`、不写上报地址、不注入桥接代码
- **不绑死某一个仓库**：换项目只要本机 Metro 在跑即可
- **不抢 RN DevTools**：只旁听 `/inspector/network`
- **产品目标**：Preview 格式化 Response JSON（不是排查「为什么没格式化」）

## 用法（对所有项目相同）

1. 用你平时的方式启动任意 Expo / RN 项目（`npx expo start` 等）
2. 另开终端启动 ExpoLens：

```bash
cd /path/to/ExpoLens
npm start
```

3. 打开终端打印的地址（通常 `http://127.0.0.1:8787`）
4. 点「重新连接」→ 选中发现的 Metro → 在 App 里发请求 → 点左侧条目 Preview JSON

不需要知道业务项目路径，也不需要改那个项目里的任何文件。

可选：

```bash
PORT=8787 METRO_PORTS=8081,19000 npm start
```

`METRO_PORTS` 只在自动发现失败时作补充；默认会扫描本机常见 / 正在监听的 Metro 端口。

## 工作原理（为何能通用）

```
任意项目的 Metro  ──/inspector/network──►  ExpoLens（旁听）──► 浏览器 Preview
```

Expo / Metro 本身就会广播 Network 事件。ExpoLens 是**外部旁听者**，所以：

| 做法 | 能否通用 |
| --- | --- |
| 改每个项目注入 tee / Reactotron | 否，每项目要配一次 |
| 写死 `localhost:某端口/ingest` | 否，端口因人而异 |
| 自动发现 Metro 并旁听 network | 是，零改项目 |

## 范围与限制

- 适用于本机已启动、带 Expo Network 通道的开发会话（Expo Go / Dev Client / 常见 Expo Metro）
- 不会回放你打开 Preview 之前已发生的请求；打开后新发的请求会出现
- 不是 Charles/Proxyman 级系统代理；也不替代官方 DevTools 的全部调试能力
- 若某项目以前被注入过旧版 `metro-tee`，请自行删掉（ExpoLens 已不再提供该文件）

## 恢复被挤掉的 RN DevTools

```bash
lsof -nP -iTCP:8787-8800 -sTCP:LISTEN
kill <PID>
```

然后在 RN DevTools 点 Reconnect。
