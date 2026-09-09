# RN JSON Inspector

一个不依赖 Proxyman、Charles、HAR 或项目代码改动的本地 JSON Preview 修复器。它直接处理 Expo DevTools `Response` 面板中的文本：自动解析 JSON、树形查看、Raw/JSON 切换、剪贴板读取、脱敏和复制。

## 使用

```bash
npm start
```

打开 <http://127.0.0.1:8787>，将 Expo DevTools → Network → Response 中的响应粘贴进去，点击“解析 JSON”。

## 当前边界

这是第一阶段的独立 Companion：它验证“复用已有 Response body、修复 Preview 体验”的核心路径，不拦截网络、不安装证书、不要求修改 Expo/RN 项目。下一步可以接 Expo 调试会话协议，把手动粘贴替换成当前请求的自动读取。
