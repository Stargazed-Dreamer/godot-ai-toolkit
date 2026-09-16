import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as config from './lib/config.mjs';
import * as toolchain from './lib/toolchain.mjs';
import * as projects from './lib/projects.mjs';
import * as gdmcp from './lib/gdmcp.mjs';
import { killOrphanGameProcesses } from './lib/gdmcp.mjs';
import { instanceManager } from './lib/instances.mjs';
import { bus } from './lib/bus.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

const cfg = config.load();

// ---------- 状态聚合 ----------

function buildState() {
  const state = config.get();
  return {
    settings: { ...state.settings },
    toolchain: toolchain.getStatus(),
    projects: state.projects.map((p) => ({
      ...projects.projectSummary(p),
      env: projects.detectEnv(p.path),
      instances: instanceManager.listByProject(p.id),
    })),
  };
}

// ---------- SSE ----------

const sseClients = new Set();

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcastState() {
  const payload = buildState();
  for (const res of sseClients) sseSend(res, 'state', payload);
}

bus.on('dirty', broadcastState);
bus.on('log', (evt) => {
  for (const res of sseClients) sseSend(res, 'log', evt);
});
toolchain.onStatus(() => broadcastState());

// ---------- HTTP 基础设施 ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const abs = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!abs.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  let target = abs;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    // SPA 回退
    target = path.join(PUBLIC_DIR, 'index.html');
  }
  if (!fs.existsSync(target)) { res.writeHead(404); res.end('Not Found'); return; }
  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(target).pipe(res);
}

