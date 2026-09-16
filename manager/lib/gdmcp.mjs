import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// 调用项目本地 gdmcp CLI（.gdmcp/bin/gdmcp.exe）。
// 官方的"一一对应"机制：项目根目录运行时自动发现 project.godot → user://mcp_settings.cfg → http_port。
// 但用户机器上可能存在默认 9080 的其他实例（或多实例并存），因此管理器始终显式传 --url
// 绑定到该项目的固定端口，保证确定性的一对一。

export function localCli(projectPath) {
  return path.join(projectPath, '.gdmcp', 'bin', 'gdmcp.exe');
}

export function runGdmcp(projectPath, args, { port = null, timeoutMs = 25000 } = {}) {
  const exe = localCli(projectPath);
  if (!fs.existsSync(exe)) {
    return Promise.reject(new Error('项目未安装 gdmcp CLI（先执行一键配置 MCP 环境）'));
  }
  const finalArgs = port ? ['--url', `http://127.0.0.1:${port}`, ...args] : args;
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['--json', ...finalArgs], {
      cwd: projectPath,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error(`gdmcp 命令超时（${timeoutMs}ms）: gdmcp ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // --json 输出主体为 JSON；若混入日志行则截取首个 { 或 [
      const trimmed = out.trim();
      const start = trimmed.search(/[[{]/);
      if (start > 0) out = trimmed.slice(start);
      if (code === 0 && out) {
        try {
          resolve({ ok: true, data: JSON.parse(out), raw: out });
        } catch {
          resolve({ ok: true, data: null, raw: out });
        }
      } else {
        const e = new Error(err.trim() || out.trim() || `gdmcp 退出码 ${code}`);
        e.exitCode = code;
        e.stdout = out;
        e.stderr = err;
        reject(e);
      }
    });
  });
}

export async function doctor(projectPath, port) {
  return runGdmcp(projectPath, ['doctor'], { port });
}

export async function editorState(projectPath, port) {
  return runGdmcp(projectPath, ['editor', 'state'], { port });
}

export async function debugLogs(projectPath, port, limit = 50) {
  return runGdmcp(projectPath, ['debug', 'logs', '--limit', String(Math.min(Math.max(limit, 1), 500))], { port });
}

export async function runtimeTree(projectPath, port, depth = 4) {
  return runGdmcp(projectPath, ['runtime', 'tree', '--depth', String(Math.min(Math.max(depth, 1), 8))], { port });
}

// 调试运行：通过该项目 MCP 实例的 run_project/stop_project 工具启动/停止游戏。
// 由编辑器实例拉起的游戏自带调试会话（EngineDebugger 激活），runtime probe 可用，
// 运行时场景树 / 运行时节点读取随之生效；直接启动（godot --path）则没有调试会话。
export async function runGame(projectPath, port) {
  // allow_window: 绕过插件的 Vibe Coding 窗口管控策略
  return runGdmcp(projectPath, ['tool-call', 'run_project', '--args-json', '{"allow_window":true}', '--apply'], { port, timeoutMs: 60000 });
}

export async function stopGame(projectPath, port) {
  return runGdmcp(projectPath, ['tool-call', 'stop_project', '--args-json', '{"allow_window":true}', '--apply'], { port, timeoutMs: 60000 });
}

// [gdflow] 清理孤儿游戏窗口进程：游戏由编辑器实例经 run_project 拉起，stop_project 只断
// 调试会话不杀进程，留下仍在运行的窗口。这里杀掉「父进程为该项目编辑器实例」的全部子进程。
// editorPids: 该项目 running 编辑器实例 PID 集合（来自 instanceManager）。
export function killOrphanGameProcesses(editorPids) {
  const pids = [...editorPids];
  if (!pids.length) return Promise.resolve(0);
  const list = pids.join(',');
  const ps =
    `Get-CimInstance Win32_Process -Filter "Name='godot.windows.opt.tools.64.exe'" | ` +
    `Where-Object { @(${list}) -contains $_.ParentProcessId -and @(${list}) -notcontains $_.ProcessId } | ` +
    `ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }`;
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', ps], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(0));
    child.on('close', () => resolve(out.split('\n').filter((l) => l.trim()).length));
  });
}
