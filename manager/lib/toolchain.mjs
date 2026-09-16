import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CACHE_DIR, EXTRACT_DIR, get } from './config.mjs';

const REPO = 'yurineko73/Godot-MCP-Native';
export const TOOLCHAIN_VERSION = 'v1.0.8';

const ASSETS = {
  addon: {
    file: `godot-mcp-native-${TOOLCHAIN_VERSION.slice(1)}.zip`,
    url: `https://github.com/${REPO}/releases/download/${TOOLCHAIN_VERSION}/godot-mcp-native-${TOOLCHAIN_VERSION.slice(1)}.zip`,
    dir: path.join(EXTRACT_DIR, 'addon'),
  },
  cli: {
    file: `gdmcp-${TOOLCHAIN_VERSION.slice(1)}-x86_64-pc-windows-msvc.zip`,
    url: `https://github.com/${REPO}/releases/download/${TOOLCHAIN_VERSION}/gdmcp-${TOOLCHAIN_VERSION.slice(1)}-x86_64-pc-windows-msvc.zip`,
    dir: path.join(EXTRACT_DIR, 'gdmcp'),
  },
};

let status = {
  state: 'idle', // idle | downloading | extracting | ready | error
  error: '',
  version: TOOLCHAIN_VERSION,
  addonDir: '',
  addonName: '', // addons/ 下的插件目录名
  gdmcpExe: '',
};

let onStatusChange = () => {};

export function onStatus(fn) {
  onStatusChange = fn;
}

function set(patch) {
  status = { ...status, ...patch };
  try {
    onStatusChange(status);
  } catch { /* 广播失败不影响主流程 */ }
}

export function getStatus() {
  return { ...status };
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, ...opts });
    let out = '', err = '';
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} 退出码 ${code}: ${err || out}`.slice(0, 500)))));
  });
}

// Windows 自带 bsdtar：原生支持盘符路径与 zip；Git Bash 的 GNU tar 会把 K:\ 当远程主机
const TAR = fs.existsSync('C:\\Windows\\System32\\tar.exe') ? 'C:\\Windows\\System32\\tar.exe' : 'tar';

async function download(asset) {
  const zipPath = path.join(CACHE_DIR, asset.file);
  if (fs.existsSync(zipPath) && fs.statSync(zipPath).size > 0) return zipPath; // 手动放置或已缓存
  const proxy = get().settings.proxy?.trim();
  const baseArgs = ['-L', '--fail', '--connect-timeout', '20', '--max-time', '300', '--retry', '2', '-o', zipPath];
  const attempts = [
    ...(proxy ? [['-x', proxy]] : []),
    [], // 直连
    ['--noproxy', '*'], // 绕过环境变量里的代理
  ];
  let lastErr = null;
  for (const extra of attempts) {
    try {
      await run('curl', [...extra, ...baseArgs, asset.url]);
      if (fs.existsSync(zipPath) && fs.statSync(zipPath).size > 0) return zipPath;
      throw new Error('下载结果为空文件');
    } catch (e) {
      lastErr = e;
      try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
    }
  }
  throw new Error(`下载 ${asset.file} 失败（可手动下载后放入 ${CACHE_DIR}）: ${lastErr?.message ?? ''}`);
}

async function extract(asset) {
  fs.mkdirSync(asset.dir, { recursive: true });
  const zipPath = path.join(CACHE_DIR, asset.file);
  await run(TAR, ['-xf', zipPath, '-C', asset.dir]);
}

// 递归找文件，返回第一个匹配的绝对路径
function findFile(root, fileName) {
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isFile() && ent.name === fileName) return full;
      if (ent.isDirectory() && !ent.name.startsWith('.')) queue.push(full);
    }
  }
  return null;
}

async function inspect() {
  const pluginCfg = findFile(ASSETS.addon.dir, 'plugin.cfg');
  if (!pluginCfg) throw new Error('插件包中未找到 plugin.cfg');
  const addonDir = path.dirname(pluginCfg);
  const gdmcpExe = findFile(ASSETS.cli.dir, 'gdmcp.exe');
  if (!gdmcpExe) throw new Error('CLI 包中未找到 gdmcp.exe');
  set({ addonDir, addonName: path.basename(addonDir), gdmcpExe });
}

export function isReady() {
  return status.state === 'ready' && status.addonDir && status.gdmcpExe;
}

export async function ensureReady({ force = false } = {}) {
  if (isReady() && !force) return status;
  if (status.state === 'downloading' || status.state === 'extracting') return status;
  try {
    // 已解压过则直接复检（支持手动放置 zip / 解压产物）
    if (status.addonDir && status.gdmcpExe && fs.existsSync(status.addonDir) && fs.existsSync(status.gdmcpExe)) {
      await inspect();
      set({ state: 'ready', error: '' });
      return status;
    }
    set({ state: 'downloading', error: '' });
    await download(ASSETS.addon);
    await download(ASSETS.cli);
    set({ state: 'extracting' });
    await extract(ASSETS.addon);
    await extract(ASSETS.cli);
    await inspect();
    set({ state: 'ready', error: '' });
    return status;
  } catch (e) {
    set({ state: 'error', error: e.message });
    throw e;
  }
}

// 启动时尝试就绪（静默失败，前端可手动重试）
export async function init() {
  try {
    await ensureReady();
  } catch (e) {
    console.warn('[toolchain] 未就绪:', e.message);
  }
}
