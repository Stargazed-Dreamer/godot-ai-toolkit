import { spawn } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import { get } from './config.mjs';
import { LogStore, splitLines } from './logs.mjs';
import { emitLog, emitDirty } from './bus.mjs';
import { findFreePort, isFreePort } from './ports.mjs';

const KEEP_PER_PROJECT = 6; // 每个项目保留的实例记录数（含已退出的，用于终端回放）

class InstanceManager {
  constructor() {
    this.instances = new Map(); // id -> record
  }

  list() {
    return [...this.instances.values()].map(summarize);
  }

  get(id) {
    return this.instances.get(id);
  }

  listByProject(projectId) {
    return [...this.instances.values()].filter((i) => i.projectId === projectId).map(summarize);
  }

  runningByProject(projectId) {
    return [...this.instances.values()].filter((i) => i.projectId === projectId && i.status === 'running');
  }

  usedPorts() {
    const set = new Set();
    for (const i of this.instances.values()) {
      if (i.status === 'running' && i.port) set.add(i.port);
    }
    return set;
  }

  // 端口策略：优先项目固定端口；被本项目其他实例占用、或被系统任意进程占用
  // （含服务器重启后遗留的孤儿 Godot 进程）时，自动分配临时端口。
  async resolvePort(project) {
    const occupied = this.usedPorts();
    if (!occupied.has(project.port) && (await isFreePort(project.port))) {
      return { port: project.port, ephemeral: false };
    }
    const registryPorts = new Set(get().projects.map((p) => p.port));
    const port = await findFreePort(project.port, new Set([...registryPorts, ...occupied]));
    return { port, ephemeral: true };
  }

  async launch(project, mode) {
    if (!['editor', 'headless', 'game'].includes(mode)) throw new Error(`未知模式: ${mode}`);
    const godotPath = get().settings.godotPath;
    if (!godotPath) throw new Error('未配置 Godot 可执行文件路径，请先在设置中指定');

    let port = null;
    let ephemeral = false;
    let args = ['--path', project.path];
    if (mode === 'game') {
      args = ['--path', project.path];
    } else {
      const resolved = await this.resolvePort(project);
      port = resolved.port;
      ephemeral = resolved.ephemeral;
      args = [
        ...(mode === 'headless' ? ['--headless'] : []),
        '--editor',
        '--path', project.path,
        '--',
        '--mcp-server',
        `--mcp-port=${port}`,
      ];
    }

    const id = crypto.randomUUID().slice(0, 8);
    const rec = {
      id,
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      mode,
      port,
      ephemeralPort: ephemeral,
      pid: null,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      logs: new LogStore(id),
    };
    this.instances.set(id, rec);
    this._prune(project.id);

    try {
      const child = spawn(godotPath, args, {
        cwd: project.path,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      rec.pid = child.pid;
      rec.child = child;
      this._wirePipes(rec, child);
      child.on('exit', (code) => this._onExit(rec, code));
      child.on('error', (err) => {
        this._append(rec, [{ stream: 'err', text: `[manager] 进程启动失败: ${err.message}` }]);
        this._onExit(rec, 1);
      });
    } catch (e) {
      this.instances.delete(id);
      throw new Error(`启动失败: ${e.message}`);
    }

    this._append(rec, [{
      stream: 'out',
      text: `[manager] 启动 ${modeLabel(mode)}${port ? ` (MCP 端口 ${port}${ephemeral ? '，临时' : ''})` : ''}: ${path.basename(godotPath)} ${args.join(' ')}`,
    }]);
    emitDirty('instance-launched');
    return summarize(rec);
  }

  _wirePipes(rec, child) {
    const carries = { out: '', err: '' };
    const handle = (streamName, nodeStream) => {
      nodeStream.setEncoding('utf8');
      nodeStream.on('data', (chunk) => {
        const { lines, rest } = splitLines(carries[streamName], chunk);
        carries[streamName] = rest;
        if (lines.length) this._append(rec, lines.map((text) => ({ stream: streamName, text })));
      });
      nodeStream.on('close', () => {
        if (carries[streamName]) {
          this._append(rec, [{ stream: streamName, text: carries[streamName] }]);
          carries[streamName] = '';
        }
      });
    };
    handle('out', child.stdout);
    handle('err', child.stderr);
  }

  _append(rec, batch) {
    const stamped = rec.logs.push(batch);
    emitLog(rec.id, stamped);
  }

  _onExit(rec, code) {
    if (rec.status !== 'running') return;
    rec.status = 'exited';
    rec.endedAt = Date.now();
    rec.exitCode = code;
    this._append(rec, [{ stream: 'out', text: `[manager] 进程已退出 (code=${code})` }]);
    emitDirty('instance-exited');
  }

  async stop(id) {
    const rec = this.instances.get(id);
    if (!rec) throw new Error('实例不存在');
    if (rec.status !== 'running') return summarize(rec);
    if (!rec.pid) throw new Error('实例尚无 PID');

    // Windows 下递归终止进程树（Godot 编辑器会派生导入子进程）
    await new Promise((resolve) => {
      const tk = spawn('taskkill', ['/PID', String(rec.pid), '/T', '/F'], { windowsHide: true });
      tk.on('close', () => resolve());
      tk.on('error', () => resolve());
    });
    // 等待 exit 事件（正常由子进程退出触发）
    const deadline = Date.now() + 10000;
    while (rec.status === 'running' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
    }
    if (rec.status === 'running') {
      // taskkill 失败的兜底
      try { rec.child?.kill(); } catch { /* ignore */ }
      this._onExit(rec, -1);
    }
    return summarize(rec);
  }

  // 编辑器 ⇄ 无头 一键切换：停止当前实例，同端口以新模式重启
  async switchMode(id, newMode) {
    const rec = this.instances.get(id);
    if (!rec) throw new Error('实例不存在');
    if (!['editor', 'headless'].includes(rec.mode) || !['editor', 'headless'].includes(newMode)) {
      throw new Error('只有编辑器/无头实例支持模式切换');
    }
    if (rec.mode === newMode) return summarize(rec);
    const project = get().projects.find((p) => p.id === rec.projectId);
    if (!project) throw new Error('项目已从管理器移除');
    await this.stop(id);
    return this.launch(project, newMode);
  }

  history(id, lastN) {
    const rec = this.instances.get(id);
    if (!rec) return null;
    return rec.logs.history(lastN);
  }

  _prune(projectId) {
    const recs = [...this.instances.values()]
      .filter((i) => i.projectId === projectId)
      .sort((a, b) => b.startedAt - a.startedAt);
    for (const old of recs.slice(KEEP_PER_PROJECT)) {
      if (old.status === 'running') continue; // 运行中的不清理
      old.logs.close();
      this.instances.delete(old.id);
    }
  }
}

function modeLabel(mode) {
  return { editor: '编辑器', headless: '无头引擎', game: '游戏' }[mode] ?? mode;
}

function summarize(rec) {
  return {
    id: rec.id,
    projectId: rec.projectId,
    projectName: rec.projectName,
    mode: rec.mode,
    modeLabel: modeLabel(rec.mode),
    port: rec.port,
    ephemeralPort: rec.ephemeralPort,
    pid: rec.pid,
    status: rec.status,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    exitCode: rec.exitCode,
    lineCount: rec.logs.lines.length,
  };
}

export const instanceManager = new InstanceManager();