// ---------- 路由 ----------

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  // SSE 事件流
  if (method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    sseSend(res, 'state', buildState());
    const hb = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
    return;
  }

  // ---- 全局 ----
  if (method === 'GET' && pathname === '/api/state') return sendJson(res, 200, buildState());

  if (method === 'GET' && pathname === '/api/settings') {
    return sendJson(res, 200, { settings: config.get().settings, detectedGodot: config.detectGodot() });
  }
  if (method === 'POST' && pathname === '/api/settings') {
    const body = await readBody(req);
    const settings = config.updateSettings(body);
    broadcastState();
    return sendJson(res, 200, { settings });
  }

  if (method === 'GET' && pathname === '/api/toolchain') return sendJson(res, 200, toolchain.getStatus());
  if (method === 'POST' && pathname === '/api/toolchain/download') {
    const st = await toolchain.ensureReady({ force: false });
    return sendJson(res, 200, st);
  }

  // ---- 项目 ----
  if (method === 'POST' && pathname === '/api/projects') {
    const body = await readBody(req);
    const project = await projects.addExistingProject(body.path ?? '');
    broadcastState();
    return sendJson(res, 200, { project });
  }

  if (method === 'POST' && pathname === '/api/projects/create') {
    const body = await readBody(req);
    const project = await projects.createProject(body);
    broadcastState();
    return sendJson(res, 200, { project });
  }

  let m = pathname.match(/^\/api\/projects\/([^/]+)(?:\/(.+))?$/);
  if (m) {
    const [, id, sub] = m;
    const project = projects.findProject(id);
    if (!project) return sendJson(res, 404, { error: '项目不存在' });

    if (method === 'DELETE' && !sub) {
      for (const inst of instanceManager.runningByProject(id)) await instanceManager.stop(inst.id);
      projects.removeProject(id);
      broadcastState();
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'POST' && sub === 'configure') {
      const body = await readBody(req);
      const result = await projects.configureProject(id, { port: body.port });
      broadcastState();
      return sendJson(res, 200, result);
    }
    if (method === 'PUT' && sub === 'port') {
      const body = await readBody(req);
      await projects.setProjectPort(id, body.port);
      broadcastState();
      return sendJson(res, 200, { ok: true, port: body.port });
    }
    if (method === 'GET' && sub === 'env') {
      return sendJson(res, 200, projects.detectEnv(project.path));
    }
    if (method === 'GET' && sub === 'debug') {
      const kind = url.searchParams.get('kind') ?? 'doctor';
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
      const depth = parseInt(url.searchParams.get('depth') ?? '4', 10);
      try {
        let result;
        if (kind === 'doctor') result = await gdmcp.doctor(project.path, project.port);
        else if (kind === 'editor_state') result = await gdmcp.editorState(project.path, project.port);
        else if (kind === 'logs') result = await gdmcp.debugLogs(project.path, project.port, limit);
        else if (kind === 'runtime_tree') result = await gdmcp.runtimeTree(project.path, project.port, depth);
        else return sendJson(res, 400, { error: `未知调试类型: ${kind}` });
        return sendJson(res, 200, { kind, ok: result.ok, data: result.data, raw: result.raw });
      } catch (e) {
        return sendJson(res, 200, { kind, ok: false, error: e.message, stdout: e.stdout ?? '', stderr: e.stderr ?? '' });
      }
    }
    if (method === 'POST' && (sub === 'game/run' || sub === 'game/stop')) {
      try {
        const editorPids = new Set(
          instanceManager.runningByProject(project.id).map((i) => i.pid)
        );
        const result = sub === 'game/run'
          ? await gdmcp.runGame(project.path, project.port)
          : await gdmcp.stopGame(project.path, project.port);
        // [gdflow] stop_project 只断调试会话不杀进程，这里清理孤儿游戏窗口
        let cleaned = 0;
        if (sub === 'game/stop') {
          cleaned = await killOrphanGameProcesses(editorPids);
          if (cleaned > 0) console.log(`[game/stop] 已清理 ${cleaned} 个孤儿游戏进程`);
        }
        return sendJson(res, 200, { ok: result.ok, data: result.data, orphan_cleaned: cleaned });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: e.message, stdout: e.stdout ?? '' });
      }
    }
  }

  // ---- 实例 ----
  if (method === 'POST' && pathname === '/api/instances') {
    const body = await readBody(req);
    const project = projects.findProject(body.projectId);
    if (!project) return sendJson(res, 404, { error: '项目不存在' });
    const mode = body.mode ?? 'headless';
    const inst = await instanceManager.launch(project, mode);
    project.lastMode = mode;
    config.save();
    broadcastState();
    return sendJson(res, 200, { instance: inst });
  }

  m = pathname.match(/^\/api\/instances\/([^/]+)(?:\/(.+))?$/);
  if (m) {
    const [, id, sub] = m;
    if (method === 'DELETE' && !sub) {
      const summary = await instanceManager.stop(id);
      broadcastState();
      return sendJson(res, 200, { instance: summary });
    }
    if (method === 'POST' && sub === 'switch') {
      const body = await readBody(req);
      const summary = await instanceManager.switchMode(id, body.mode);
      broadcastState();
      return sendJson(res, 200, { instance: summary });
    }
    if (method === 'GET' && sub === 'logs') {
      const tail = parseInt(url.searchParams.get('tail') ?? '1000', 10);
      const history = instanceManager.history(id, tail);
      if (!history) return sendJson(res, 404, { error: '实例不存在' });
      return sendJson(res, 200, { instanceId: id, lines: history });
    }
  }

  sendJson(res, 404, { error: `未知接口: ${method} ${pathname}` });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${cfg.settings.webPort}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url.pathname);
    }
  } catch (e) {
    console.error(`[api] ${req.method} ${url.pathname}:`, e.message);
    if (!res.headersSent) sendJson(res, 400, { error: e.message });
  }
});

server.listen(cfg.settings.webPort, '127.0.0.1', () => {
  console.log(`\n  Godot 多开管理器已启动`);
  console.log(`  ➜ http://127.0.0.1:${cfg.settings.webPort}`);
  console.log(`  Godot: ${cfg.settings.godotPath || '(未检测到，请在设置中配置)'}\n`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${cfg.settings.webPort} 被占用，请在 data/config.json 中修改 settings.webPort`);
    process.exit(1);
  }
  throw e;
});

// 静默初始化工具链（失败不阻塞服务，前端可手动重试）
toolchain.init();
