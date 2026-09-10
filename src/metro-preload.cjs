/**
 * ExpoLens Metro preload — 不修改任何业务项目文件。
 *
 * 用法（任意项目）：
 *   # 终端1：npm start（ExpoLens）
 *   # 终端2：
 *   NODE_OPTIONS="--require /path/to/ExpoLens/src/metro-preload.cjs" npx expo start
 *
 * 原理：在 Expo CLI 加载时挂上 /inspector/network 的服务端钩子，
 * 把 Network 事件复制到 ExpoLens ingest。外部 WebSocket 旁听收不到这些事件
 *（Expo 只把它们转发给 DevTools）。
 */
const INGEST =
  process.env.EXPO_LENS_INGEST ||
  process.env.EXPO_LENS_URL ||
  '';

const ingestIds = new Set();
let resolvedIngest = INGEST;
let resolving = null;

function isIngestUrl(url) {
  return /\/api\/ingest\b/i.test(String(url || '')) || /127\.0\.0\.1:87\d{2}\b/.test(String(url || ''));
}

function shouldSkip(message) {
  if (!message || typeof message !== 'object') return true;
  const id = message.params?.requestId;
  const url = message.params?.request?.url || message.params?.response?.url || '';

  if (message.method === 'Network.requestWillBeSent' && isIngestUrl(url)) {
    if (id) ingestIds.add(id);
    return true;
  }
  if (id && ingestIds.has(id)) {
    if (
      message.method === 'Network.loadingFinished' ||
      message.method === 'Network.loadingFailed'
    ) {
      ingestIds.delete(id);
    }
    return true;
  }
  if (isIngestUrl(url)) return true;
  return false;
}

async function discoverIngest() {
  if (resolvedIngest) return resolvedIngest;
  if (resolving) return resolving;
  resolving = (async () => {
    const ports = [];
    for (let p = 8787; p <= 8800; p += 1) ports.push(p);
    for (const port of ports) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(400),
        });
        if (!res.ok) continue;
        const data = await res.json();
        if (data?.ok) {
          resolvedIngest = `http://127.0.0.1:${port}/api/ingest`;
          console.log(`[ExpoLens] preload → ${resolvedIngest}`);
          return resolvedIngest;
        }
      } catch {
        /* try next */
      }
    }
    resolvedIngest = 'http://127.0.0.1:8787/api/ingest';
    console.warn(`[ExpoLens] preload: no health found, fallback ${resolvedIngest}`);
    return resolvedIngest;
  })();
  try {
    return await resolving;
  } finally {
    resolving = null;
  }
}

function post(msg) {
  if (shouldSkip(msg)) return;
  discoverIngest()
    .then((url) =>
      fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-expolens': '1',
        },
        body: JSON.stringify(msg),
      })
    )
    .catch(() => {});
}

function attachTee(networkWss) {
  if (!networkWss || networkWss.__expolensTee) return;
  networkWss.__expolensTee = true;
  networkWss.on('connection', (socket) => {
    socket.on('message', (data) => {
      try {
        post(JSON.parse(String(data)));
      } catch {
        /* ignore */
      }
    });
  });
  console.log('[ExpoLens] metro network tee attached (no project files modified)');
}

function patchCreateDebugMiddleware(modPath) {
  const mod = require(modPath);
  if (!mod || typeof mod.createDebugMiddleware !== 'function' || mod.__expolensTee) return false;
  const original = mod.createDebugMiddleware;
  mod.createDebugMiddleware = function patchedCreateDebugMiddleware(...args) {
    const result = original.apply(this, args);
    try {
      attachTee(result?.debugWebsocketEndpoints?.['/inspector/network']);
    } catch (e) {
      console.warn('[ExpoLens] attach tee failed:', e.message);
    }
    return result;
  };
  mod.__expolensTee = true;
  return true;
}

const candidates = [
  '@expo/cli/build/src/start/server/metro/debugging/createDebugMiddleware.js',
  '@expo/cli/build/src/start/server/metro/debugging/createDebugMiddleware',
];

function tryPatchFromCwd() {
  let ok = false;
  for (const id of candidates) {
    try {
      const resolved = require.resolve(id, { paths: [process.cwd()] });
      if (patchCreateDebugMiddleware(resolved)) ok = true;
    } catch {
      /* try next */
    }
  }
  return ok;
}

// Patch now if already resolvable; also hook Module._load for late requires.
if (!tryPatchFromCwd()) {
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function expolensLoad(request, parent, isMain) {
    const exported = originalLoad.apply(this, arguments);
    if (
      typeof request === 'string' &&
      request.includes('createDebugMiddleware') &&
      exported &&
      typeof exported.createDebugMiddleware === 'function' &&
      !exported.__expolensTee
    ) {
      try {
        patchCreateDebugMiddleware(
          require.resolve(request, { paths: parent?.paths || [process.cwd()] })
        );
      } catch {
        if (exported.createDebugMiddleware && !exported.__expolensTee) {
          const original = exported.createDebugMiddleware;
          exported.createDebugMiddleware = function (...args) {
            const result = original.apply(this, args);
            try {
              attachTee(result?.debugWebsocketEndpoints?.['/inspector/network']);
            } catch {
              /* ignore */
            }
            return result;
          };
          exported.__expolensTee = true;
        }
      }
    }
    return exported;
  };
  console.log('[ExpoLens] preload armed (waiting for Expo createDebugMiddleware)');
} else {
  console.log('[ExpoLens] preload patched createDebugMiddleware');
}
