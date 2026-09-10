import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

/**
 * ExpoLens ingest-only：不抢 RN DevTools。
 * 缓存最近 Network 事件，页面连上时回放，避免“服务端有数、左侧空白”。
 */
const preferred = Number(process.env.PORT || 8787);
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
let ingestCount = 0;
let lastIngestAt = null;
let listenPort = preferred;

function actualPort() {
  return listenPort || preferred;
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
    ingestCount += 1;
    lastIngestAt = Date.now();
    pushEvent(msg);
    broadcast({ type: 'cdp', message: msg });
    broadcast({
      type: 'stats',
      ingestCount,
      lastIngestAt,
      buffered: eventLog.length,
      bodies: bodyStore.size,
      port: actualPort(),
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
        mode: 'ingest-only',
        port: actualPort(),
        ingestCount,
        lastIngestAt,
        buffered: eventLog.length,
        bodies: bodyStore.size,
      });
      return;
    }

    if (url.pathname === '/api/ingest' && req.method === 'POST') {
      try {
        const payload = await readJson(req);
        if (Array.isArray(payload)) payload.forEach(ingestCdpMessage);
        else ingestCdpMessage(payload);
        sendJson(res, 200, { ok: true, ingestCount, buffered: eventLog.length });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e.message || e) });
      }
      return;
    }

    if (url.pathname === '/api/targets') {
      sendJson(res, 200, {
        ok: true,
        targets: [
          {
            id: 'ingest',
            title: 'ExpoLens Ingest（不抢 DevTools）',
            deviceName: 'bridge',
            __port: actualPort(),
          },
        ],
        mode: 'ingest-only',
        ingestCount,
        buffered: eventLog.length,
      });
      return;
    }

    if (url.pathname === '/api/connect' && req.method === 'POST') {
      const text =
        ingestCount > 0
          ? `已捕获 ${ingestCount} 条 · 缓冲 ${eventLog.length} · :${actualPort()}`
          : `等待 App 请求 · :${actualPort()}（不抢 DevTools）`;
      setBridgeStatus(text, 'ok');
      broadcast({
        type: 'connected',
        target: { title: 'Ingest', deviceName: 'bridge', port: actualPort() },
        ingestCount,
        buffered: eventLog.length,
      });
      sendJson(res, 200, {
        ok: true,
        mode: 'ingest-only',
        port: actualPort(),
        ingestCount,
        buffered: eventLog.length,
      });
      return;
    }

    if (url.pathname === '/api/clear' && req.method === 'POST') {
      eventLog.length = 0;
      bodyStore.clear();
      ingestCount = 0;
      lastIngestAt = null;
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
          mode: 'ingest-only',
          port: actualPort(),
          ingestCount,
          buffered: eventLog.length,
          target: { title: 'Ingest', deviceName: 'bridge', port: actualPort() },
        })
      );
      // 回放缓冲，解决“服务端有数但页面空白”
      for (const msg of eventLog) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'cdp', message: msg, replay: true }));
        }
      }
      setBridgeStatus(
        ingestCount > 0
          ? `已回放 ${eventLog.length} 条缓冲 · 共捕获 ${ingestCount} · :${actualPort()}`
          : `被动模式就绪 · :${actualPort()} · 在 App 发请求后会出现在左侧`,
        'ok'
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
    console.log(`ExpoLens: http://127.0.0.1:${port}`);
    console.log('模式: ingest-only + 事件回放');
    console.log(`ingest: http://127.0.0.1:${port}/api/ingest`);
  });
}

listen(preferred);
