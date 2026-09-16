// 前端回归冒烟测试 v2
// 与 v1 的区别：DOM 桩是真实树结构（appendChild/querySelector 走树、属性独立存储），
// 能捕获两类真实 bug：① 元素未挂载时全局查询返回 null 导致内容不渲染；
// ② disabled/checked 等布尔属性被 setAttribute('disabled', false) 误禁用。
// 需先启动服务端（node server.mjs）。

let failures = 0;
function ok(cond, msg) {
  if (cond) console.log('✓', msg);
  else { failures++; console.error('✗', msg); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 迷你 DOM（树结构） ---------- */

class El {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attrs = {};
    this._cls = new Set();
    this.style = {};
    this._text = '';
    this.parentNode = null;
    this.listeners = {};
  }
  get nodeType() { return this.tagName === '#text' ? 3 : 1; } // h() 依赖 nodeType 区分元素与文本
  append(...kids) {
    for (const k of kids.flat(2)) {
      if (k === null || k === undefined) continue;
      k.parentNode = this;
      this.children.push(k);
    }
  }
  prepend(kid) { kid.parentNode = this; this.children.unshift(kid); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this._cls].join(' '); }
  get classList() {
    const self = this;
    return {
      add: (...cs) => cs.forEach((c) => self._cls.add(c)),
      remove: (...cs) => cs.forEach((c) => self._cls.delete(c)),
      contains: (c) => self._cls.has(c),
    };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return k in this.attrs; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  get firstElementChild() { return this.children[0] ?? null; }
  get childElementCount() { return this.children.length; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  click() { for (const fn of this.listeners.click ?? []) fn({ target: this, stopPropagation() {} }); }
  focus() { }
  querySelector(sel) { return this._query(sel); }
  _query(sel) {
    for (const c of this.children) {
      if (this._match(c, sel)) return c;
      const r = c._query(sel);
      if (r) return r;
    }
    return null;
  }
  _match(el, sel) {
    if (sel.startsWith('#')) return el.attrs.id === sel.slice(1);
    if (sel.startsWith('.')) return el._cls.has(sel.slice(1));
    return el.tagName === sel;
  }
}

function el(tag, id) { const e = new El(tag); if (id) e.attrs.id = id; return e; }

// 按 index.html 搭建静态骨架
const root = el('body');
{
  const badge = el('div', 'toolchainBadge');
  const btnSettings = el('button', 'btnSettings');
  const topbar = el('header', 'topbar');
  topbar.append(el('div'), badge, el('div'), btnSettings);

  const btnNew = el('button', 'btnNewProject');
  const btnAdd = el('button', 'btnAddProject');
  const actions = el('div');
  actions.append(btnNew, btnAdd);
  const projectList = el('div', 'projectList');
  const sidebar = el('aside', 'sidebar');
  sidebar.append(actions, projectList);

  const main = el('main', 'main');
  const layout = el('div', 'layout');
  layout.append(sidebar, main);

  root.append(topbar, layout, el('div', 'toasts'), el('div', 'modalRoot'));
}

globalThis.document = {
  createElement: (t) => new El(t),
  createTextNode: (t) => { const e = new El('#text'); e._text = String(t); return e; },
  createDocumentFragment: () => new El('#fragment'),
  querySelector: (sel) => root._query(sel),
  body: root,
};
globalThis.window = globalThis;
globalThis.EventSource = class { constructor() { } addEventListener() { } };
try { globalThis.navigator = { clipboard: { writeText: async () => {} } }; } catch { /* Node 24 navigator 为 getter-only */ }

// 浏览器相对路径 fetch → Node 绝对 URL
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (url, opts) => realFetch(String(url).startsWith('/') ? 'http://127.0.0.1:17890' + url : url, opts);

function walk(node, fn) { for (const c of node.children) { fn(c); walk(c, fn); } }
function findByText(rootEl, text) {
  let out = null;
  walk(rootEl, (c) => { if (!out && c._text === text) out = c; });
  return out;
}

/* ---------- 执行 app.js ---------- */

await import('../public/app.js');
await sleep(1200); // init: fetch state + render welcome

const gmm = globalThis.__gmm;
ok(!!gmm, '__gmm 钩子暴露');
ok(!!gmm.S.state, 'init 拉取到 state');

const project = gmm.S.state.projects[0];
ok(!!project, '服务端存在项目');
if (!project) process.exit(1);
const P = () => gmm.S.state.projects[0];
const main = () => document.querySelector('#main');

// 保证服务端有至少一个运行实例（真实数据走 UI 断言；服务器重启后内存记录为空是正常场景）
if (!P().instances.some((i) => i.status === 'running')) {
  await fetch('/api/instances', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: P().id, mode: 'headless' }),
  });
  await sleep(400);
  gmm.S.state = await (await fetch('/api/state')).json();
}
ok(P().instances.some((i) => i.status === 'running'), '服务端已有运行实例');

