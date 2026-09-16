import { EventEmitter } from 'node:events';

// 全局事件总线：实例日志 / 状态变化通过它广播到 SSE 客户端
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export function emitLog(instanceId, lines) {
  bus.emit('log', { instanceId, lines });
}

export function emitDirty(reason) {
  bus.emit('dirty', reason);
}
