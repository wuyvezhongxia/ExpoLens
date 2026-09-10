/**
 * ExpoLens Metro tee：把 /inspector/network 事件复制一份给 ExpoLens，
 * 不占用 /inspector/debug，因此不会挤掉 React Native DevTools。
 *
 * 在 metro.config.js 顶部：
 *   require('.../ExpoLens/metro-tee.cjs')
 */
const INGESTS = (
  process.env.EXPO_LENS_INGEST ||
  'http://127.0.0.1:8787/api/ingest,http://127.0.0.1:8792/api/ingest,http://127.0.0.1:8791/api/ingest,http://127.0.0.1:8788/api/ingest'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function post(msg) {
  const body = JSON.stringify(msg);
  for (const url of INGESTS) {
    try {
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }).catch(() => {});
    } catch {
      /* ignore */
    }
  }
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
  console.log(`[ExpoLens] metro tee → ${INGESTS.join(' | ')}`);
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

let ok = false;
for (const id of candidates) {
  try {
    const resolved = require.resolve(id);
    if (patchCreateDebugMiddleware(resolved)) {
      ok = true;
      break;
    }
  } catch {
    /* try next */
  }
}

if (!ok) {
  console.warn('[ExpoLens] metro tee not attached: createDebugMiddleware not found');
}
