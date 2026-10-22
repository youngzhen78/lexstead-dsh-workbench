import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { root, validateOrigin, loadSettings } from './config.mjs';
import { mergePatch } from './cli.mjs';

let temporary, mock, socketServer, child, origin;
let prompts = [];
const headers = () => ({ origin, 'content-type': 'application/json' });
const post = (route, body) => fetch(origin + '/api/' + route, { method: 'POST', headers: headers(), body: JSON.stringify(body) });

before(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'lexstead-test-'));
  mock = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/' && url.searchParams.get('token') === 'fixture-only') {
      res.writeHead(302, { location: '/', 'set-cookie': 'fixture=local-test; HttpOnly' }); res.end(); return;
    }
    if (req.headers.cookie !== 'fixture=local-test') { res.writeHead(401); res.end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body), method = request.method;
    const values = {
      'session/modelCatalog': { default: { provider: 'fixture', model: 'fixture' }, groups: [{ id: 'fixture', name: 'Fixture', models: [{ id: 'fixture', name: 'Fixture' }] }], failures: [], routableProviders: ['fixture'] },
      'session/create': { sessionId: 'fixture-session' },
      'session/rename': { title: request.payload.args.request?.title, seq: 1 },
      'session/prompt': { accepted: true },
      'session/cancel': { accepted: true },
      '$events/result': { accepted: true },
    };
    if (method === 'session/prompt') prompts.push(request.payload.args.request);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: values[method] || {} } }));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const upstream = `http://127.0.0.1:${mock.address().port}`;
  socketServer = new WebSocketServer({ server: mock });
  socketServer.on('connection', socket => socket.on('message', bytes => {
    const frame = JSON.parse(bytes.toString());
    if (frame.type === 'open') socket.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'ready', clientId: 'fixture-events', host: { home: '/fixture' } } }));
  }));
  const log = path.join(temporary, 'dsh.log');
  await fs.writeFile(log, upstream + '/?token=fixture-only\n');
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    cwd: root, env: { ...process.env, PORT: String(port), DSH_ORIGIN: upstream, DSH_LOG: log, LEXSTEAD_STATE_DIR: path.join(temporary, 'state'), LEXSTEAD_WORKSPACE: path.join(temporary, 'workspace') }, stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(origin + '/api/health')).ok) return; } catch { /* Wait for the test server listener. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('isolated product server failed to start');
});

after(async () => {
  child?.kill('SIGTERM');
  for (const socket of socketServer?.clients || []) socket.terminate();
  await new Promise(resolve => socketServer ? socketServer.close(resolve) : resolve());
  await new Promise(resolve => mock ? mock.close(resolve) : resolve());
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
});

test('remote origins and credentials are refused by configuration', () => {
  assert.equal(validateOrigin('http://127.0.0.1:3080'), 'http://127.0.0.1:3080');
  for (const value of ['https://example.com', 'http://0.0.0.0:3080', 'http://user:pass@127.0.0.1:3080', 'http://127.0.0.1:3080/?token=x']) assert.throws(() => validateOrigin(value));
  assert.throws(() => loadSettings({ PORT: 'NaN' }));
});

test('install and uninstall preserve other profile entries', () => {
  const original = [{ id: 'personal-model', config: { enabled: true } }, { insert: [{ id: 'other-plugin' }, { id: 'lexstead-client' }] }];
  const installed = mergePatch(original, { id: 'lexstead-client', name: '/fixture/plugin.mjs' });
  assert.equal(installed[0].id, 'personal-model');
  assert.equal(installed[1].insert[0].id, 'other-plugin');
  assert.equal(installed.flatMap(v => v.insert || []).filter(v => v.id === 'lexstead-client').length, 1);
  assert.deepEqual(mergePatch(installed), [{ id: 'personal-model', config: { enabled: true } }, { insert: [{ id: 'other-plugin' }] }]);
});

test('cross-origin requests and foreign session mutations are rejected', async () => {
  const foreign = await fetch(origin + '/api/status', { headers: { origin: 'https://foreign.example' } });
  assert.equal(foreign.status, 403);
  const noOrigin = await fetch(origin + '/api/create', { method: 'POST', body: '{}' });
  assert.equal(noOrigin.status, 403);
  assert.equal((await post('cancel', { id: 'foreign-session' })).status, 404);
});

test('a fresh install is empty and never returns model credentials', async () => {
  const status = await fetch(origin + '/api/status').then(r => r.json());
  assert.equal(status.connected, true);
  assert.deepEqual(status.tasks, []);
  assert.deepEqual(status.templates, []);
  assert.ok(!JSON.stringify(status).includes('fixture-only'));
  assert.ok(!JSON.stringify(status).includes('apiKey'));
});

test('DSH prompt admission is real protocol traffic with a stable request ID', async () => {
  const task = await post('create', { agentId: 'minutes' }).then(r => r.json());
  assert.equal(task.id, 'fixture-session');
  const result = await post('prompt', { id: task.id, text: '虚构测试：整理会议记录', requestId: 'fixture-request', timeZone: 'Asia/Shanghai' }).then(r => r.json());
  assert.equal(result.accepted, true);
  assert.equal(prompts[0].requestId, 'fixture-request');
  assert.equal(prompts[0].clientTimeZone, 'Asia/Shanghai');
  assert.ok(prompts[0].content[0].text.includes('虚构测试'));
});

test('Markdown exports retain source text and remain inside the selected workspace', async () => {
  const text = '# 测试\n\n不会调用任何付费模型。';
  const response = await post('export', { id: 'fixture-session', title: '导出测试', text, format: 'md' });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), text);
  const dir = path.join(temporary, 'workspace/fixture-session/导出成果');
  const leaves = await fs.readdir(dir);
  assert.equal(await fs.readFile(path.join(dir, leaves[0]), 'utf8'), text);
  assert.equal((await fetch(origin + '/api/file?path=' + encodeURIComponent('../dsh.log'))).status, 403);
});

test('an expired interaction cannot approve an operation', async () => {
  assert.equal((await post('interaction', { eventId: 'missing', value: 'allowed-once' })).status, 400);
});
