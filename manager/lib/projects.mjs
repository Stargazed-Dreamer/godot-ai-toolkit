import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { get, save, DATA_DIR } from './config.mjs';
import { ensureReady, getStatus } from './toolchain.mjs';
import { instanceManager } from './instances.mjs';
import { emitDirty } from './bus.mjs';
import { isFreePort, findFreePort, isValidPort } from './ports.mjs';

const PLUGIN_RES = 'res://addons/godot_mcp/plugin.cfg';
const GODOT_MINOR = '4.7';

// ---------- project.godot 解析 ----------

export function readProjectFile(projectPath) {
  const file = path.join(projectPath, 'project.godot');
  if (!fs.existsSync(file)) return null;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function parseProjectName(projectPath) {
  const text = readProjectFile(projectPath);
  if (text) {
    const m = text.match(/^config\/name\s*=\s*"(.*)"\s*$/m);
    if (m && m[1].trim()) return m[1];
  }
  return path.basename(projectPath);
}

// Godot 用项目名作为 user:// 目录名，非法字符会被替换
function sanitizeName(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').trim() || 'unnamed';
}

export function userDataDir(projectPath) {
  return path.join(process.env.APPDATA ?? '', 'Godot', 'app_userdata', sanitizeName(parseProjectName(projectPath)));
}

export function mcpCfgPath(projectPath) {
  return path.join(userDataDir(projectPath), 'mcp_settings.cfg');
}

// ---------- mcp_settings.cfg 读写 ----------
// 格式（源码 settings_manager.gd / config_manager.gd）：ConfigFile INI，
// [meta] version；[settings] 各键；校验和键省略时配置仍被接受。

export function readMcpCfg(projectPath) {
  const file = mcpCfgPath(projectPath);
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const info = { path: file, httpPort: null, transportMode: null, autoStart: null };
  const port = text.match(/^http_port\s*=\s*(\d+)\s*$/m);
  if (port) info.httpPort = parseInt(port[1], 10);
  const mode = text.match(/^transport_mode\s*=\s*"?(\w+)"?\s*$/m);
  if (mode) info.transportMode = mode[1];
  const auto = text.match(/^auto_start\s*=\s*(\w+)\s*$/m);
  if (auto) info.autoStart = auto[1] === 'true';
  return info;
}

export function writeMcpCfg(projectPath, httpPort) {
  const file = mcpCfgPath(projectPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const defaults = [
    'transport_mode="http"',
    `http_port=${httpPort}`,
    'auth_enabled=false',
    'auth_token=""',
    'sse_enabled=true',
    'allow_remote=false',
    'cors_origin="*"',
    'auto_start=true',
    'log_level=2',
    'security_level=1',
    'rate_limit=100',
    'language="en"',
  ];
  let body;
  if (fs.existsSync(file)) {
    // 已有配置只更新端口，保留用户自定义项
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const out = [];
    let inSettings = false;
    let sawPort = false;
    for (const line of lines) {
      if (/^\[.+\]\s*$/.test(line)) inSettings = line.trim() === '[settings]';
      if (inSettings && /^http_port\s*=/.test(line)) {
        out.push(`http_port=${httpPort}`);
        sawPort = true;
      } else {
        out.push(line);
      }
    }
    if (!sawPort) {
      const idx = out.findIndex((l) => l.trim() === '[settings]');
      if (idx >= 0) out.splice(idx + 1, 0, `http_port=${httpPort}`);
      else out.push('', '[settings]', `http_port=${httpPort}`);
    }
    body = out.join('\n');
  } else {
    body = ['[meta]', '', 'version=1', '', '[settings]', '', ...defaults, ''].join('\n');
  }
  fs.writeFileSync(file, body.endsWith('\n') ? body : body + '\n', 'utf8');
  return file;
}

// ---------- project.godot 插件启用 ----------

export function enablePluginInProject(projectPath) {
  const file = path.join(projectPath, 'project.godot');
  if (!fs.existsSync(file)) throw new Error('project.godot 不存在');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

  // 定位 [editor_plugins] 节
  let sectionIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '[editor_plugins]') { sectionIdx = i; break; }
  }

  if (sectionIdx === -1) {
    // 无节：追加
    const append = ['', '[editor_plugins]', '', `enabled=PackedStringArray("${PLUGIN_RES}")`];
    const text = lines.join('\n').replace(/\s*$/, '');
    fs.writeFileSync(file, text + '\n' + append.join('\n') + '\n', 'utf8');
    return;
  }

  // 找 enabled= 行（属于该节）
  let enabledIdx = -1;
  for (let i = sectionIdx + 1; i < lines.length; i++) {
    if (/^\[.+\]\s*$/.test(lines[i])) break;
    if (/^enabled\s*=/.test(lines[i])) { enabledIdx = i; break; }
  }

  if (enabledIdx === -1) {
    lines.splice(sectionIdx + 1, 0, `enabled=PackedStringArray("${PLUGIN_RES}")`);
  } else {
    const cur = lines[enabledIdx];
    if (cur.includes(PLUGIN_RES)) return; // 已启用
    const m = cur.match(/^enabled\s*=\s*PackedStringArray\((.*)\)\s*$/);
    if (!m) {
      lines[enabledIdx] = `enabled=PackedStringArray("${PLUGIN_RES}")`;
    } else if (m[1].trim() === '') {
      lines[enabledIdx] = `enabled=PackedStringArray("${PLUGIN_RES}")`;
    } else {
      lines[enabledIdx] = `enabled=PackedStringArray(${m[1].trim()}, "${PLUGIN_RES}")`;
    }
  }
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
}

