import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = path.join(ROOT, 'data');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const EXTRACT_DIR = path.join(CACHE_DIR, 'extracted');
export const LOGS_DIR = path.join(DATA_DIR, 'logs');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  settings: {
    godotPath: '',
    portBase: 19080,
    webPort: 17890,
    proxy: '',
    language: 'zh',
  },
  projects: [],
};

let state = null;

function deepMerge(base, override) {
  const out = structuredClone(base);
  for (const key of Object.keys(override ?? {})) {
    if (override[key] && typeof override[key] === 'object' && !Array.isArray(override[key])) {
      out[key] = deepMerge(out[key] ?? {}, override[key]);
    } else {
      out[key] = override[key];
    }
  }
  return out;
}

export function load() {
  for (const dir of [DATA_DIR, CACHE_DIR, EXTRACT_DIR, LOGS_DIR]) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      state = deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    } catch (e) {
      console.error('[config] 读取失败，使用默认配置:', e.message);
      state = structuredClone(DEFAULTS);
    }
  } else {
    state = structuredClone(DEFAULTS);
  }
  if (!state.settings.godotPath) {
    const detected = detectGodot();
    if (detected) state.settings.godotPath = detected;
  }
  save();
  return state;
}

export function get() {
  if (!state) load();
  return state;
}

export function save() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(state, null, 2), 'utf8');
}

export function updateSettings(patch) {
  const cfg = get();
  for (const key of ['godotPath', 'proxy', 'language']) {
    if (typeof patch[key] === 'string') cfg.settings[key] = patch[key];
  }
  for (const key of ['portBase', 'webPort']) {
    if (Number.isInteger(patch[key])) cfg.settings[key] = patch[key];
  }
  save();
  return cfg.settings;
}

// Godot 编辑器可执行文件探测：Steam 库 + 常规安装位置
export function detectGodot() {
  const candidates = [];
  const drives = ['C', 'D', 'E', 'F', 'G', 'J', 'K', 'L'];
  for (const d of drives) {
    candidates.push(`${d}:\\SteamLibrary\\steamapps\\common\\Godot Engine\\godot.windows.opt.tools.64.exe`);
    candidates.push(`${d}:\\Steam\\steamapps\\common\\Godot Engine\\godot.windows.opt.tools.64.exe`);
  }
  candidates.push(
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Godot', 'godot.windows.opt.tools.64.exe'),
    'C:\\Program Files\\Godot\\godot.windows.opt.tools.64.exe',
  );
  for (const exe of [`${os.homedir()}\\scoop\\apps\\godot\\current\\godot.windows.opt.tools.64.exe`, ...candidates]) {
    if (exe && fs.existsSync(exe)) return exe;
  }
  return '';
}
