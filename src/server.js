import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocketServer, WebSocket } from 'ws';

const execFileAsync = promisify(execFile);

/**
 * ExpoLens — Response Preview（通用工具，不绑定任何业务仓库）
 *
 * 约束：
 * - 零改动：不向任何项目写代码 / 配 tee / 写死上报地址
 * - 旁听 Metro `/inspector/network`，不抢 `/inspector/debug`
 * - 自动发现本机任意 Metro 端口，换项目也能用
 */
const preferred = Number(process.env.PORT || 8787);
const metroPortsEnv = process.env.METRO_PORTS || '';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const MAX_EVENTS = 500;
const bodyStore = new Map();
const eventLog = [];
const uiClients = new Set();
let eventCount = 0;
let lastEventAt = null;
let listenPort = preferred;
let metroSocket = null;
let metroTarget = null;
let discoverTimer = null;
let reconnectDelay = 800;

const DEFAULT_METRO_PORTS = [
  8081, 8082, 8083, 19000, 19001, 19002, 19006, 8097,
];

function actualPort() {
  return listenPort || preferred;
}

function metroPortCandidates() {
  const fromEnv = metroPortsEnv
    .split(/[,\s]+/)
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0);
  return [...new Set([...fromEnv, ...DEFAULT_METRO_PORTS])];
}

function broadcast(msg, { skip } = {}) {
  const data = JSON.stringify(msg);
  for (const c of uiClients) {
    if (skip && c === skip) continue;
    if (c.readyState === WebSocket.OPEN) c.send(data);
  }
}

function setBridgeStatus(text, level = 'info') {
  broadcast({ type: 'status', text, level });
}

function pushEvent(msg) {
  eventLog.push(msg);
  if (eventLog.length > MAX_EVENTS) eventLog.splice(0, eventLog.length - MAX_EVENTS);
}

function ingestCdpMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  if (msg.method === 'Expo(Network.receivedResponseBody)' && msg.params?.requestId) {
    const { requestId, ...rest } = msg.params;
    bodyStore.set(requestId, rest);
    if (bodyStore.size > 400) {
      const first = bodyStore.keys().next().value;
      bodyStore.delete(first);
    }
    return;
  }

  if (typeof msg.method === 'string' && msg.method.startsWith('Network.')) {
    eventCount += 1;
    lastEventAt = Date.now();
    pushEvent(msg);
    broadcast({ type: 'cdp', message: msg });
    broadcast({
      type: 'stats',
      ingestCount: eventCount,
      lastIngestAt: lastEventAt,
      buffered: eventLog.length,
      bodies: bodyStore.size,
      port: actualPort(),
      metro: metroTarget,
    });
  }
}

async function resolveBody(requestId) {
  if (bodyStore.has(requestId)) return bodyStore.get(requestId);
  throw new Error('没有缓存该 Response。请在 App 中重新请求一次。');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 20 * 1024 * 1024) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(body));
}

function fetchText(url, timeoutMs = 600) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => {
        data += c;
        if (data.length > 2 * 1024 * 1024) {
          req.destroy();
          reject(new Error('response too large'));
        }
      });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

async function probeMetro(port) {
  const base = `http://127.0.0.1:${port}`;
  // Prefer /json/list (RN debugger targets). Fall back to status endpoints.
  for (const pathName of ['/json/list', '/json', '/status']) {
    try {
      const { status, body } = await fetchText(`${base}${pathName}`);
      if (status < 200 || status >= 300) continue;
      if (pathName === '/status' && /packager-status:running/i.test(body)) {
        return {
          id: `metro:${port}`,
          title: 'Metro',
          deviceName: 'local',
          __port: port,
          networkUrl: `ws://127.0.0.1:${port}/inspector/network`,
        };
      }
      let list;
      try {
        list = JSON.parse(body);
      } catch {
        continue;
      }
      const items = Array.isArray(list) ? list : list ? [list] : [];
      if (!items.length && pathName.startsWith('/json')) {
        return {
          id: `metro:${port}`,
          title: 'Metro（暂无设备）',
          deviceName: 'local',
          __port: port,
          networkUrl: `ws://127.0.0.1:${port}/inspector/network`,
        };
      }
      const first = items[0] || {};
      return {
        id: first.id || `metro:${port}`,
        title: first.title || first.description || 'App',
        deviceName: first.deviceName || first.device || 'device',
        __port: port,
        networkUrl: `ws://127.0.0.1:${port}/inspector/network`,
        webSocketDebuggerUrl: first.webSocketDebuggerUrl,
      };
    } catch {
      /* try next path / port */
    }
  }
  return null;
}

