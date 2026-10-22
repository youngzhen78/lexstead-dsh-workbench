import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { DshConnection } from './dsh.mjs';
import { settings } from './config.mjs';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE = settings.stateDir;
const WORK = settings.workspace;
const PUBLIC = ROOT;
const PORT = settings.port;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const dsh = new DshConnection();
let data;
let writing = Promise.resolve();
const catalog = JSON.parse(await fs.readFile(path.join(PUBLIC, 'catalog.json'), 'utf8'));
const pendingInteractions = new Map();
const interactionClients = new Set();
let eventClientId;
let eventsStop;
let eventsRetry;

function publishInteractions() {
  const values = [...pendingInteractions.values()].map(({ clientId, ...value }) => value);
  for (const res of interactionClients) if (!res.destroyed) res.write(`event: interactions\ndata: ${JSON.stringify(values)}\n\n`);
}
async function connectEvents() {
  let failed = false;
  const failure = () => {
    if (failed) return;
    failed = true; eventsStop?.(); pendingInteractions.clear(); publishInteractions();
    clearTimeout(eventsRetry); eventsRetry = setTimeout(connectEvents, 3000); eventsRetry.unref();
  };
  try {
    eventsStop = await dsh.stream('$events', {}, frame => {
      if (frame.type === 'ready') { eventClientId = frame.clientId; return; }
      if (frame.type === 'cancel') { pendingInteractions.delete(frame.eventId); publishInteractions(); }
      if (frame.type === 'emit' && frame.event === 'api-session/error' && data.tasks.some(t => t.id === frame.args[0])) {
        for (const res of interactionClients) if (!res.destroyed) res.write(`event: session-error\ndata: ${JSON.stringify({ id: frame.args[0], error: frame.args[1] })}\n\n`);
      }
      if (frame.type === 'waterfall') {
        const own = data.tasks.some(t => t.id === frame.agentId);
        if (own && ['approval/request', 'user-questions/request'].includes(frame.event)) {
          pendingInteractions.set(frame.eventId, { ...frame, clientId: eventClientId }); publishInteractions();
        } else {
          dsh.rpc('$events/result', { clientId: eventClientId, eventId: frame.eventId, outcome: { kind: 'next' } }).catch(failure);
        }
      }
    }, failure);
  } catch { failure(); }
}

