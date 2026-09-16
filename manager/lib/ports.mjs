import net from 'node:net';

// 探测 127.0.0.1 上端口是否空闲（能否绑定监听）
export function isFreePort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

// 从 start 开始找一个空闲且不在排除集合中的端口
export async function findFreePort(start, exclude = new Set()) {
  let port = start;
  for (let i = 0; i < 200; i++) {
    if (!exclude.has(port) && (await isFreePort(port))) return port;
    port++;
  }
  throw new Error(`从 ${start} 起连续 200 个端口均被占用`);
}

export function isValidPort(port) {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}