async function listeningLocalPorts() {
  try {
    const { stdout } = await execFileAsync(
      'lsof',
      ['-nP', '-iTCP', '-sTCP:LISTEN'],
      { timeout: 2000, maxBuffer: 2 * 1024 * 1024 }
    );
    const ports = new Set();
    for (const line of String(stdout).split('\n')) {
      // Only local listeners; skip ExpoLens itself later by probe failure / own port.
      const m = line.match(/:(?<port>\d+)\s+\(LISTEN\)/);
      if (!m) continue;
      const port = Number(m.groups.port);
      if (!Number.isFinite(port) || port === actualPort()) continue;
      // Metro / Expo packager commonly sits in this band; keep scan bounded.
      if (port < 1024 || port > 65535) continue;
      if (port >= 8000 && port <= 8100) ports.add(port);
      if (port >= 19000 && port <= 19020) ports.add(port);
      if (port >= 8080 && port <= 8099) ports.add(port);
    }
    return [...ports];
  } catch {
    return [];
  }
}

async function discoverMetroTargets() {
  const candidates = [...new Set([...(await listeningLocalPorts()), ...metroPortCandidates()])];
  const found = [];
  const seen = new Set();
  for (const port of candidates) {
    const target = await probeMetro(port);
    if (!target || seen.has(target.__port)) continue;
    seen.add(target.__port);
    found.push(target);
  }
  return found;
}

function disconnectMetro() {
  if (metroSocket) {
    try {
      metroSocket.removeAllListeners();
      metroSocket.close();
    } catch {
      /* ignore */
    }
  }
  metroSocket = null;
}

