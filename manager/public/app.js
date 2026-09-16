/* Godot 多开管理器 前端 SPA（无构建、无依赖） */

const S = {
  state: null,          // 服务端全量状态
  selected: null,       // 当前选中项目 id
  tab: 'terminal',      // terminal | debug | overview
  termSel: null,        // 终端当前查看的实例 id
  logs: new Map(),      // instanceId -> { lines: [], synced: bool, rendered: 0 }
  follow: true,
  builtKey: '',         // 用于避免整棵重建终端/调试 DOM
  debugKind: 'doctor',
  debugData: null,
  debugErr: null,
  debugAuto: 0,
  debugTimer: null,
};

/* ---------- 工具 ---------- */

const $ = (sel, el = document) => el.querySelector(sel);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (typeof v === 'boolean') { if (v) el.setAttribute(k, ''); } // disabled/checked/open 是布尔属性：false 时绝不能设置
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, type = 'ok', ms = 3200) {
  const el = h('div', { class: `toast ${type}`, text: msg });
  $('#toasts').append(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; setTimeout(() => el.remove(), 260); }, ms);
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

function copyText(text) {
  navigator.clipboard?.writeText(text).then(() => toast('已复制到剪贴板'), () => toast('复制失败', 'err'));
}

function getProject(id = S.selected) {
  return S.state?.projects.find((p) => p.id === id) ?? null;
}

/* ---------- SSE ---------- */

function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => {
    S.state = JSON.parse(e.data);
    render();
  });
  es.addEventListener('log', (e) => {
    const evt = JSON.parse(e.data);
    appendLog(evt.instanceId, evt.lines);
  });
  es.onerror = () => { /* EventSource 自动重连 */ };
}

/* ---------- 日志缓冲 ---------- */

function logBuf(id) {
  if (!S.logs.has(id)) S.logs.set(id, { lines: [], synced: false, rendered: 0 });
  return S.logs.get(id);
}

function appendLog(instanceId, lines) {
  const buf = logBuf(instanceId);
  buf.lines.push(...lines);
  if (buf.lines.length > 6000) buf.lines.splice(0, buf.lines.length - 6000);
  if (S.tab === 'terminal' && S.termSel === instanceId) {
    const body = $('#termBody');
    if (body) paintLines(body, lines, instanceId);
  }
}

function lineClass(line) {
  const t = line.text;
  if (/SCRIPT ERROR|ERROR|ERROR:/.test(t)) return 'err';
  if (/WARNING/.test(t)) return 'warn';
  if (t.startsWith('[manager]')) return 'mgr';
  if (line.stream === 'err') return 'err';
  if (/MCP/i.test(t)) return 'mcp';
  return '';
}

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function paintLines(body, lines, instanceId) {
  const follow = S.follow && body.scrollHeight - body.scrollTop - body.clientHeight < 60;
  const frag = document.createDocumentFragment();
  for (const l of lines) {
    frag.append(h('div', { class: `ln ${lineClass(l)}`, text: l.text.replace(ANSI_RE, '') }));
  }
  body.append(frag);
  // 限制 DOM 节点数
  while (body.childElementCount > 3200) body.firstElementChild.remove();
  if (follow) body.scrollTop = body.scrollHeight;
}

async function syncHistory(instanceId) {
  const buf = logBuf(instanceId);
  if (buf.synced) return;
  try {
    const data = await api(`/api/instances/${instanceId}/logs?tail=1500`);
    // 以服务端历史为准（覆盖本地已收到的实时行，避免重复）
    buf.lines = data.lines;
    buf.synced = true;
    if (S.tab === 'terminal' && S.termSel === instanceId) rebuildTermBody();
  } catch { /* 实例可能已清理 */ }
}

function rebuildTermBody() {
  const body = $('#termBody');
  if (!body) return;
  body.textContent = '';
  const buf = logBuf(S.termSel);
  paintLines(body, buf.lines.slice(-1500), S.termSel);
  body.scrollTop = body.scrollHeight;
}

/* ---------- 渲染：侧栏 ---------- */

function projectStatus(p) {
  const running = p.instances.filter((i) => i.status === 'running');
  if (running.some((i) => i.mode === 'game')) return { cls: 'g', label: '运行中' };
  if (running.length) return { cls: 'g', label: `${running.length} 实例` };
  if (p.instances.length) return { cls: 'y', label: '已停止' };
  return { cls: 'off', label: '空闲' };
}

