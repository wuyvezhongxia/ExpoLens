import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocketServer, WebSocket } from 'ws';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.join(__dirname, 'metro-preload.cjs');
const withBin = path.join(__dirname, '..', 'bin', 'with-expolens.mjs');

/**
 * ExpoLens — Response Preview
 *
 * 不连接 /inspector/debug（那会挤掉 RN DevTools）。
 * 只被动接收 preload 推送到 /api/ingest 的 Network 事件。
 * 任意项目：用 with-expolens 启动 Expo，不改业务仓库文件。
 */
const preferred = Number(process.env.PORT || 8787);
const metroPortsEnv = process.env.METRO_PORTS || '';
const root = path.join(__dirname, '..', 'extension');
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

const DEFAULT_METRO_PORTS = [8081, 8082, 8083, 19000, 19001, 19002, 19006, 8097];

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

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of uiClients) {
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

  if (typeof msg.method !== 'string' || !msg.method.startsWith('Network.')) return;
  if (
    msg.method !== 'Network.requestWillBeSent' &&
    msg.method !== 'Network.responseReceived' &&
    msg.method !== 'Network.loadingFinished' &&
    msg.method !== 'Network.loadingFailed'
  ) {
    return;
  }

  if (msg.method === 'Network.requestWillBeSent') {
    eventCount += 1;
    lastEventAt = Date.now();
  }
  pushEvent(msg);
  broadcast({ type: 'cdp', message: msg });
  broadcast({
    type: 'stats',
    ingestCount: eventCount,
    lastIngestAt: lastEventAt,
    buffered: eventLog.length,
    bodies: bodyStore.size,
    port: actualPort(),
  });
}

async function resolveBody(requestId) {
  if (bodyStore.has(requestId)) return bodyStore.get(requestId);
  throw new Error(
    '没有 Response Body。请确认 Expo 是用 with-expolens 启动的，并在 App 里重新请求一次。'
  );
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
          hasDevice: false,
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
          hasDevice: false,
        };
      }
      const first = items[0] || {};
      return {
        id: first.id || `metro:${port}`,
        title: first.title || first.description || 'App',
        deviceName: first.deviceName || first.device || 'device',
        appId: first.appId || '',
        __port: port,
        hasDevice: Boolean(first.id || first.appId || first.title),
      };
    } catch {
      /* next */
    }
  }
  return null;
}

async function listeningLocalPorts() {
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], {
      timeout: 2000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const ports = new Set();
    for (const line of String(stdout).split('\n')) {
      const m = line.match(/:(?<port>\d+)\s+\(LISTEN\)/);
      if (!m) continue;
      const port = Number(m.groups.port);
      if (!Number.isFinite(port) || port === actualPort()) continue;
      if ((port >= 8000 && port <= 8100) || (port >= 19000 && port <= 19020)) ports.add(port);
    }
    return [...ports];
  } catch {
    return [];
  }
}

async function discoverMetroTargets() {
  const candidates = [...new Set([...(await listeningLocalPorts()), ...metroPortCandidates()])];
  const found = [];
  const seenPorts = new Set();
  for (const port of candidates) {
    const target = await probeMetro(port);
    if (!target || seenPorts.has(target.__port)) continue;
    seenPorts.add(target.__port);
    found.push(target);
  }
  const deduped = [];
  const seenDevices = new Set();
  for (const t of found.sort((a, b) => Number(b.hasDevice) - Number(a.hasDevice) || a.__port - b.__port)) {
    if (t.hasDevice) {
      const key = t.id || `${t.appId}|${t.deviceName}|${t.title}`;
      if (seenDevices.has(key)) continue;
      seenDevices.add(key);
    }
    deduped.push(t);
  }
  return deduped.sort((a, b) => Number(b.hasDevice) - Number(a.hasDevice) || a.__port - b.__port);
}

function createServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type,x-expolens',
      });
      res.end();
      return;
    }

    if (url.pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        mode: 'ingest-preload',
        port: actualPort(),
        ingestCount: eventCount,
        lastIngestAt: lastEventAt,
        buffered: eventLog.length,
        bodies: bodyStore.size,
        stealsDevTools: false,
        hint: `node ${withBin} npx expo start`,
      });
      return;
    }

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
      // Synthetic ingest target first — this is the real capture channel.
      sendJson(res, 200, {
        ok: true,
        targets: [
          {
            id: 'ingest',
            title: 'ExpoLens Ingest（不抢 DevTools）',
            deviceName: 'preload',
            __port: actualPort(),
            hasDevice: true,
            capture: 'ingest',
          },
          ...targets.map((t) => ({ ...t, capture: 'info-only' })),
        ],
        mode: 'ingest-preload',
        ingestCount: eventCount,
        buffered: eventLog.length,
      });
      return;
    }

    if (url.pathname === '/api/connect' && req.method === 'POST') {
      const text =
        eventCount > 0
          ? `已捕获 ${eventCount} 条 · 不抢 DevTools · :${actualPort()}`
          : `等待 preload 推送 · :${actualPort()} · Expo 请用 with-expolens 启动`;
      setBridgeStatus(text, eventCount > 0 ? 'ok' : 'warn');
      broadcast({
        type: 'connected',
        target: { title: 'Ingest', deviceName: 'preload', port: actualPort() },
        ingestCount: eventCount,
        buffered: eventLog.length,
        mode: 'ingest-preload',
      });
      sendJson(res, 200, {
        ok: true,
        mode: 'ingest-preload',
        port: actualPort(),
        ingestCount: eventCount,
        buffered: eventLog.length,
        stealsDevTools: false,
      });
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
          mode: 'ingest-preload',
          port: actualPort(),
          ingestCount: eventCount,
          buffered: eventLog.length,
          stealsDevTools: false,
        })
      );
      for (const msg of eventLog) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'cdp', message: msg, replay: true }));
        }
      }
      setBridgeStatus(
        eventCount > 0
          ? `已回放 ${eventLog.length} 条 · 共捕获 ${eventCount} · :${actualPort()}`
          : `不抢 DevTools · 等待 with-expolens 推送 · :${actualPort()}`,
        eventCount > 0 ? 'ok' : 'warn'
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
    console.log('模式: 不抢 DevTools · 只收 preload → /api/ingest');
    console.log('任意项目启动 Expo:');
    console.log(`  node ${withBin} npx expo start`);
    console.log(`或: NODE_OPTIONS="--require ${preloadPath}" npx expo start`);
    setBridgeStatus(`就绪 · 不抢 DevTools · :${port}`, 'ok');
  });
}

listen(preferred);