// ---------- 环境探测 ----------

export function detectEnv(projectPath) {
  const addonDir = path.join(projectPath, 'addons', 'godot_mcp');
  const pluginCfg = path.join(addonDir, 'plugin.cfg');
  const isNative = fs.existsSync(path.join(addonDir, 'native_mcp'));
  const projectText = readProjectFile(projectPath) ?? '';
  const cfgInfo = readMcpCfg(projectPath);
  return {
    hasProject: !!projectText,
    addonNative: isNative && fs.existsSync(pluginCfg),
    addonLegacy: !isNative && fs.existsSync(pluginCfg), // 旧版 DaxianLee 插件（同目录名）
    addonEnabled: projectText.includes(PLUGIN_RES),
    gdmcpInstalled: fs.existsSync(path.join(projectPath, '.gdmcp', 'bin', 'gdmcp.exe')),
    mcpCfg: cfgInfo,
    legacySettings: fs.existsSync(path.join(userDataDir(projectPath), 'godot_mcp_settings.json')),
  };
}

// ---------- 安装 ----------

function installAddon(projectPath) {
  const st = getStatus();
  const target = path.join(projectPath, 'addons', 'godot_mcp');
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(st.addonDir, target, { recursive: true });
}

function installGdmcp(projectPath) {
  const st = getStatus();
  const binDir = path.join(projectPath, '.gdmcp', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(st.gdmcpExe, path.join(binDir, 'gdmcp.exe'));
}

// ---------- 注册表操作 ----------

export function registerProject(rawPath) {
  const projectPath = path.resolve(rawPath.trim().replace(/^"|"$/g, ''));
  if (!fs.existsSync(path.join(projectPath, 'project.godot'))) {
    throw new Error(`未找到 project.godot：${projectPath}`);
  }
  const cfg = get();
  if (cfg.projects.some((p) => path.resolve(p.path).toLowerCase() === projectPath.toLowerCase())) {
    throw new Error('该项目已在管理器中');
  }
  const used = new Set(cfg.projects.map((p) => p.port));
  const project = {
    id: crypto.randomUUID().slice(0, 8),
    name: parseProjectName(projectPath),
    path: projectPath,
    port: null,
    createdAt: Date.now(),
    lastMode: 'headless',
  };
  return { project, used };
}

export async function assignPort(project) {
  const cfg = get();
  const used = new Set(cfg.projects.map((p) => p.port));
  project.port = await findFreePort(cfg.settings.portBase, used);
}

export function findProject(id) {
  return get().projects.find((p) => p.id === id);
}

// 一键配置 MCP 环境（新建项目与已有项目共用）
export async function configureProject(projectId, { port } = {}) {
  const project = findProject(projectId);
  if (!project) throw new Error('项目不存在');

  const running = instanceManager.runningByProject(projectId).filter((i) => i.mode !== 'game');
  if (running.length) throw new Error('请先停止该项目的编辑器/无头实例再重新配置');

  await ensureReady();
  if (port !== undefined) {
    await setProjectPort(projectId, port, { skipSave: true });
  }
  if (!project.port) await assignPort(project);

  installAddon(project.path);
  enablePluginInProject(project.path);
  installGdmcp(project.path);
  writeMcpCfg(project.path, project.port);
  project.configuredAt = Date.now();
  save();
  emitDirty('project-configured');
  return { ...projectSummary(project), env: detectEnv(project.path) };
}

export async function setProjectPort(projectId, port, { skipSave = false } = {}) {
  const project = findProject(projectId);
  if (!project) throw new Error('项目不存在');
  if (!isValidPort(port)) throw new Error('端口必须在 1024–65535 之间');
  const cfg = get();
  if (cfg.projects.some((p) => p.id !== projectId && p.port === port)) {
    throw new Error(`端口 ${port} 已分配给其他项目`);
  }
  const running = instanceManager.runningByProject(projectId).filter((i) => i.mode !== 'game');
  if (running.length) throw new Error('请先停止该项目实例再修改端口');
  if (!(await isFreePort(port))) throw new Error(`端口 ${port} 当前被占用`);
  project.port = port;
  writeMcpCfg(project.path, port);
  if (!skipSave) save();
  emitDirty('project-port');
}

export function removeProject(projectId) {
  const cfg = get();
  const idx = cfg.projects.findIndex((p) => p.id === projectId);
  if (idx === -1) throw new Error('项目不存在');
  cfg.projects.splice(idx, 1);
  save();
  emitDirty('project-removed');
}

export function projectSummary(project) {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    port: project.port,
    createdAt: project.createdAt,
    configuredAt: project.configuredAt ?? null,
    lastMode: project.lastMode ?? 'headless',
  };
}