gmm.S.selected = P().id;
gmm.render();

/* ---------- 1. 实例条渲染（挂载时序 bug 回归） ---------- */

const strip = main().querySelector('#instanceStrip');
ok(!!strip, '实例条元素存在');
ok(strip && strip.childElementCount === P().instances.length,
  `实例条渲染了 ${strip?.childElementCount}/${P().instances.length} 个实例卡片（含停止按钮）`);
ok(strip && strip.childElementCount > 0 && !!findByText(strip, '停止'), '实例卡片上有「停止」按钮');

/* ---------- 2. 全部停止按钮（布尔属性 bug 回归） ---------- */

const anyRunning = P().instances.some((i) => i.status === 'running');
{
  const btn = findByText(main(), '⏹ 全部停止');
  ok(!!btn, '「全部停止」按钮存在');
  if (btn && anyRunning) ok(!btn.hasAttribute('disabled'), '有运行实例时「全部停止」可点击（无 disabled 属性）');
  if (btn && !anyRunning) ok(btn.hasAttribute('disabled'), '无运行实例时「全部停止」禁用');
}
// 反向用例：本地把状态改为全部退出 → 按钮必须带 disabled
{
  for (const i of P().instances) i.status = 'exited';
  gmm.render();
  const btn = findByText(main(), '⏹ 全部停止');
  ok(!!btn && btn.hasAttribute('disabled'), '全部退出后「全部停止」变为禁用');
}

/* ---------- 3. 终端标签页（挂载时序 + 停止此实例按钮） ---------- */

gmm.S.tab = 'terminal';
P().instances[0].status = 'running';
P().instances[0].pid = 4321;
gmm.S.termSel = P().instances[0].id;
gmm.S.follow = false;
gmm.render();

const termList = main().querySelector('#termList');
ok(termList && termList.childElementCount === P().instances.length,
  `终端实例列表渲染 ${termList?.childElementCount}/${P().instances.length} 项`);
const stopBtn = findByText(main(), '⏹ 停止此实例');
ok(!!stopBtn, '终端工具栏有「停止此实例」按钮');
ok(!!stopBtn && !stopBtn.hasAttribute('disabled'), '选中运行实例时「停止此实例」可点击');
const title = main().querySelector('#termTitle');
ok(!!title && title.textContent.includes('PID 4321'), `终端标题正确（${title?.textContent}）`);
{
  let input = null;
  walk(main(), (c) => { if (!input && c.tagName === 'input') input = c; });
  ok(!!input && !input.hasAttribute('checked'), 'S.follow=false 时自动滚动勾选框不带 checked 属性');
}
gmm.S.follow = true;

// 选中已退出实例 → 停止按钮应禁用
{
  P().instances[0].status = 'exited';
  gmm.render();
  const b = findByText(main(), '⏹ 停止此实例');
  ok(!!b && b.hasAttribute('disabled'), '选中已退出实例时「停止此实例」禁用');
  P().instances[0].status = 'running';
}