function renderSidebar() {
  const list = $('#projectList');
  list.textContent = '';
  if (!S.state.projects.length) {
    list.append(h('div', { class: 'empty-hint', text: '还没有项目，点击上方按钮开始' }));
  }
  for (const p of S.state.projects) {
    const st = projectStatus(p);
    const card = h('div', { class: `project-card ${p.id === S.selected ? 'active' : ''}`, onclick: () => { S.selected = p.id; S.termSel = null; S.builtKey = ''; render(); } },
      h('div', { class: 'pname' },
        h('span', { class: `dot ${st.cls}` }),
        h('span', { text: p.name, style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' })),
      h('div', { class: 'pmeta' },
        h('span', { class: 'chip', text: `:${p.port ?? '—'}` }),
        h('span', { text: st.label })),
      h('span', { class: 'remove', title: '从管理器移除（不删除文件）', text: '✕', onclick: async (e) => {
        e.stopPropagation();
        if (!(await confirmDialog(`移除项目「${p.name}」？`, '仅从管理器列表移除，不会删除项目文件；其运行中的实例会被停止。'))) return;
        try { await api(`/api/projects/${p.id}`, { method: 'DELETE' }); if (S.selected === p.id) { S.selected = null; S.builtKey = ''; } toast('已移除'); }
        catch (err) { toast(err.message, 'err'); }
      } }));
    list.append(card);
  }

  // 工具链徽章
  const badge = $('#toolchainBadge');
  const tc = S.state.toolchain;
  badge.className = 'badge';
  if (tc.state === 'ready') { badge.classList.add('ok'); badge.textContent = `工具链 ${tc.version} ✓`; badge.title = 'Godot-MCP-Native 插件与 gdmcp CLI 已就绪'; }
  else if (tc.state === 'downloading' || tc.state === 'extracting') { badge.classList.add('warn', 'pulse'); badge.textContent = `工具链${tc.state === 'downloading' ? '下载中' : '解压中'}…`; }
  else if (tc.state === 'error') { badge.classList.add('err'); badge.textContent = '工具链未就绪'; badge.title = tc.error; badge.onclick = downloadToolchain; }
  else { badge.classList.add('warn'); badge.textContent = '工具链未初始化'; badge.onclick = downloadToolchain; }
}

async function downloadToolchain() {
  toast('开始下载工具链（插件 + gdmcp CLI）…', 'warn', 6000);
  try { await api('/api/toolchain/download', { method: 'POST' }); toast('工具链已就绪'); }
  catch (e) { toast(`工具链下载失败：${e.message}`, 'err', 8000); }
}

/* ---------- 渲染：主区 ---------- */

function render() {
  if (!S.state) return;
  renderSidebar();
  const main = $('#main');
  main.textContent = '';

  const project = getProject();
  if (!project) {
    main.append(buildWelcome());
    return;
  }
  main.append(buildProjectView(project));
  renderTabContent(project);
}

function buildWelcome() {
  const tcReady = S.state.toolchain.state === 'ready';
  const wrap = h('div', { class: 'welcome' },
    h('h1', { text: 'Godot 多开管理器' }),
    h('div', { text: 'Godot-MCP-Native + gdmcp CLI · 多项目 / 多实例并行 · 无头引擎一键启停' }),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', text: '＋ 新建项目（自动配置 MCP）', onclick: openNewProjectModal }),
      h('button', { class: 'btn', text: '添加已有项目', onclick: openAddProjectModal })),
    h('div', { class: 'steps' },
      h('div', {}, h('b', { text: '1. ' }), '新建项目会自动安装 Godot-MCP-Native 插件与 gdmcp CLI 并分配独立端口'),
      h('div', {}, h('b', { text: '2. ' }), '已有项目点「一键配置 MCP 环境」即可完成同样的安装'),
      h('div', {}, h('b', { text: '3. ' }), '编辑器 / 无头 / 游戏 三种模式随时启动与切换，终端实时查看输出'),
      h('div', {}, h('b', { text: '4. ' }), '调试面板通过 gdmcp 查看 doctor、编辑器状态、日志与运行时场景树'),
      h('div', { style: `color:${tcReady ? 'var(--green)' : 'var(--yellow)'};margin-top:4px` },
        tcReady ? '● 工具链已就绪' : '● 工具链未就绪，点击右上角徽章下载')));
  return wrap;
}

function buildProjectView(p) {
  const frag = h('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column' });

  // 头部
  const running = p.instances.filter((i) => i.status === 'running');
  const envBadges = [];
  if (p.env.addonNative) envBadges.push(h('span', { class: 'badge ok', text: 'MCP 插件' }));
  else if (p.env.addonLegacy) envBadges.push(h('span', { class: 'badge warn', text: '检测到旧版插件' }));
  else envBadges.push(h('span', { class: 'badge err', text: '未装 MCP 插件' }));
  if (p.env.gdmcpInstalled) envBadges.push(h('span', { class: 'badge ok', text: 'gdmcp CLI' }));
  else envBadges.push(h('span', { class: 'badge err', text: '未装 gdmcp' }));

  frag.append(h('div', { class: 'proj-header' },
    h('div', { class: 'title' },
      h('span', { text: p.name }),
      h('span', { class: 'chip', text: `MCP :${p.port ?? '未分配'}`, title: '点击修改端口', style: 'cursor:pointer', onclick: openPortModal }),
      ...envBadges),
    h('div', { class: 'path', text: p.path }),
    h('div', { class: 'action-bar' },
      h('button', { class: 'btn primary', text: '▶ 启动编辑器', onclick: () => launch('editor') }),
      h('button', { class: 'btn primary', text: '⬛ 启动无头引擎', onclick: () => launch('headless') }),
      h('button', { class: 'btn', text: '🎮 运行游戏', onclick: () => launch('game') }),
      h('button', { class: 'btn danger', text: '⏹ 全部停止', disabled: running.length === 0, onclick: stopAll }),
      h('span', { style: 'flex:1' }),
      h('button', { class: 'btn', text: '🔧 一键配置 MCP 环境', onclick: () => configureProject(false) }),
      h('button', { class: 'btn', text: '端口设置', onclick: openPortModal }))));

  // 实例条：构建期直接向局部元素填充（此时还未挂载 DOM，不能走全局查询）
  const strip = h('div', { class: 'instance-strip', id: 'instanceStrip' });
  renderInstanceStrip(p, strip);
  frag.append(strip);

  // 标签栏
  const tabBar = h('div', { class: 'tab-bar' });
  for (const [key, label] of [['terminal', '终端'], ['debug', '调试'], ['overview', '概览']]) {
    tabBar.append(h('button', {
      class: `tab-btn ${S.tab === key ? 'active' : ''}`,
      text: label,
      onclick: () => { S.tab = key; render(); },
    }));
  }
  frag.append(tabBar);
  frag.append(h('div', { class: 'tab-content', id: 'tabContent' }));
  return frag;
}

function renderInstanceStrip(p, strip) {
  strip.textContent = '';
  if (!p.instances.length) {
    strip.append(h('span', { style: 'color:var(--muted);font-size:12.5px', text: '暂无实例 — 使用上方按钮启动编辑器、无头引擎或游戏' }));
    return;
  }
  for (const inst of p.instances) {
    const isRun = inst.status === 'running';
    const modeColor = { editor: 'var(--accent)', headless: '#b18cff', game: 'var(--green)' }[inst.mode];
    const chip = h('div', { class: `instance-chip ${isRun ? 'running' : ''}` },
      h('span', { class: `dot ${isRun ? 'g' : 'off'}` }),
      h('span', { text: inst.modeLabel, style: `color:${modeColor};font-weight:600` }),
      inst.port ? h('span', { class: 'chip', text: `:${inst.port}${inst.ephemeralPort ? '*' : ''}`, title: inst.ephemeralPort ? '临时端口（项目端口被其他实例占用）' : '项目 MCP 端口' }) : null,
      isRun ? h('span', { class: 'pid', text: `PID ${inst.pid}` }) : h('span', { class: 'pid', text: inst.exitCode != null ? `退出 ${inst.exitCode}` : '' }),
      h('span', { class: 'btns' },
        (inst.mode === 'editor' || inst.mode === 'headless') && isRun
          ? h('button', { class: 'btn small', text: inst.mode === 'editor' ? '切无头' : '切编辑器', title: '一键切换运行模式', onclick: () => switchMode(inst) })
          : null,
        h('button', { class: 'btn small', text: '终端', onclick: () => { S.tab = 'terminal'; S.termSel = inst.id; render(); } }),
        isRun ? h('button', { class: 'btn small danger', text: '停止', onclick: () => stopInstance(inst.id) }) : null));
    strip.append(chip);
  }
}

/* ---------- 标签页内容 ---------- */

function renderTabContent(p) {
  const el = $('#tabContent');
  if (!el) return;
  const key = `${p.id}:${S.tab}`;
  el.textContent = '';
  if (S.tab === 'terminal') el.append(buildTerminal(p));
  else if (S.tab === 'debug') el.append(buildDebug(p));
  else el.append(buildOverview(p));
  S.builtKey = key;
}

function buildTerminal(p) {
  // 默认选中：上次选择 > 最新运行中 > 最新
  const ids = p.instances.map((i) => i.id);
  if (!ids.includes(S.termSel)) {
    const run = p.instances.find((i) => i.status === 'running');
    S.termSel = (run ?? p.instances[p.instances.length - 1])?.id ?? null;
  }
  const selInst = p.instances.find((i) => i.id === S.termSel);
  const title = h('span', {
    id: 'termTitle',
    text: selInst ? `${selInst.modeLabel} · ${selInst.projectName} · ${selInst.status === 'running' ? `PID ${selInst.pid}` : '已退出'}` : '—',
  });

  const list = h('div', { class: 'term-list', id: 'termList' });
  renderTermList(p, list);

  const body = h('div', { class: 'term-body', id: 'termBody' });
  const main = h('div', { class: 'term-main' },
    h('div', { class: 'term-toolbar' },
      title,
      h('span', { style: 'flex:1' }),
      selInst && selInst.status === 'running'
        ? h('button', { class: 'btn small danger', text: '⏹ 停止此实例', onclick: () => stopInstance(selInst.id) })
        : h('button', { class: 'btn small danger', text: '⏹ 停止此实例', disabled: true }),
      h('label', { style: 'cursor:pointer' }, h('input', { type: 'checkbox', checked: S.follow, onchange: (e) => (S.follow = e.target.checked) }), ' 自动滚动'),
      h('button', { class: 'btn small ghost', text: '复制', onclick: () => { const buf = logBuf(S.termSel); copyText(buf.lines.map((l) => l.text).join('\n')); } }),
      h('button', { class: 'btn small ghost', text: '清屏', onclick: () => { const buf = logBuf(S.termSel); if (buf) { buf.lines = []; buf.rendered = 0; rebuildTermBody(); } } })),
    body);

  if (S.termSel) {
    syncHistory(S.termSel).then(rebuildTermBody);
  } else {
    body.append(h('div', { class: 'term-empty', text: '启动一个实例后，这里会实时显示它的终端输出' }));
  }
  return h('div', { class: 'term-wrap' }, list, main);
}

function renderTermList(p, list) {
  list.textContent = '';
  if (!p.instances.length) {
    list.append(h('div', { class: 'empty-hint', text: '暂无实例' }));
    return;
  }
  for (const inst of p.instances) {
    const isRun = inst.status === 'running';
    list.append(h('div', {
      class: `term-item ${inst.id === S.termSel ? 'active' : ''}`,
      onclick: () => { S.termSel = inst.id; render(); },
    },
      h('span', { class: `dot ${isRun ? 'g' : 'off'}` }),
      h('span', { class: 'label', text: `${inst.modeLabel}${inst.port ? ' :' + inst.port : ''}` }),
      h('span', { style: 'color:var(--muted);font-size:11px', text: fmtTime(inst.startedAt) })));
  }
}

function buildDebug(p) {
  const toolbar = h('div', { class: 'debug-toolbar' });
  const kinds = [['doctor', 'Doctor 诊断'], ['editor_state', '编辑器状态'], ['logs', '调试日志'], ['runtime_tree', '运行时场景树']];
  for (const [kind, label] of kinds) {
    toolbar.append(h('button', {
      class: `btn small ${S.debugKind === kind ? 'primary' : ''}`,
      text: label,
      onclick: () => { S.debugKind = kind; S.debugData = null; S.debugErr = null; render(); fetchDebug(); },
    }));
  }
  toolbar.append(h('span', { style: 'flex:1' }));
  toolbar.append(h('button', {
    class: 'btn small primary', text: '▶ 调试运行', title: '通过 MCP 实例启动游戏（带调试会话，运行时场景树/性能数据可用）',
    onclick: () => gameAction('run'),
  }));
  toolbar.append(h('button', { class: 'btn small danger', text: '⏹ 停止游戏', onclick: () => gameAction('stop') }));
  toolbar.append(h('label', {}, '自动刷新 ',
    h('select', { onchange: (e) => setDebugAuto(parseInt(e.target.value, 10)) },
      h('option', { value: '0', text: '关闭' }),
      h('option', { value: '2', text: '2 秒' }),
      h('option', { value: '5', text: '5 秒' }),
      h('option', { value: '10', text: '10 秒' }))));

  const body = h('div', { class: 'debug-body', id: 'debugBody' },
    h('div', { class: 'placeholder', text: '点击上方按钮，通过项目内 gdmcp CLI 获取该实例的调试信息' }));

  const wrap = h('div', { class: 'debug-wrap' }, toolbar, body);
  if (S.debugData || S.debugErr) paintDebug(body); // 构建期直接画进局部元素（尚未挂载，不能全局查询）
  if (S.debugAuto) setDebugAuto(S.debugAuto, true);
  return wrap;
}

function setDebugAuto(sec, silent = false) {
  S.debugAuto = sec;
  clearInterval(S.debugTimer);
  if (sec > 0) S.debugTimer = setInterval(fetchDebug, sec * 1000);
  if (!silent) fetchDebug();
}

async function fetchDebug() {
  const p = getProject();
  if (!p) return;
  try {
    const res = await api(`/api/projects/${p.id}/debug?kind=${S.debugKind}`);
    S.debugData = res;
    S.debugErr = null;
  } catch (e) {
    S.debugErr = e.message;
    S.debugData = null;
  }
  paintDebug();
}

async function gameAction(action) {
  const p = getProject();
  if (!p) return;
  try {
    const res = await api(`/api/projects/${p.id}/game/${action}`, { method: 'POST' });
    if (res.ok) toast(action === 'run' ? '游戏已启动（调试会话）' : '游戏已停止');
    else toast(res.error || '操作失败', 'err', 6000);
    if (S.debugKind === 'runtime_tree') setTimeout(fetchDebug, 1500);
  } catch (e) { toast(e.message, 'err', 6000); }
}

function paintDebug(body) {
  body = body ?? $('#debugBody');
  if (!body) return;
  body.textContent = '';
  if (S.debugErr) {
    body.append(h('div', { class: 'debug-error', text: S.debugErr }));
    return;
  }
  const res = S.debugData;
  if (!res) return;
  if (res.ok) {
    body.append(h('div', { style: 'color:var(--green);margin-bottom:8px', text: `✓ ${res.kind} · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}` }));
    body.append(jsonTree(res.data ?? res.raw));
  } else {
    body.append(h('div', { style: 'color:var(--red);margin-bottom:8px', text: `✗ ${res.kind} 调用失败` }));
    if (res.error) body.append(h('div', { class: 'debug-error', text: res.error }));
    if (res.stdout) body.append(h('div', { class: 'ln dim', text: res.stdout }));
  }
}

function jsonTree(value) {
  return buildJson(value, 0);

  function buildJson(v, depth) {
    if (v === null || v === undefined) return h('span', { class: 'json-null', text: 'null' });
    if (typeof v === 'string') return h('span', { class: 'json-str', text: JSON.stringify(v) });
    if (typeof v === 'number') return h('span', { class: 'json-num', text: String(v) });
    if (typeof v === 'boolean') return h('span', { class: 'json-bool', text: String(v) });

    const entries = Array.isArray(v)
      ? v.map((item, i) => [String(i), item])
      : Object.entries(v);
    const label = Array.isArray(v) ? `Array(${v.length})` : `Object(${entries.length})`;
    const details = h('details', { open: depth < 2 },
      h('summary', {}, label));
    for (const [k, val] of entries) {
      const row = h('div', { class: 'json-row' });
      row.append(h('span', { class: 'json-key', text: JSON.stringify(k) + ': ' }), buildJson(val, depth + 1));
      details.append(row);
    }
    return details;
  }
}

function buildOverview(p) {
  const endpoint = `http://127.0.0.1:${p.port}/mcp`;
  const check = (ok, label, hint) => h('div', { class: `check ${ok ? 'ok' : 'bad'}` },
    h('span', { class: 'icon', text: ok ? '✔' : '✘' }), h('span', { text: label }), hint ? h('span', { class: 'hint', text: hint }) : null);

  return h('div', { class: 'overview' },
    h('div', { class: 'section' },
      h('h3', { text: '项目信息' }),
      h('div', { class: 'kv' },
        h('div', { class: 'k', text: '项目名称' }), h('div', { class: 'v', text: p.name }),
        h('div', { class: 'k', text: '路径' }), h('div', { class: 'v', text: p.path }),
        h('div', { class: 'k', text: 'MCP 端口' }), h('div', { class: 'v' }, h('span', { text: String(p.port ?? '未分配') }), p.port ? h('button', { class: 'btn small ghost', text: '复制端点', onclick: () => copyText(endpoint) }) : null),
        h('div', { class: 'k', text: 'MCP 端点' }), h('div', { class: 'v', text: p.port ? endpoint : '—' }),
        h('div', { class: 'k', text: 'gdmcp 调用方式' }), h('div', { class: 'v', text: '.gdmcp/bin/gdmcp.exe（项目根目录运行，自动发现端口）' }))),

    h('div', { class: 'section' },
      h('h3', { text: 'MCP 环境检查' }),
      check(p.env.addonNative, 'Godot-MCP-Native 插件已安装', p.env.addonLegacy ? '检测到旧版 DaxianLee 插件，一键配置会自动替换为新版' : null),
      check(p.env.addonEnabled, '插件已在 project.godot 中启用'),
      check(p.env.gdmcpInstalled, 'gdmcp CLI 已安装到 .gdmcp/bin'),
      check(!!(p.env.mcpCfg && p.env.mcpCfg.httpPort), 'mcp_settings.cfg 已写入端口', p.env.mcpCfg ? `user://mcp_settings.cfg → http_port=${p.env.mcpCfg.httpPort ?? '未设置'}` : '尚未生成'),
      !p.env.addonNative || !p.env.gdmcpInstalled || !p.env.mcpCfg
        ? h('button', { class: 'btn primary', style: 'margin-top:10px', text: '🔧 现在一键配置', onclick: () => configureProject(false) }) : null),

    h('div', { class: 'section' },
      h('h3', { text: '运行环境' }),
      h('div', { class: 'kv' },
        h('div', { class: 'k', text: 'Godot' }), h('div', { class: 'v', text: S.state.settings.godotPath || '未配置（点右上角设置）' }),
        h('div', { class: 'k', text: '工具链' }), h('div', { class: 'v', text: `Godot-MCP-Native ${S.state.toolchain.version} · ${S.state.toolchain.state}` }),
        h('div', { class: 'k', text: '端口基址' }), h('div', { class: 'v', text: String(S.state.settings.portBase) }),
        h('div', { class: 'k', text: '实例记录' }), h('div', { class: 'v', text: `${p.instances.filter((i) => i.status === 'running').length} 运行中 / ${p.instances.length} 总计` }))));
}

/* ---------- 操作 ---------- */

const lastLaunchAt = new Map(); // `${projectId}:${mode}` -> 时间戳；1.5 秒内的重复点击视为手滑

async function launch(mode) {
  const p = getProject();
  if (!p) return;
  const key = `${p.id}:${mode}`;
  const last = lastLaunchAt.get(key);
  if (last !== undefined && Date.now() - last < 1500) {
    toast('刚点过启动，已忽略重复点击；确实要多开请稍后再点', 'warn');
    return;
  }
  lastLaunchAt.set(key, Date.now());
  try {
    if (mode !== 'game' && !p.env.addonNative) {
      const yes = await confirmDialog('该项目尚未安装 MCP 插件', '启动前先执行「一键配置 MCP 环境」？（安装插件 + gdmcp CLI + 分配端口）');
      if (!yes) return;
      await configureProject(true);
    }
    await api('/api/instances', { method: 'POST', body: { projectId: p.id, mode } });
    S.tab = 'terminal';
    render();
    toast(`${{ editor: '编辑器', headless: '无头引擎', game: '游戏' }[mode]}已启动`);
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function stopInstance(id) {
  try { await api(`/api/instances/${id}`, { method: 'DELETE' }); toast('实例已停止'); }
  catch (e) { toast(e.message, 'err'); }
}

async function stopAll() {
  const p = getProject();
  if (!p) return;
  const running = p.instances.filter((i) => i.status === 'running');
  if (!running.length) return;
  if (!(await confirmDialog(`停止「${p.name}」的全部 ${running.length} 个实例？`))) return;
  for (const inst of running) {
    try { await api(`/api/instances/${inst.id}`, { method: 'DELETE' }); } catch (e) { toast(e.message, 'err'); }
  }
  toast('已全部停止');
}

async function switchMode(inst) {
  const target = inst.mode === 'editor' ? 'headless' : 'editor';
  toast(`正在切换到${target === 'headless' ? '无头' : '编辑器'}模式…`, 'warn');
  try {
    await api(`/api/instances/${inst.id}/switch`, { method: 'POST', body: { mode: target } });
    toast(`已切换为${target === 'headless' ? '无头引擎' : '编辑器'}`);
  } catch (e) { toast(e.message, 'err'); }
}

async function configureProject(silent) {
  const p = getProject();
  if (!p) return;
  if (!silent) {
    const yes = await confirmDialog('一键配置 MCP 环境？', `将执行：安装 Godot-MCP-Native 插件 → 启用插件 → 安装 gdmcp CLI 到 .gdmcp/bin → 写入端口 ${p.port ?? '（自动分配）'} 到 mcp_settings.cfg`);
    if (!yes) return;
  }
  toast('正在配置 MCP 环境…', 'warn');
  try {
    await api(`/api/projects/${p.id}/configure`, { method: 'POST', body: {} });
    toast('MCP 环境配置完成 ✓');
  } catch (e) { toast(`配置失败：${e.message}`, 'err', 6000); }
}

/* ---------- 模态框 ---------- */

function openModal({ title, body, actions = [] }) {
  const root = $('#modalRoot');
  const overlay = h('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) close(); } });
  const close = () => overlay.remove();
  const foot = h('div', { class: 'modal-foot' });
  for (const a of actions) {
    foot.append(h('button', {
      class: `btn ${a.class ?? ''}`,
      text: a.label,
      onclick: async () => { if (!a.onClick || (await a.onClick(close)) !== false) if (a.close !== false) close(); },
    }));
  }
  overlay.append(h('div', { class: 'modal' },
    h('h2', { text: title }),
    h('div', { class: 'modal-body' }, body),
    actions.length ? foot : null));
  root.append(overlay);
  return { close, overlay };
}

function confirmDialog(title, message) {
  return new Promise((resolve) => {
    openModal({
      title,
      body: [h('div', { text: message ?? '', style: 'color:var(--muted);font-size:13.5px;line-height:1.7' })],
      actions: [
        { label: '取消', onClick: () => { resolve(false); } },
        { label: '确定', class: 'primary', onClick: () => { resolve(true); } },
      ],
    });
  });
}

function formRow(label, inputEl, hint) {
  const row = h('div', { class: 'form-row' }, h('label', { text: label }), inputEl);
  if (hint) row.append(h('div', { class: 'hint', text: hint }));
  return row;
}

function openNewProjectModal() {
  const defaultParent = getProject()?.path?.replace(/[\\/][^\\/]+$/, '') ?? 'K:\\Programing';
  const nameInput = h('input', { type: 'text', placeholder: '例如 MyGame' });
  const parentInput = h('input', { type: 'text', value: defaultParent });
  const rendererSel = h('select', {},
    h('option', { value: 'forward_plus', text: 'Forward Plus（桌面默认）' }),
    h('option', { value: 'mobile', text: 'Mobile' }),
    h('option', { value: 'gl_compatibility', text: 'GL Compatibility（轻量）' }));
  const portInput = h('input', { type: 'number', placeholder: `留空自动分配（基址 ${S.state.settings.portBase}）` });

  openModal({
    title: '新建项目（自动配置 MCP 环境）',
    body: [
      formRow('项目名称', nameInput),
      formRow('创建位置', parentInput, '项目目录 = 创建位置 / 项目名称'),
      formRow('渲染器', rendererSel),
      formRow('MCP 端口', portInput, '每个项目独立端口，gdmcp CLI 会自动发现'),
    ],
    actions: [
      { label: '取消' },
      {
        label: '创建并配置', class: 'primary',
        onClick: async (close) => {
          const body = { name: nameInput.value, parentDir: parentInput.value, renderer: rendererSel.value };
          const port = parseInt(portInput.value, 10);
          if (port) body.port = port;
          try {
            const { project } = await api('/api/projects/create', { method: 'POST', body });
            S.selected = project.id;
            S.tab = 'terminal';
            render();
            toast(`项目「${project.name}」已创建，MCP 端口 ${project.port}`);
          } catch (e) { toast(e.message, 'err', 6000); return false; }
        },
      },
    ],
  });
  nameInput.focus();
}

function openAddProjectModal() {
  const pathInput = h('input', { type: 'text', placeholder: 'K:\\Programing\\你的项目（包含 project.godot 的目录）' });
  openModal({
    title: '添加已有项目',
    body: [formRow('项目路径', pathInput, '添加后可一键为其配置 MCP 环境（插件 + gdmcp CLI + 端口）')],
    actions: [
      { label: '取消' },
      {
        label: '添加', class: 'primary',
        onClick: async () => {
          try {
            const { project } = await api('/api/projects', { method: 'POST', body: { path: pathInput.value } });
            S.selected = project.id;
            render();
            toast(`已添加「${project.name}」，端口 ${project.port}`);
          } catch (e) { toast(e.message, 'err', 6000); return false; }
        },
      },
    ],
  });
  pathInput.focus();
}

function openPortModal() {
  const p = getProject();
  if (!p) return;
  const input = h('input', { type: 'number', value: p.port ?? '' });
  openModal({
    title: `端口设置 — ${p.name}`,
    body: [
      formRow('MCP 端口', input, `修改会同步写入 mcp_settings.cfg 并在下次启动通过 --mcp-port 传入；当前配置文件端口：${p.env.mcpCfg?.httpPort ?? '未写入'}`),
      h('div', { class: 'hint', text: '提示：修改端口前需停止该项目的编辑器/无头实例；端口需未被其他项目或进程占用。' }),
    ],
    actions: [
      { label: '取消' },
      {
        label: '保存', class: 'primary',
        onClick: async () => {
          const port = parseInt(input.value, 10);
          if (!port) { toast('请输入端口', 'err'); return false; }
          try {
            await api(`/api/projects/${p.id}/port`, { method: 'PUT', body: { port } });
            toast(`端口已设置为 ${port}`);
          } catch (e) { toast(e.message, 'err', 6000); return false; }
        },
      },
    ],
  });
}

function openSettingsModal() {
  const st = S.state.settings;
  const godotInput = h('input', { type: 'text', value: st.godotPath ?? '', placeholder: 'godot.windows.opt.tools.64.exe 完整路径' });
  const detectBtn = h('button', { class: 'btn small', text: '检测', onclick: async () => {
    try {
      const { detectedGodot } = await api('/api/settings');
      if (detectedGodot) { godotInput.value = detectedGodot; toast(`检测到：${detectedGodot}`); }
      else toast('未检测到 Godot，请手动填写路径', 'warn');
    } catch (e) { toast(e.message, 'err'); }
  } });
  const portBaseInput = h('input', { type: 'number', value: st.portBase });
  const proxyInput = h('input', { type: 'text', value: st.proxy ?? '', placeholder: '例如 http://127.0.0.1:7890，留空直连' });

  openModal({
    title: '设置',
    body: [
      formRow('Godot 可执行文件', h('div', { class: 'form-inline' }, godotInput, detectBtn), '启动编辑器 / 无头引擎 / 游戏使用的引擎'),
      formRow('端口基址', portBaseInput, '新建项目自动分配端口的起始值'),
      formRow('下载代理', proxyInput, '用于从 GitHub 下载插件与 gdmcp CLI'),
      h('div', { class: 'hint', text: `Web 界面端口：${st.webPort}（修改 data/config.json 后重启生效）` }),
    ],
    actions: [
      { label: '取消' },
      {
        label: '保存', class: 'primary',
        onClick: async () => {
          try {
            await api('/api/settings', { method: 'POST', body: { godotPath: godotInput.value, portBase: parseInt(portBaseInput.value, 10), proxy: proxyInput.value } });
            toast('设置已保存');
          } catch (e) { toast(e.message, 'err'); return false; }
        },
      },
    ],
  });
}

/* ---------- 启动 ---------- */

$('#btnSettings').addEventListener('click', openSettingsModal);
$('#btnNewProject').addEventListener('click', openNewProjectModal);
$('#btnAddProject').addEventListener('click', openAddProjectModal);

(async function init() {
  try {
    S.state = await api('/api/state');
  } catch (e) {
    document.body.prepend(h('div', { style: 'padding:12px 20px;color:var(--red)', text: `无法连接服务：${e.message}` }));
  }
  connectSSE();
  render();
})();

// 调试钩子（浏览器控制台 / 自动化冒烟测试用）
if (typeof window !== 'undefined') window.__gmm = { S, render, fetchDebug, gameAction, launch };