function attachMetro(target) {
  if (!target?.networkUrl) return;
  if (
    metroSocket &&
    metroTarget?.networkUrl === target.networkUrl &&
    (metroSocket.readyState === WebSocket.OPEN || metroSocket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  disconnectMetro();
  metroTarget = target;
  setBridgeStatus(`正在旁听 Metro :${target.__port} …`, 'warn');

  const socket = new WebSocket(target.networkUrl);
  metroSocket = socket;

  socket.on('open', () => {
    reconnectDelay = 800;
    setBridgeStatus(
      `已旁听 Metro :${target.__port} · 可与 RN DevTools 并存 · 在 App 发请求即可 Preview`,
      'ok'
    );
    broadcast({
      type: 'connected',
      target,
      ingestCount: eventCount,
      buffered: eventLog.length,
      mode: 'listen-network',
    });
  });

  socket.on('message', (raw) => {
    try {
      ingestCdpMessage(JSON.parse(String(raw)));
    } catch {
      /* ignore non-json */
    }
  });

  socket.on('close', () => {
    if (metroSocket === socket) metroSocket = null;
    setBridgeStatus(`Metro :${target.__port} 断开，稍后重连…`, 'warn');
    scheduleDiscover(reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 8000);
  });

  socket.on('error', () => {
    // close handler will reconnect
  });
}

async function connectPreferred(targetId) {
  const targets = await discoverMetroTargets();
  if (!targets.length) {
    metroTarget = null;
    setBridgeStatus('未发现 Metro。请先启动 Expo（npx expo start）', 'bad');
    return { ok: false, targets, error: 'no metro' };
  }
  const chosen =
    (targetId && targets.find((t) => t.id === targetId || String(t.__port) === String(targetId))) ||
    targets[0];
  attachMetro(chosen);
  return { ok: true, targets, target: chosen };
}

function scheduleDiscover(delayMs = 1500) {
  if (discoverTimer) clearTimeout(discoverTimer);
  discoverTimer = setTimeout(async () => {
    discoverTimer = null;
    if (metroSocket?.readyState === WebSocket.OPEN) return;
    await connectPreferred(metroTarget?.id);
  }, delayMs);
}

function createServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      res.end();
      return;
    }

    if (url.pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        mode: 'listen-network',
        port: actualPort(),
        ingestCount: eventCount,
        lastIngestAt: lastEventAt,
        buffered: eventLog.length,
        bodies: bodyStore.size,
        metro: metroTarget,
        metroConnected: metroSocket?.readyState === WebSocket.OPEN,
      });
      return;
    }

    // Optional legacy fallback only — not the primary path.
    if (url.pathname === '/api/ingest' && req.method === 'POST') {
      try {
        const payload = await readJson(req);
        if (Array.isArray(payload)) payload.forEach(ingestCdpMessage);
        else ingestCdpMessage(payload);
        sendJson(res, 200, { ok: true, ingestCount: eventCount, buffered: eventLog.length });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e.message || e) });
      }
      return;
    }

    if (url.pathname === '/api/targets') {
      const targets = await discoverMetroTargets();
      sendJson(res, 200, {
        ok: true,
        targets,
        mode: 'listen-network',
        ingestCount: eventCount,
        buffered: eventLog.length,
        metro: metroTarget,
      });
      return;
    }

    if (url.pathname === '/api/connect' && req.method === 'POST') {
      try {
        const body = await readJson(req);
        const result = await connectPreferred(body.id || body.port);
        sendJson(res, result.ok ? 200 : 503, {
          ...result,
          mode: 'listen-network',
          port: actualPort(),
          ingestCount: eventCount,
          buffered: eventLog.length,
        });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e.message || e) });
      }
      return;
    }

    if (url.pathname === '/api/clear' && req.method === 'POST') {
      eventLog.length = 0;
      bodyStore.clear();
      eventCount = 0;
      lastEventAt = null;
      broadcast({ type: 'cleared' });
      sendJson(res, 200, { ok: true });
      return;
    }

    let filePath = url.pathname === '/' ? '/panel.html' : url.pathname;
    filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
    const abs = path.join(root, filePath);
    if (!abs.startsWith(root)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    fs.readFile(abs, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'content-type': types[path.extname(abs)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      uiClients.add(client);
      client.send(
        JSON.stringify({
          type: 'hello',
          mode: 'listen-network',
          port: actualPort(),
          ingestCount: eventCount,
          buffered: eventLog.length,
          target: metroTarget,
          metroConnected: metroSocket?.readyState === WebSocket.OPEN,
        })
      );
      for (const msg of eventLog) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'cdp', message: msg, replay: true }));
        }
      }
      setBridgeStatus(
        metroSocket?.readyState === WebSocket.OPEN
          ? `旁听中 · Metro :${metroTarget?.__port} · 已捕获 ${eventCount}`
          : '正在发现 Metro…',
        metroSocket?.readyState === WebSocket.OPEN ? 'ok' : 'warn'
      );

      client.on('message', async (raw) => {
        let msg;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.type === 'getBody') {
          try {
            const result = await resolveBody(msg.requestId);
            client.send(
              JSON.stringify({ type: 'body', requestId: msg.requestId, ok: true, result })
            );
          } catch (e) {
            client.send(
              JSON.stringify({
                type: 'body',
                requestId: msg.requestId,
                ok: false,
                error: String(e.message || e),
              })
            );
          }
        }
        if (msg.type === 'replay') {
          for (const m of eventLog) {
            client.send(JSON.stringify({ type: 'cdp', message: m, replay: true }));
          }
        }
      });
      client.on('close', () => uiClients.delete(client));
    });
  });

  return server;
}

function listen(port, tries = 0) {
  const server = createServer();
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && tries < 20) {
      listen(port + 1, tries + 1);
      return;
    }
    throw err;
  });
  server.listen(port, '127.0.0.1', () => {
    listenPort = port;
    console.log(`ExpoLens Preview: http://127.0.0.1:${port}`);
    console.log('模式: 通用旁听 · 零改业务项目 · 任意 Expo/RN 项目可用');
    console.log('发现: 本机监听端口 + 常见 Metro 端口');
    console.log('可选: METRO_PORTS=8081,19000 补充扫描');
    connectPreferred().then((r) => {
      if (!r.ok) scheduleDiscover(2000);
    });
  });
}

listen(preferred);