const json = (res, value, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
};
function persist() {
  const snapshot = JSON.stringify(data, null, 2) + '\n';
  writing = writing.catch(() => {}).then(async () => {
    const tmp = path.join(STATE, 'workbench.json.tmp');
    await fs.writeFile(tmp, snapshot, { mode: 0o600 });
    await fs.rename(tmp, path.join(STATE, 'workbench.json'));
  });
  return writing;
}
async function readBody(req, max = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Object.assign(new Error('文件或请求超过大小限制'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function requireTask(id) {
  const task = data.tasks.find(t => t.id === id);
  if (!task) throw Object.assign(new Error('未找到本工作台的委托'), { status: 404 });
  return task;
}
function requireText(value, max = 500000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('请输入有效内容');
  return value.trim();
}
export async function safeWorkspaceFile(relative) {
  const base = await fs.realpath(WORK);
  const candidate = await fs.realpath(path.resolve(WORK, relative));
  if (!candidate.startsWith(base + path.sep)) throw Object.assign(new Error('文件超出工作目录'), { status: 403 });
  const stat = await fs.stat(candidate);
  if (!stat.isFile()) throw new Error('不是可下载的文件');
  return { candidate, stat };
}
async function files(dir = WORK, prefix = '') {
  const result = [];
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    if (item.name.startsWith('.')) continue;
    const relative = path.join(prefix, item.name);
    if (item.isDirectory()) result.push(...await files(path.join(dir, item.name), relative));
    else if (item.isFile()) {
      const stat = await fs.stat(path.join(dir, item.name));
      result.push({ name: item.name, path: relative, bytes: stat.size, updatedAt: stat.mtimeMs });
    }
  }
  return result.sort((a, b) => b.updatedAt - a.updatedAt);
}
function taskPrompt(task, text) {
  const agent = catalog.agents.find(a => a.id === task.agentId);
  return [
    '你是 Lexstead 律师工作台的工作助手。请用中文完成用户委托。',
    agent ? `当前工作入口：${agent.short}。任务目标：${agent.tag}。` : '',
    '只使用用户提供的材料、当前工作目录的文件及实际可用的工具。不要编造律师履历、案例、来源、法条或完成状态。材料不足时明确待确认并询问。法律判断与对外文件需律师复核。',
    '未经用户明确要求，不发送邮件、发布内容或联系第三方。不要把模板入口当作已安装的专用 Skill 或数据库连接器。',
    `本次任务文件目录：${path.join(WORK, task.id)}。需要生成文件时保存在此目录，提供相对工作目录的 Markdown 下载链接。`,
    `期望成果：${task.output || '自动'}。`,
    '以下为用户本次委托：', text,
  ].filter(Boolean).join('\n\n');
}
async function exportDocument(req, res, body) {
  const task = requireTask(body.id);
  const text = requireText(body.text);
  const name = (body.title || '工作成果').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 90);
  const exportDir = path.join(WORK, task.id, '导出成果');
  await fs.mkdir(exportDir, { recursive: true });
  const realExportDir = await fs.realpath(exportDir);
  if (!realExportDir.startsWith(await fs.realpath(WORK) + path.sep)) throw new Error('导出目录超出工作空间');
  const suffix = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID().slice(0, 8);
  if (body.format !== 'docx') {
    await fs.writeFile(path.join(realExportDir, name + '_' + suffix + '.md'), text, { flag: 'wx' });
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name + '.md')}` });
    res.end(text); return;
  }
  const tmp = await fs.mkdtemp(path.join(STATE, 'export-'));
  try {
    const input = path.join(tmp, 'input.md');
    const output = path.join(tmp, 'output.docx');
    // Text exports do not embed model-suggested local or remote image resources.
    await fs.writeFile(input, text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1'));
    await new Promise((resolve, reject) => {
      const proc = spawn(settings.pandoc, ['--sandbox', input, '-f', 'gfm', '-t', 'docx', '-o', output], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      proc.stderr.on('data', b => { err += b; });
      proc.on('error', reject);
      proc.on('close', code => code === 0 ? resolve() : reject(new Error('Word 导出失败：' + err.slice(0, 300))));
    });
    await fs.writeFile(path.join(realExportDir, name + '_' + suffix + '.docx'), await fs.readFile(output), { flag: 'wx' });
    res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name + '.docx')}` });
    await pipeline(createReadStream(output), res);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
}
async function route(req, res) {
  // Bind to loopback and reject foreign browser origins and DNS rebinding.
  if (req.headers.host !== `127.0.0.1:${PORT}` || (req.headers.origin && req.headers.origin !== ORIGIN)) {
    return json(res, { error: '仅允许本机工作台访问' }, 403);
  }
  if (!['GET', 'POST', 'HEAD'].includes(req.method)) return json(res, { error: '不支持此请求' }, 405);
  if (req.method === 'POST' && req.headers.origin !== ORIGIN && req.headers['x-lexstead-local'] !== '1') return json(res, { error: '缺少本机请求来源' }, 403);
  const url = new URL(req.url, ORIGIN);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  if (url.pathname === '/api/status') {
    try {
      const models = await dsh.rpc('session/modelCatalog');
      return json(res, { connected: true, models, workspace: WORK, tasks: data.tasks, templates: data.templates });
    } catch (error) { return json(res, { connected: false, error: error.message, workspace: WORK, tasks: data.tasks, templates: data.templates }); }
  }
  if (url.pathname === '/api/health') return json(res, { app: 'lexstead-dsh-workbench', version: '0.1.0-preview' });
  if (url.pathname === '/api/tasks') return json(res, data.tasks);
  if (url.pathname === '/api/manage') {
    await dsh.authenticate();
    res.writeHead(302, { location: settings.dshOrigin + '/?native=1', 'set-cookie': dsh.cookie + '; Path=/; HttpOnly; SameSite=Strict', 'cache-control': 'no-store' });
    res.end(); return;
  }
  if (url.pathname === '/api/interactions') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    interactionClients.add(res); publishInteractions();
    const timer = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 15000);
    res.on('close', () => { clearInterval(timer); interactionClients.delete(res); });
    return;
  }
  if (url.pathname === '/api/files') return json(res, await files());
  if (url.pathname === '/api/file') {
    const { candidate, stat } = await safeWorkspaceFile(url.searchParams.get('path') || '');
    const ext = path.extname(candidate).toLowerCase();
    const preview = url.searchParams.get('preview') === '1' && ['.txt', '.md', '.csv', '.json'].includes(ext);
    res.writeHead(200, { 'content-type': preview ? 'text/plain; charset=utf-8' : 'application/octet-stream', 'content-length': stat.size,
      'content-disposition': `${preview ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(candidate))}` });
    return pipeline(createReadStream(candidate), res);
  }
  if (url.pathname === '/api/follow') {
    const task = requireTask(url.searchParams.get('id'));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(': connected\n\n');
    let close;
    let ended = false;
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 15000);
    const send = (event, value) => { if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`); };
    const finish = () => { ended = true; clearInterval(heartbeat); close?.(); };
    res.on('close', finish);
    try {
      close = await dsh.stream('session/follow', { request: { address: { kind: 'session', sessionId: task.id }, maxMessages: 100, assistantStream: true } },
        value => send('frame', value), error => { send('failure', { error: error.message }); finish(); res.end(); });
      if (ended) close();
    } catch (error) { send('failure', { error: error.message }); finish(); res.end(); }
    return;
  }
  if (url.pathname === '/api/upload' && req.method === 'POST') {
    const task = requireTask(url.searchParams.get('id'));
    const name = path.basename(url.searchParams.get('name') || '材料').replace(/[\x00-\x1f]/g, '_');
    const bytes = await readBody(req, 30 * 1024 * 1024);
    const response = await dsh.request(`/api/session/uploadFileBinary?sessionId=${encodeURIComponent(task.id)}&name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes,
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error?.message || '文件上传失败');
    return json(res, result.value);
  }
  if (url.pathname.startsWith('/api/') && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString());
    if (url.pathname === '/api/interaction') {
      const interaction = pendingInteractions.get(body.eventId);
      if (!interaction) throw new Error('该请求已取消或已处理，请刷新记录');
      requireTask(interaction.agentId);
      let value;
      if (interaction.event === 'approval/request') {
        if (!['allowed-once', 'rejected'].includes(body.value)) throw new Error('无效授权决定');
        value = body.value;
      } else {
        if (!Array.isArray(body.value?.answers)) throw new Error('请选择或填写回答');
        value = body.value;
      }
      const result = await dsh.rpc('$events/result', { clientId: interaction.clientId, eventId: body.eventId, outcome: { kind: 'result', value } });
      pendingInteractions.delete(body.eventId); publishInteractions();
      return json(res, result ?? { accepted: true });
    }
    if (url.pathname === '/api/create') {
      const value = await dsh.rpc('session/create', { request: { cwd: WORK } });
      const task = { id: value.sessionId, agentId: body.agentId || null, title: '新委托', createdAt: Date.now(), updatedAt: Date.now(), output: '自动', reviewed: [] };
      await fs.mkdir(path.join(WORK, task.id), { recursive: true });
      data.tasks.unshift(task); await persist();
      return json(res, task);
    }
    if (url.pathname === '/api/prompt') {
      const task = requireTask(body.id);
      const text = requireText(body.text);
      task.output = body.output || '自动';
      if (task.title === '新委托') {
        const title = text.replace(/\s+/g, ' ').slice(0, 36);
        await dsh.rpc('session/rename', { request: { sessionId: task.id, title } });
        task.title = title;
      }
      const content = [{ type: 'text', text: taskPrompt(task, text) }];
      for (const receiptId of body.receipts || []) {
        if (typeof receiptId !== 'string') throw new Error('无效的上传凭据');
        content.push({ type: 'file', receiptId });
      }
      // The browser mints this ID before sending; DSH reconciles retries using the same ID.
      const requestId = requireText(body.requestId, 120);
      const result = await dsh.rpc('session/prompt', { request: { sessionId: task.id, requestId, mode: 'queue', content, clientTimeZone: body.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone } });
      task.updatedAt = Date.now(); await persist();
      return json(res, result);
    }
    if (url.pathname === '/api/cancel') {
      const task = requireTask(body.id);
      return json(res, await dsh.rpc('session/cancel', { request: { sessionId: task.id } }));
    }
    if (url.pathname === '/api/model') {
      const task = requireTask(body.id);
      const selection = { sessionId: task.id, provider: body.provider, model: body.model, ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}) };
      const result = await dsh.rpc('session/selectModel', { request: selection });
      return json(res, result);
    }
    if (url.pathname === '/api/skills') {
      const task = requireTask(body.id);
      return json(res, await dsh.rpc('skills/list', { request: { sessionId: task.id } }));
    }
    if (url.pathname === '/api/page') {
      const task = requireTask(body.id);
      return json(res, await dsh.rpc('session/page', { request: { address: { kind: 'session', sessionId: task.id }, throughSeq: body.throughSeq, beforeSeq: body.beforeSeq, maxMessages: 100 } }));
    }
    if (url.pathname === '/api/review') {
      const task = requireTask(body.id);
      if (!Number.isSafeInteger(body.seq)) throw new Error('无效成果序号');
      task.reviewed = (task.reviewed || []).filter(r => r.seq !== body.seq);
      if (body.reviewed) task.reviewed.push({ seq: body.seq, at: Date.now(), by: '本机使用者' });
      await persist(); return json(res, task);
    }
    if (url.pathname === '/api/template') {
      const template = { id: crypto.randomUUID(), name: requireText(body.name, 80), prompt: requireText(body.prompt, 50000), agentId: body.agentId || null };
      data.templates.unshift(template); await persist(); return json(res, template);
    }
    if (url.pathname === '/api/export') return exportDocument(req, res, body);
    return json(res, { error: '接口不存在' }, 404);
  }
  const names = { '/': 'index.html', '/app.js': 'app.js', '/app.css': 'app.css', '/prototype.css': 'prototype.css', '/catalog.json': 'catalog.json', '/manifest.webmanifest': 'manifest.webmanifest', '/icon.svg': 'icon.svg' };
  const name = names[url.pathname];
  if (!name) return json(res, { error: '页面不存在' }, 404);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'content-type': types[path.extname(name)] + '; charset=utf-8', 'cache-control': 'no-store' });
  res.end(await fs.readFile(path.join(PUBLIC, name)));
}
export async function start() {
  await fs.mkdir(STATE, { recursive: true, mode: 0o700 });
  await fs.mkdir(WORK, { recursive: true });
  try { data = JSON.parse(await fs.readFile(path.join(STATE, 'workbench.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; data = { tasks: [], templates: [] }; }
  const server = http.createServer((req, res) => {
    route(req, res).catch(error => {
      if (res.headersSent) res.destroy();
      else json(res, { error: error.message }, error.status || 400);
    });
  });
  server.requestTimeout = 120000;
  server.listen(PORT, '127.0.0.1', () => console.log(`Lexstead 律师工作台：${ORIGIN}`));
  void connectEvents();
  server.on('close', () => { clearTimeout(eventsRetry); eventsStop?.(); for (const res of interactionClients) res.end(); });
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await start();
