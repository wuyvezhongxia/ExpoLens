(() => {
  const $ = (s) => document.querySelector(s);
  const viaLocalServer = /^https?:$/.test(location.protocol);

  let targets = [];
  let bridge = null;
  let requests = new Map();
  let selected = null;
  let bodyWaiters = new Map();
  let filterText = '';
  let currentView = 'json';
  let autoFollow = true;
  let selecting = false;

  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));

  const bytes = (n) => {
    if (n == null || Number.isNaN(n)) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  };

  const statusClass = (code) => {
    const n = Number(code);
    if (!Number.isFinite(n)) return '';
    if (n >= 400) return 'bad';
    if (n >= 300) return 'warn';
    return '';
  };

  function setStatus(text, cls = '') {
    const el = $('#status');
    el.textContent = text;
    el.className = cls;
  }

  function bridgeUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }

  function ensureBridge() {
    if (!viaLocalServer) {
      setStatus('请用 npm start 打开本页（需要本地代理）', 'bad');
      return;
    }
    if (bridge && (bridge.readyState === WebSocket.OPEN || bridge.readyState === WebSocket.CONNECTING)) {
      return;
    }
    bridge = new WebSocket(bridgeUrl());
    bridge.onopen = () => setStatus('已连接本地桥接，等待 Metro…', 'warn');
    bridge.onclose = () => {
      setStatus('本地桥接断开，重连中…', 'warn');
      setTimeout(ensureBridge, 800);
    };
    bridge.onerror = () => setStatus('本地桥接失败', 'bad');
    bridge.onmessage = (ev) => {
      try {
        onBridgeMessage(JSON.parse(ev.data));
      } catch {
        /* ignore */
      }
    };
  }

  function onBridgeMessage(msg) {
    if (msg.type === 'status') {
      setStatus(msg.text, msg.level === 'ok' ? 'ok' : msg.level === 'bad' ? 'bad' : 'warn');
      return;
    }
    if (msg.type === 'stats') {
      setStatus(
        `已捕获 ${msg.ingestCount || 0} 条 · 可 Preview · :${msg.port || '?'}`,
        'ok'
      );
      return;
    }
    if (msg.type === 'cleared') {
      requests.clear();
      selected = null;
      renderList();
      $('#empty').hidden = false;
      $('#detail').hidden = true;
      return;
    }
    if (msg.type === 'hello' || msg.type === 'connected') {
      setStatus(
        msg.ingestCount > 0
          ? `不抢 DevTools · 已捕获 ${msg.ingestCount} · :${msg.port || '?'}`
          : `不抢 DevTools · 等待 with-expolens 推送 · :${msg.port || '?'}`,
        msg.ingestCount > 0 ? 'ok' : 'warn'
      );
      return;
    }
    if (msg.type === 'cdp') {
      handleCdp(msg.message);
      return;
    }
    if (msg.type === 'body') {
      const waiter = bodyWaiters.get(msg.requestId);
      if (!waiter) return;
      bodyWaiters.delete(msg.requestId);
      if (msg.ok) waiter.resolve(msg.result || {});
      else waiter.reject(new Error(msg.error || '读取失败'));
    }
  }

  function getBody(requestId) {
    return new Promise((resolve, reject) => {
      if (!bridge || bridge.readyState !== WebSocket.OPEN) {
        reject(new Error('桥接未连接'));
        return;
      }
      bodyWaiters.set(requestId, { resolve, reject });
      bridge.send(JSON.stringify({ type: 'getBody', requestId }));
      setTimeout(() => {
        if (bodyWaiters.has(requestId)) {
          bodyWaiters.delete(requestId);
          reject(new Error('读取 Response 超时'));
        }
      }, 15000);
    });
  }

  function handleCdp(m) {
    const p = m.params || {};
    if (m.method === 'Network.requestWillBeSent') {
      const existing = requests.get(p.requestId) || {};
      requests.set(p.requestId, {
        ...existing,
        id: p.requestId,
        method: p.request?.method || 'GET',
        url: p.request?.url || '',
        status: existing.status ?? '—',
        mime: existing.mime || '',
        finished: false,
        startedAt: p.timestamp || Date.now() / 1000,
        requestHeaders: p.request?.headers || {},
        type: p.type || existing.type || '',
      });
      renderList();
    }

    if (m.method === 'Network.responseReceived') {
      const r = requests.get(p.requestId);
      if (!r) return;
      r.status = p.response?.status ?? r.status;
      r.mime = p.response?.mimeType || r.mime;
      r.responseHeaders = p.response?.headers || {};
      r.statusText = p.response?.statusText || '';
      r.protocol = p.response?.protocol || '';
      r.encodedLength = p.response?.encodedDataLength;
      r.type = p.type || r.type;
      renderList();
      if (selected?.id === r.id) renderMeta(r);
    }

    if (m.method === 'Network.loadingFinished') {
      const r = requests.get(p.requestId);
      if (!r) return;
      r.finished = true;
      r.encodedLength = p.encodedDataLength ?? r.encodedLength;
      if (r.startedAt != null && p.timestamp != null) {
        r.durationMs = Math.max(0, Math.round((p.timestamp - r.startedAt) * 1000));
      }
      renderList();
      if (selected?.id === r.id) renderMeta(r);
      maybeAutoSelect(r);
    }

    if (m.method === 'Network.loadingFailed') {
      const r = requests.get(p.requestId);
      if (!r) return;
      r.finished = true;
      r.failed = true;
      r.errorText = p.errorText || 'failed';
      renderList();
    }
  }

  function isAnalyzable(r) {
    if (!r?.finished || r.failed) return false;
    const url = r.url || '';
    if (/\.(png|jpe?g|gif|webp|svg|ico|mp4|mp3|woff2?|ttf|map)(\?|$)/i.test(url)) return false;
    if (/\/assets\/|\.bundle\?|symbolicate|hot-update/i.test(url)) return false;
    const mime = (r.mime || '').toLowerCase();
    if (mime.includes('image/') || mime.includes('font') || mime.includes('video/')) return false;
    if (mime.includes('json')) return true;
    if (/xhr|fetch|document/i.test(r.type || '')) return true;
    return /^https?:/i.test(url);
  }

  function maybeAutoSelect(r) {
    if (!autoFollow || selecting) return;
    if (!isAnalyzable(r)) return;
    select(r);
  }

  async function discover() {
    setStatus('连接本地 ingest…', 'warn');
    ensureBridge();
    try {
      const res = await fetch('/api/targets', { cache: 'no-store' });
      const data = await res.json();
      targets = data.targets || [];
      const selectEl = $('#target');
      if (!targets.length) {
        selectEl.innerHTML = '<option>Ingest</option>';
      } else {
        selectEl.innerHTML = targets
          .map((x, i) => {
            const tag = x.capture === 'ingest' ? '捕获' : x.hasDevice ? '信息' : '空';
            const name =
              x.capture === 'ingest'
                ? 'Ingest（不抢 DevTools）'
                : x.hasDevice
                  ? `${x.title || 'App'} · ${x.deviceName || 'device'}`
                  : x.title || 'Metro';
            return `<option value="${i}">[${tag}] ${esc(name)} · :${x.__port}</option>`;
          })
          .join('');
      }
      const preferred = targets.find((t) => t.capture === 'ingest') || targets[0];
      if (preferred) {
        selectEl.value = String(Math.max(0, targets.indexOf(preferred)));
        await connect(preferred);
      } else {
        await connect({ id: 'ingest', capture: 'ingest' });
      }
    } catch (e) {
      setStatus(`发现失败：${e.message || e}`, 'bad');
    }
  }

  async function connect(target) {
    ensureBridge();
    setStatus('同步捕获状态…', 'warn');
    try {
      const res = await fetch('/api/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: target?.id || 'ingest', port: target?.__port }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'connect failed');
      if (bridge?.readyState === WebSocket.OPEN) {
        bridge.send(JSON.stringify({ type: 'replay' }));
      }
      setStatus(
        data.ingestCount > 0
          ? `不抢 DevTools · 已捕获 ${data.ingestCount} · :${data.port || '?'}`
          : `不抢 DevTools · 等待 with-expolens 推送 · :${data.port || '?'}`,
        data.ingestCount > 0 ? 'ok' : 'warn'
      );
    } catch (e) {
      setStatus(`连接失败：${e.message || e}`, 'bad');
    }
  }

  function matchesFilter(r) {
    const q = filterText.trim().toLowerCase();
    if (!q) return true;
    return `${r.method} ${r.status} ${r.url} ${r.mime}`.toLowerCase().includes(q);
  }

  function renderList() {
    const box = $('#requests');
    const list = [...requests.values()].filter(matchesFilter).reverse();
    $('#count').textContent = String(requests.size);

    if (!requests.size) {
      box.innerHTML =
        '<div class="empty">暂无请求。<br>保持旁听状态，在 <b>App</b> 里再点一次接口即可出现（不会回放 DevTools 里的旧请求）。</div>';
      return;
    }
    if (!list.length) {
      box.innerHTML = '<div class="empty">没有匹配过滤条件的请求。</div>';
      return;
    }

    box.innerHTML = list
      .map((r) => {
        const sc = statusClass(r.status);
        const state = r.failed ? `失败 · ${r.errorText || ''}` : r.finished ? '已完成' : '进行中';
        const dur = r.durationMs != null ? ` · ${r.durationMs} ms` : '';
        return `<div class="row ${selected?.id === r.id ? 'active' : ''}" data-id="${esc(r.id)}">
          <div class="row-top">
            <span class="method">${esc(r.method)}</span>
            <span class="code ${sc}">${esc(r.status)}</span>
          </div>
          <div class="url" title="${esc(r.url)}">${esc(r.url)}</div>
          <div class="meta">${esc(r.mime || r.type || 'network')} · ${esc(state)}${esc(dur)}</div>
        </div>`;
      })
      .join('');

    box.querySelectorAll('.row').forEach((el) => {
      el.onclick = () => {
        const req = requests.get(el.dataset.id);
        if (req) select(req);
      };
    });
  }

  function renderMeta(r) {
    $('#method').textContent = r.method;
    const code = $('#statusCode');
    code.textContent = String(r.status);
    code.className = `pill code ${statusClass(r.status)}`;
    $('#url').textContent = r.url;
    $('#url').title = r.url;
  }

  async function select(r) {
    if (!r) return;
    selecting = true;
    selected = r;
    renderList();
    renderMeta(r);
    $('#empty').hidden = true;
    $('#detail').hidden = false;

    const loading = '<div class="empty">正在读取 Response…</div>';
    $('#json').textContent = '正在读取 Response…';
    $('#analysis').innerHTML = loading;
    $('#tree').innerHTML = loading;
    $('#raw').textContent = '';

    try {
      const result = await getBody(r.id);
      let body = result.body || '';
      if (result.base64Encoded) {
        try {
          body = atob(body);
        } catch {
          body = `[base64]\n${body}`;
        }
      }
      r.body = body;
      renderDetail();
    } catch (e) {
      const msg = esc(e.message || String(e));
      const hint =
        '<div class="empty">读取失败：' +
        msg +
        '<br><br>请确认本页仍显示已连接，并在 App 中重新触发该请求后再点。</div>';
      $('#analysis').innerHTML = hint;
      $('#tree').innerHTML = hint;
    } finally {
      selecting = false;
    }
  }

  function leaf(v) {
    if (v === null) return '<span class="null">null</span>';
    if (typeof v === 'string') return `<span class="string">&quot;${esc(v)}&quot;</span>`;
    if (typeof v === 'number') return `<span class="number">${v}</span>`;
    if (typeof v === 'boolean') return `<span class="boolean">${v}</span>`;
    return '';
  }

  function keyLabel(k, isArray) {
    return isArray
      ? `<span class="index">${esc(k)}</span>: `
      : `<span class="key">&quot;${esc(k)}&quot;</span>: `;
  }

  function treeNode(k, v, parentIsArray = false, isRoot = false) {
    const prefix = isRoot ? '' : keyLabel(k, parentIsArray);
    if (v === null || typeof v !== 'object') {
      return `<div class="line">${prefix}${leaf(v)}</div>`;
    }
    const isArray = Array.isArray(v);
    const entries = Object.entries(v);
    const open = isArray ? '[' : '{';
    const close = isArray ? ']' : '}';
    if (!entries.length) {
      return `<div class="line">${prefix}<span class="punct">${open}${close}</span></div>`;
    }
    return `<div class="branch">
      <div class="toggle">▾ ${prefix}<span class="punct">${open}</span> <span class="summary">${entries.length} 项</span></div>
      <div class="children">${entries.map(([ck, cv]) => treeNode(ck, cv, isArray)).join('')}</div>
      <div class="closing">${close}</div>
    </div>`;
  }

  const SENSITIVE =
    /token|password|passwd|secret|authorization|cookie|apikey|api[_-]?key|session|private[_-]?key|refresh[_-]?token|access[_-]?token/i;
  const ID_LIKE = /(^|_)(id|uuid|guid)(_|$)/i;
  const TIME_LIKE = /(time|date|at|created|updated|expire|timestamp)/i;
  const URL_RE = /^https?:\/\//i;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
  }

  function sampleOf(v) {
    if (v === null) return 'null';
    if (typeof v === 'string') {
      const s = v.length > 80 ? `${v.slice(0, 80)}…` : v;
      return `"${s}"`;
    }
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return `Array(${v.length})`;
    if (typeof v === 'object') return `Object(${Object.keys(v).length})`;
    return String(v);
  }

  function detectStringKind(s) {
    if (!s) return 'empty';
    if (UUID_RE.test(s)) return 'uuid';
    if (URL_RE.test(s)) return 'url';
    if (EMAIL_RE.test(s)) return 'email';
    if (/^\d{10,13}$/.test(s)) return 'epoch-like';
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return 'date-like';
    if (/[\u4e00-\u9fff]/.test(s)) return 'zh-text';
    if (s.length > 120) return 'long-text';
    return 'text';
  }

  function walk(value, path, acc, depth = 0) {
    acc.nodes += 1;
    acc.maxDepth = Math.max(acc.maxDepth, depth);
    const t = typeOf(value);
    acc.typeCounts[t] = (acc.typeCounts[t] || 0) + 1;

    if (t === 'string' || t === 'number' || t === 'boolean' || t === 'null') {
      const key = path || '(root)';
      if (!acc.fields.has(key)) {
        acc.fields.set(key, {
          path: key,
          types: new Set(),
          nulls: 0,
          samples: [],
          sensitive: SENSITIVE.test(key),
          kinds: new Set(),
        });
      }
      const f = acc.fields.get(key);
      f.types.add(t);
      if (t === 'null') f.nulls += 1;
      if (t === 'string') f.kinds.add(detectStringKind(value));
      if (f.samples.length < 3) f.samples.push(sampleOf(value));
      if (SENSITIVE.test(key)) acc.sensitive.push(key);
      return;
    }

    if (t === 'array') {
      acc.arrays.push({ path: path || '(root)', length: value.length });
      if (value.length > acc.largestArray.length) {
        acc.largestArray = { path: path || '(root)', length: value.length };
      }
      const childTypes = new Set(value.map(typeOf));
      if (childTypes.size > 1) {
        acc.issues.push({
          level: 'warn',
          title: `数组元素类型不一致：${path || '(root)'}`,
          desc: `出现类型：${[...childTypes].join(', ')}`,
        });
      }
      const limit = Math.min(value.length, 50);
      for (let i = 0; i < limit; i += 1) {
        walk(value[i], path ? `${path}[]` : '[]', acc, depth + 1);
      }
      if (value.length > limit) {
        acc.issues.push({
          level: 'warn',
          title: `大数组已抽样分析：${path || '(root)'}`,
          desc: `共 ${value.length} 项，仅深入分析前 ${limit} 项。`,
        });
      }
      return;
    }

    const keys = Object.keys(value);
    acc.objects += 1;
    for (const k of keys) {
      const childPath = path ? `${path}.${k}` : k;
      if (SENSITIVE.test(k)) acc.sensitive.push(childPath);
      walk(value[k], childPath, acc, depth + 1);
    }
  }

  function classifyShape(data) {
    if (Array.isArray(data)) {
      return { name: '列表响应', detail: `根节点是数组，长度 ${data.length}` };
    }
    if (!data || typeof data !== 'object') {
      return { name: '标量 / 非对象', detail: `根类型为 ${typeOf(data)}` };
    }
    const keys = Object.keys(data);
    const lower = Object.fromEntries(keys.map((k) => [k.toLowerCase(), k]));
    if (lower.error || lower.errors || (lower.message && (lower.code || data.success === false))) {
      return { name: '疑似错误体', detail: `关键字段：${keys.slice(0, 8).join(', ')}` };
    }
    if (lower.data && (lower.meta || lower.pagination || lower.page || lower.total || lower.cursor)) {
      return { name: '分页 / 包装数据', detail: '含 data + 分页相关字段' };
    }
    if (lower.data || lower.result || lower.payload) {
      return { name: '包装对象', detail: `常见包装键：${keys.filter((k) => /^(data|result|payload|items|list)$/i.test(k)).join(', ') || keys.slice(0, 5).join(', ')}` };
    }
    if (keys.some((k) => /items|list|results|records|rows/i.test(k))) {
      return {
        name: '集合容器',
        detail: `集合相关键：${keys.filter((k) => /items|list|results|records|rows/i.test(k)).join(', ')}`,
      };
    }
    return { name: '普通对象', detail: `顶层 ${keys.length} 个字段` };
  }

  function analyzeBody(req) {
    const body = req.body ?? '';
    const byteLength = new TextEncoder().encode(body).length;
    const analysis = {
      overview: {
        method: req.method,
        status: req.status,
        mime: req.mime || '—',
        url: req.url,
        size: byteLength,
        durationMs: req.durationMs,
        protocol: req.protocol || '—',
        type: req.type || '—',
      },
      content: { kind: 'text', json: null, parseError: null },
      shape: null,
      stats: null,
      fields: [],
      issues: [],
      tags: [],
      sensitive: [],
    };

    if (!body) {
      analysis.issues.push({
        level: 'warn',
        title: '响应体为空',
        desc: '可能是 204、空 body，或调试器未缓存该响应。',
      });
      analysis.tags.push({ text: 'empty', cls: 'warn' });
      return analysis;
    }

    const trimmed = body.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        analysis.content.json = JSON.parse(trimmed);
        analysis.content.kind = 'json';
        analysis.tags.push({ text: 'JSON', cls: 'good' });
      } catch (e) {
        analysis.content.kind = 'json-like';
        analysis.content.parseError = e.message;
        analysis.tags.push({ text: 'JSON 解析失败', cls: 'bad' });
        analysis.issues.push({
          level: 'bad',
          title: '看起来像 JSON，但解析失败',
          desc: e.message,
        });
      }
    } else if (/^</.test(trimmed)) {
      analysis.content.kind = 'html-or-xml';
      analysis.tags.push({ text: 'HTML/XML', cls: 'warn' });
    } else {
      analysis.content.kind = 'text';
      analysis.tags.push({ text: 'Text', cls: '' });
    }

    if (Number(req.status) >= 400) analysis.tags.push({ text: `HTTP ${req.status}`, cls: 'bad' });
    else if (Number(req.status) >= 200) analysis.tags.push({ text: `HTTP ${req.status}`, cls: 'good' });

    if (analysis.content.json != null) {
      const acc = {
        nodes: 0,
        objects: 0,
        maxDepth: 0,
        typeCounts: {},
        fields: new Map(),
        arrays: [],
        largestArray: { path: '—', length: 0 },
        emptyObjects: [],
        sensitive: [],
        issues: [],
      };
      walk(analysis.content.json, '', acc, 0);
      analysis.shape = classifyShape(analysis.content.json);
      analysis.stats = {
        nodes: acc.nodes,
        objects: acc.objects,
        maxDepth: acc.maxDepth,
        typeCounts: acc.typeCounts,
        fieldCount: acc.fields.size,
        arrayCount: acc.arrays.length,
        largestArray: acc.largestArray,
      };
      analysis.issues.push(...acc.issues);
      analysis.sensitive = [...new Set(acc.sensitive)].slice(0, 40);
      if (analysis.sensitive.length) {
        analysis.tags.push({ text: `敏感字段 ${analysis.sensitive.length}`, cls: 'warn' });
      }
      for (const f of acc.fields.values()) {
        if (f.types.size > 1) {
          analysis.issues.push({
            level: 'warn',
            title: `字段类型不稳定：${f.path}`,
            desc: `观测到类型：${[...f.types].join(', ')}`,
          });
        }
      }
      let idFields = 0;
      let timeFields = 0;
      for (const f of acc.fields.values()) {
        const leafName = f.path.split('.').pop().replace(/\[\]/g, '');
        if (ID_LIKE.test(leafName)) idFields += 1;
        if (TIME_LIKE.test(leafName)) timeFields += 1;
      }
      analysis.tags.push({ text: `深度 ${acc.maxDepth}`, cls: '' });
      analysis.tags.push({ text: `字段 ${acc.fields.size}`, cls: '' });
      if (idFields) analysis.tags.push({ text: `ID 类 ${idFields}`, cls: '' });
      if (timeFields) analysis.tags.push({ text: `时间类 ${timeFields}`, cls: '' });
      analysis.fields = [...acc.fields.values()]
        .sort((a, b) => a.path.localeCompare(b.path))
        .slice(0, 200)
        .map((f) => ({
          path: f.path,
          types: [...f.types].join('|'),
          nulls: f.nulls,
          kinds: [...f.kinds].join(', ') || '—',
          sample: f.samples[0] || '—',
          sensitive: f.sensitive,
        }));
    }

    return analysis;
  }

  function renderAnalysis(req) {
    const a = analyzeBody(req);
    const o = a.overview;
    const cards = [
      ['状态', o.status, o.mime],
      ['体积', bytes(o.size), `${(req.body || '').length.toLocaleString()} chars`],
      ['耗时', o.durationMs != null ? `${o.durationMs} ms` : '—', o.protocol],
      ['类型', a.content.kind, o.type],
    ]
      .map(
        ([label, value, sub]) =>
          `<div class="card"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="sub">${esc(sub || '')}</div></div>`
      )
      .join('');

    const tags = a.tags.map((t) => `<span class="tag ${t.cls || ''}">${esc(t.text)}</span>`).join('');
    const shapeHtml = a.shape
      ? `<div class="block"><h3>响应形态</h3><p><strong>${esc(a.shape.name)}</strong> — ${esc(a.shape.detail)}</p></div>`
      : `<div class="block"><h3>响应形态</h3><p>非 JSON 或解析失败，见 Raw。</p></div>`;

    const stats = a.stats;
    const statsHtml = stats
      ? `<div class="block"><h3>结构统计</h3>
          <div class="tag-row" style="margin-bottom:8px">
            <span class="tag">节点 ${stats.nodes}</span>
            <span class="tag">对象 ${stats.objects}</span>
            <span class="tag">字段路径 ${stats.fieldCount}</span>
            <span class="tag">数组 ${stats.arrayCount}</span>
            <span class="tag">最大深度 ${stats.maxDepth}</span>
            <span class="tag">最大数组 ${esc(stats.largestArray.path)} · ${stats.largestArray.length}</span>
          </div>
          <p>类型分布：${esc(Object.entries(stats.typeCounts).map(([k, v]) => `${k}=${v}`).join(' · '))}</p>
        </div>`
      : '';

    const issuesHtml = a.issues.length
      ? `<div class="block"><h3>问题与提示 · ${a.issues.length}</h3>${a.issues
          .map(
            (i) =>
              `<div class="issue ${i.level}"><div class="title-line">${esc(i.title)}</div><div class="desc">${esc(i.desc)}</div></div>`
          )
          .join('')}</div>`
      : `<div class="block"><h3>问题与提示</h3><p>未发现明显结构异常。</p></div>`;

    const sensitiveHtml = a.sensitive.length
      ? `<div class="block"><h3>疑似敏感字段</h3><div class="tag-row">${a.sensitive
          .map((p) => `<span class="tag warn">${esc(p)}</span>`)
          .join('')}</div></div>`
      : '';

    const fieldsHtml = a.fields.length
      ? `<div class="block"><h3>字段清单 · 前 ${a.fields.length} 条</h3>
          <table class="fields">
            <thead><tr><th>路径</th><th>类型</th><th>形态</th><th>示例</th></tr></thead>
            <tbody>
              ${a.fields
                .map(
                  (f) => `<tr>
                    <td class="path">${esc(f.path)}${f.sensitive ? ' ⚠' : ''}</td>
                    <td>${esc(f.types)}${f.nulls ? ` · null×${f.nulls}` : ''}</td>
                    <td>${esc(f.kinds)}</td>
                    <td class="sample">${esc(f.sample)}</td>
                  </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>`
      : '';

    $('#analysis').innerHTML = `<div class="analysis-grid">
      <div class="cards">${cards}</div>
      <div class="block"><h3>标签</h3><div class="tag-row">${tags || '<span class="tag">—</span>'}</div></div>
      ${shapeHtml}${statsHtml}${issuesHtml}${sensitiveHtml}${fieldsHtml}
    </div>`;
  }

  function renderDetail() {
    if (!selected) return;
    const body = selected.body ?? '';
    let data = null;
    try {
      data = JSON.parse(body);
    } catch {
      data = null;
    }
    $('#raw').textContent = body;
    $('#json').textContent = data === null ? body : JSON.stringify(data, null, 2);
    if (data === null) {
      $('#tree').innerHTML = '<div class="empty">不是合法 JSON，已保留 Raw。</div>';
    } else {
      $('#tree').innerHTML = `<div class="tree">${treeNode('', data, false, true)}</div>`;
      $('#tree').querySelectorAll('.toggle').forEach((el) => {
        el.onclick = () => el.parentElement.classList.toggle('collapsed');
      });
    }
    renderAnalysis(selected);
  }

  function copyCurrent() {
    let text = '';
    if (currentView === 'analysis') text = $('#analysis').innerText || '';
    else if (currentView === 'tree') text = $('#tree').innerText || '';
    else if (currentView === 'json') text = $('#json').textContent || '';
    else text = $('#raw').textContent || '';
    navigator.clipboard?.writeText(text).then(
      () => setStatus('已复制当前视图', 'ok'),
      () => setStatus('复制失败', 'bad')
    );
  }

  $('#target').onchange = (e) => {
    const t = targets[Number(e.target.value)];
    if (t) connect(t);
  };
  $('#refresh').onclick = discover;
  $('#clear').onclick = async () => {
    requests.clear();
    selected = null;
    renderList();
    $('#empty').hidden = false;
    $('#detail').hidden = true;
    try {
      await fetch('/api/clear', { method: 'POST' });
    } catch {
      /* ignore */
    }
  };
  $('#autofollow').onchange = (e) => {
    autoFollow = !!e.target.checked;
  };
  $('#filter').oninput = (e) => {
    filterText = e.target.value || '';
    renderList();
  };
  $('#copy').onclick = copyCurrent;
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.onclick = () => {
      currentView = btn.dataset.view;
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === btn));
      document.querySelectorAll('.view').forEach((x) => x.classList.toggle('active', x.id === currentView));
    };
  });

  ensureBridge();
  discover();
})();
