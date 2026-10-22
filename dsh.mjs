import fs from 'node:fs/promises';
import { settings } from './config.mjs';
import { WebSocket } from 'ws';

export const DSH_ROOT = settings.dshRoot;
const upstream = settings.dshOrigin;
const logPath = settings.dshLog;

export async function readLaunchUrl() {
  const log = await fs.readFile(logPath, 'utf8');
  const candidates = log.match(/https?:\/\/[^\s\u001b]+/g) || [];
  const launch = candidates.reverse().find(value => {
    try { const url = new URL(value); return url.origin === upstream && url.pathname === '/' && url.searchParams.has('token'); }
    catch { return false; }
  });
  if (!launch) throw new Error('未找到 DSH 启动凭据，请检查本机 dshLog 配置或重新启动 DSH。');
  return launch;
}

/** Authenticate with the existing launch token without sending it to the browser. */
export class DshConnection {
  cookie;
  authentication;
  async authenticate() {
    if (this.authentication) return this.authentication;
    this.authentication = (async () => {
      const launch = await readLaunchUrl();
      const response = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
      this.cookie = response.headers.get('set-cookie')?.split(';')[0];
      if (!this.cookie) throw new Error('DSH 登录失败，请重新启动 DeepSeek Harness 后重试。');
    })();
    try { await this.authentication; } finally { this.authentication = undefined; }
  }
  async request(endpoint, options = {}, retried = false) {
    if (!this.cookie) await this.authenticate();
    const response = await fetch(upstream + endpoint, {
      ...options,
      signal: options.signal || AbortSignal.timeout(30000),
      headers: { ...options.headers, cookie: this.cookie, origin: upstream },
    });
    if (response.status === 401 && !retried) {
      this.cookie = undefined;
      await this.authenticate();
      return this.request(endpoint, options, true);
    }
    if (!response.ok) throw new Error(`DSH 请求失败（HTTP ${response.status}）`);
    return response;
  }
  async rpc(method, args = {}) {
    const rpcId = crypto.randomUUID();
    const response = await this.request('/api/' + method, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    });
    const envelope = await response.json();
    if (envelope.rpcId !== rpcId) throw new Error('DSH 响应标识不匹配');
    if (!envelope.result?.ok) throw new Error(envelope.result?.error?.message || 'DSH 返回错误');
    return envelope.result.value;
  }
  /** Relay a single Remote stream, with teardown owned by the caller. */
  async stream(endpoint, args, onValue, onError) {
    if (!this.cookie) await this.authenticate();
    const socket = new WebSocket(upstream.replace('http:', 'ws:') + '/api/remote.mux', {
      headers: { cookie: this.cookie, origin: upstream }, handshakeTimeout: 10000,
    });
    const streamId = crypto.randomUUID();
    let stopped = false;
    socket.on('open', () => socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } })));
    socket.on('message', bytes => {
      try {
        const message = JSON.parse(bytes.toString());
        if (message.streamId !== streamId) return;
        if (message.type === 'item') onValue(message.value);
        if (message.type === 'error') onError(new Error(message.error.message));
        if (message.type === 'end' && !stopped) onError(new Error('DSH 事件流结束，请重新连接'));
      } catch (error) { onError(error); }
    });
    socket.on('error', error => { if (!stopped) onError(error); });
    socket.on('close', () => { if (!stopped) onError(new Error('与 DSH 的连接中断，正在重连')); });
    return () => {
      stopped = true;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'cancel', streamId }));
        socket.close();
      } else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    };
  }
}