/* ---------- 4. 调试 / 概览标签页 ---------- */

gmm.S.tab = 'debug';
gmm.render();
ok(!!findByText(main(), 'Doctor 诊断'), '调试标签页渲染');
gmm.S.tab = 'overview';
gmm.render();
ok(!!findByText(main(), 'MCP 环境检查'), '概览标签页渲染');

/* ---------- 5. UI 启动按钮真实点击（防抖逻辑回归） ---------- */

gmm.S.state = await (await fetch('/api/state')).json();
const beforeCount = P().instances.filter((i) => i.status === 'running').length;
{
  const toasts = document.querySelector('#toasts');
  gmm.S.tab = 'terminal';
  gmm.render();
  const launchBtn = findByText(main(), '⬛ 启动无头引擎');
  ok(!!launchBtn, '「启动无头引擎」按钮存在');

  launchBtn.click(); // 第一次点击：必须真正启动，不能弹防抖提示
  await sleep(900);
  const debounceToast = findByText(toasts, '刚点过启动，已忽略重复点击；确实要多开请稍后再点');
  ok(!debounceToast, '第一次点击不会被防抖拦截');
  const st1 = await (await fetch('/api/state')).json();
  const count1 = st1.projects[0].instances.filter((i) => i.status === 'running').length;
  ok(count1 === beforeCount + 1, `第一次点击后运行实例 +1（${beforeCount} → ${count1}）`);

  launchBtn.click(); // 立刻第二次：应被防抖拦截，实例数不变
  await sleep(600);
  const debounceToast2 = findByText(toasts, '刚点过启动，已忽略重复点击；确实要多开请稍后再点');
  ok(!!debounceToast2, '1.5 秒内第二次点击被防抖拦截并提示');
  const st2 = await (await fetch('/api/state')).json();
  const count2 = st2.projects[0].instances.filter((i) => i.status === 'running').length;
  ok(count2 === count1, `被拦截后运行实例数不变（仍为 ${count2}）`);
}

/* ---------- 6. 真实「全部停止」交互（点击 → 确认框 → API 停止） ---------- */

// 以服务端真实状态为准
gmm.S.state = await (await fetch('/api/state')).json();
const pid = P().id;
let runningOnServer = P().instances.filter((i) => i.status === 'running');
if (!runningOnServer.length) {
  await fetch(`/api/instances`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: pid, mode: 'headless' }) });
  await sleep(300);
  gmm.S.state = await (await fetch('/api/state')).json();
  runningOnServer = P().instances.filter((i) => i.status === 'running');
}
ok(runningOnServer.length > 0, `服务端有运行实例（${runningOnServer.length} 个）`);

gmm.S.tab = 'terminal';
gmm.render();
const stopAllBtn = findByText(main(), '⏹ 全部停止');
ok(!!stopAllBtn && !stopAllBtn.hasAttribute('disabled'), '全部停止按钮处于可点击状态');
stopAllBtn.click();
await sleep(100);
const modalRoot = document.querySelector('#modalRoot');
const confirmBtn = modalRoot ? findByText(modalRoot, '确定') : null;
ok(!!confirmBtn, '点击后弹出确认对话框');
if (confirmBtn) {
  confirmBtn.click();
  let stopped = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const st = await (await fetch('/api/state')).json();
    if (st.projects[0].instances.every((x) => x.status !== 'running')) { stopped = true; break; }
  }
  ok(stopped, '确认后全部实例已停止（服务端状态归零）');
}

/* ---------- 7. 收尾：重新拉起一个演示实例 ---------- */

{
  const res = await fetch(`/api/instances`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: pid, mode: 'headless' }) });
  const data = await res.json();
  ok(data.instance?.status === 'running', `已重新拉起演示无头实例（端口 ${data.instance?.port}）`);
}

console.log(failures ? `\n${failures} 项失败` : '\n冒烟测试全部通过');
process.exit(failures ? 1 : 0);
