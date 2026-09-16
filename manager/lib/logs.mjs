import fs from 'node:fs';
import path from 'node:path';
import { LOGS_DIR } from './config.mjs';

const MAX_LINES = 8000; // 内存中保留的行数（终端回放用）

// 每个实例一个日志存储：内存环形数组 + 落盘追加
export class LogStore {
  constructor(instanceId) {
    this.instanceId = instanceId;
    this.lines = []; // { t, stream: 'out'|'err', text }
    this.filePath = path.join(LOGS_DIR, `${instanceId}.log`);
    try {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
      this.file = fs.openSync(this.filePath, 'a');
    } catch (e) {
      console.error('[logs] 无法创建日志文件:', e.message);
    }
  }

  push(batch) {
    // batch: [{stream, text}]
    const stamped = batch.map((l) => ({ t: Date.now(), stream: l.stream, text: l.text }));
    this.lines.push(...stamped);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    if (this.file !== undefined) {
      try {
        fs.writeSync(this.file, stamped.map((l) => `${l.stream === 'err' ? '[stderr] ' : ''}${l.text}\n`).join(''));
      } catch { /* 磁盘写入失败不影响运行 */ }
    }
    return stamped;
  }

  history(lastN = MAX_LINES) {
    return this.lines.slice(-lastN);
  }

  close() {
    if (this.file !== undefined) {
      try { fs.closeSync(this.file); } catch { /* ignore */ }
      this.file = undefined;
    }
  }
}

// 把流数据切成整行（保留不完整尾部），返回完整行数组
export function splitLines(carry, chunk) {
  const text = carry + chunk;
  const parts = text.split(/\r?\n/);
  const rest = parts.pop(); // 最后一段可能不完整
  return { lines: parts, rest };
}