// ---------- 新建项目 ----------

const RENDERERS = {
  forward_plus: { feature: 'Forward Plus', method: 'forward_plus' },
  mobile: { feature: 'Mobile', method: 'mobile' },
  gl_compatibility: { feature: 'GL Compatibility', method: 'gl_compatibility' },
};

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
<rect width="128" height="128" rx="24" fill="#202531"/>
<circle cx="64" cy="64" r="28" fill="none" stroke="#4f8cff" stroke-width="10"/>
<circle cx="64" cy="28" r="9" fill="#4f8cff"/>
<circle cx="95" cy="80" r="9" fill="#4f8cff"/>
<circle cx="33" cy="80" r="9" fill="#4f8cff"/>
</svg>
`;

const MAIN_TSCN = `[gd_scene format=3]

[node name="Main" type="Node2D"]
`;

// 首次导入：生成 .godot 缓存，让"运行游戏"开箱即用（Godot 4.2+ 支持 --import）
function runImport(projectPath) {
  const godotPath = get().settings.godotPath;
  if (!godotPath) return { ok: false, skipped: true };
  return new Promise((resolve) => {
    const child = spawn(godotPath, ['--headless', '--import', '--path', projectPath], { windowsHide: true });
    let out = '';
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    const timer = setTimeout(() => { try { child.kill(); } catch { } resolve({ ok: false, error: '导入超时' }); }, 180000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, error: code === 0 ? null : out.slice(-800) }); });
  });
}

export async function createProject({ name, parentDir, renderer = 'forward_plus', port }) {
  if (!name?.trim()) throw new Error('项目名不能为空');
  if (!/^[^<>:"/\\|?*]+$/.test(name.trim())) throw new Error('项目名包含非法字符');
  const parent = parentDir?.trim() || path.dirname(DATA_DIR);
  const projectPath = path.join(parent, name.trim());
  if (fs.existsSync(projectPath) && fs.readdirSync(projectPath).length > 0) {
    throw new Error(`目录已存在且非空：${projectPath}`);
  }
  const r = RENDERERS[renderer] ?? RENDERERS.forward_plus;

  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'icon.svg'), ICON_SVG, 'utf8');
  fs.writeFileSync(path.join(projectPath, 'main.tscn'), MAIN_TSCN, 'utf8');
  const projectGodot = [
    '; Engine configuration file.',
    '; Generated by godot-multi-manager.',
    '',
    'config_version=5',
    '',
    '[application]',
    '',
    `config/name="${name.trim()}"`,
    `config/features=PackedStringArray("${GODOT_MINOR}", "${r.feature}")`,
    'run/main_scene="res://main.tscn"',
    'config/icon="res://icon.svg"',
    '',
    '[rendering]',
    '',
    `renderer/rendering_method="${r.method}"`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(projectPath, 'project.godot'), projectGodot, 'utf8');

  const { project } = registerProject(projectPath);
  get().projects.push(project);
  await configureProject(project.id, { port });
  const imported = await runImport(projectPath);
  if (!imported.ok && !imported.skipped) {
    // 导入失败不阻塞（首次启动编辑器/无头时会再次导入），仅提示
    console.warn(`[projects] 首次导入警告 (${name}):`, imported.error ?? '');
  }
  return { ...projectSummary(project), importSkipped: imported.skipped ?? false };
}

// 注册并持久化（供 API 添加已有项目用）
export async function addExistingProject(rawPath) {
  const { project, used } = registerProject(rawPath);
  const cfg = get();
  const port = await findFreePort(cfg.settings.portBase, used);
  project.port = port;
  cfg.projects.push(project);
  save();
  emitDirty('project-added');
  return projectSummary(project);
}
