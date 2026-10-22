import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { root, configFile, loadSettings } from './config.mjs';

const DSH_VERSION = '0.1.6-alpha.2';
const pluginId = 'lexstead-client';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }

export function mergePatch(rows, entry = null) {
  if (!Array.isArray(rows)) throw new Error('DSH profile patch 必须是 YAML 数组；未修改原文件');
  const kept = rows.flatMap(row => {
    if (row?.id === pluginId) return [];
    if (!Array.isArray(row?.insert)) return [row];
    const insert = row.insert.filter(value => value.id !== pluginId);
    return insert.length ? [{ ...row, insert }] : [];
  });
  return entry ? [...kept, { insert: [entry] }] : kept;
}

async function patchProfile(settings, install) {
  const dir = path.join(settings.dshHome, 'profiles/web');
  const target = path.join(dir, 'cordis.patch.yml');
  const original = await fs.readFile(target, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return '[]\n';
  });
  const parsed = YAML.parse(original);
  const entry = {
    id: pluginId, name: path.join(root, 'client-plugin.mjs'),
    config: { upstream: `http://127.0.0.1:${settings.port}`, mount: '/lexstead', root, node: process.execPath },
  };
  const rows = mergePatch(parsed ?? [], install ? entry : null);
  const backups = path.join(settings.stateDir, 'backups');
  await fs.mkdir(backups, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(backups, Date.now() + '-cordis.patch.yml'), original, { mode: 0o600, flag: 'wx' });
  await fs.mkdir(dir, { recursive: true });
  const temporary = target + '.lexstead-tmp';
  await fs.writeFile(temporary, '# User profile patch. Lexstead preserves other plugin entries.\n' + YAML.stringify(rows), { mode: 0o600 });
  await fs.rename(temporary, target);
}

function execute(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} 退出：${code ?? signal}`)));
  });
}

async function runtime(settings) {
  if (!settings.dshRoot) throw new Error('请先运行 npm run setup');
  const source = path.join(settings.dshRoot, 'apps/cli/src/bin.ts');
  if (await exists(source)) return { args: ['--import', 'tsx/esm', source], cwd: settings.dshRoot };
  const packaged = path.join(settings.dshRoot, 'lib/bin.js');
  if (!await exists(packaged)) throw new Error('找不到 DSH CLI，请检查 --dsh-root 参数');
  return { args: [packaged], cwd: root };
}

async function healthy(origin, product = false) {
  try {
    const response = await fetch(origin + (product ? '/api/health' : '/'), { signal: AbortSignal.timeout(1000), redirect: 'manual' });
    return product ? response.ok && (await response.json()).app === 'lexstead-dsh-workbench' : response.status >= 200 && response.status < 500;
  } catch { return false; }
}

async function waitHealthy(origin, product) {
  for (let i = 0; i < 120; i++) {
    if (await healthy(origin, product)) return;
    await pause(500);
  }
  throw new Error('服务启动超时，请查看本项目 .state 下的日志；日志不要公开上传');
}

async function detached(args, log, pidFile, options = {}) {
  await fs.mkdir(path.dirname(log), { recursive: true, mode: 0o700 });
  const handle = await fs.open(log, 'a', 0o600);
  try {
    const child = spawn(process.execPath, args, { stdio: ['ignore', handle.fd, handle.fd], detached: true, ...options });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    await fs.writeFile(pidFile, String(child.pid) + '\n', { mode: 0o600 });
  } finally { await handle.close(); }
}

async function setup(options) {
  const saved = loadSettings();
  const option = key => { const index = options.indexOf(key); return index < 0 ? undefined : options[index + 1]; };
  const settings = {
    ...saved,
    dshRoot: option('--dsh-root') ? path.resolve(option('--dsh-root')) : saved.dshRoot,
    dshHome: option('--dsh-home') ? path.resolve(option('--dsh-home')) : saved.dshHome,
    dshLog: option('--dsh-log') ? path.resolve(option('--dsh-log')) : saved.dshLog,
  };
  if (!settings.dshRoot) {
    const prefix = path.join(root, '.runtime');
    settings.dshRoot = path.join(prefix, 'node_modules/@deepseek-ai/dsh');
    if (!await exists(path.join(settings.dshRoot, 'lib/bin.js'))) {
      console.log(`安装官方 DSH ${DSH_VERSION} 到项目私有 .runtime 目录…`);
      await execute(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--registry=https://registry.npmjs.org', '--prefix', prefix, '--no-audit', '--no-fund', '--save-exact', `@deepseek-ai/dsh@${DSH_VERSION}`]);
    }
  }
  const run = await runtime(settings);
  if (!await exists(path.join(settings.dshHome, 'profiles/web/package.json'))) {
    console.log('初始化 DSH web profile…');
    await execute(process.execPath, [...run.args, 'web', '--dump-config'], { cwd: run.cwd, env: { ...process.env, DSH_HOME: settings.dshHome }, stdio: ['ignore', 'ignore', 'inherit'] });
  }
  await fs.writeFile(configFile, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  await patchProfile(settings, true);
  console.log('安装完成。运行 npm start，或在 macOS 双击启动.command。原 profile 已备份；原 DSH 会话与模型配置继续保留。');
}

async function serveDetached() {
  const settings = loadSettings();
  const origin = `http://127.0.0.1:${settings.port}`;
  if (await healthy(origin, true)) return;
  await detached([path.join(root, 'server.mjs')], path.join(settings.stateDir, 'server.log'), path.join(settings.stateDir, 'server.pid'), { cwd: root });
}

async function start(open = true) {
  if (!await exists(configFile)) throw new Error('请先运行 npm run setup，或双击 安装并启动.command');
  const settings = loadSettings();
  if (!await healthy(settings.dshOrigin)) {
    const run = await runtime(settings);
    const parsed = new URL(settings.dshOrigin);
    await detached([...run.args, 'web', '--no-open', '--port', parsed.port || '80'], settings.dshLog, path.join(settings.stateDir, 'dsh.pid'), {
      cwd: run.cwd, env: { ...process.env, DSH_HOME: settings.dshHome },
    });
    await waitHealthy(settings.dshOrigin, false);
  }
  await serveDetached();
  await waitHealthy(`http://127.0.0.1:${settings.port}`, true);
  // The launch URL is used only for the normal local DSH authentication exchange.
  const { DshConnection } = await import('./dsh.mjs');
  const dsh = new DshConnection();
  await dsh.rpc('session/modelCatalog');
  if (open && process.platform === 'darwin') {
    const candidates = [settings.clientApp, path.join(os.homedir(), 'Applications/Chrome Apps.localized/Lexstead 律师工作台.app'), path.join(os.homedir(), 'Applications/Chrome Apps.localized/DeepSeek Harness.app')].filter(Boolean);
    const client = (await Promise.all(candidates.map(async value => await exists(value) ? value : null))).find(Boolean);
    if (client) await execute('/usr/bin/open', ['-a', client]);
    else {
      const { readLaunchUrl } = await import('./dsh.mjs');
      await execute('/usr/bin/open', [await readLaunchUrl()]);
    }
  }
  console.log(`工作台已启动：${settings.dshOrigin}/lexstead/`);
  if (!open || process.platform !== 'darwin') console.log('首次使用请在 DSH 登录完成后访问工作台；模型在原 DSH 管理界面配置。');
}

async function stop() {
  const settings = loadSettings();
  // SIGTERM is sent only to an exact PID owned by this launcher; DSH is left running.
  const pidFile = path.join(settings.stateDir, 'server.pid');
  let pid;
  try { pid = Number((await fs.readFile(pidFile, 'utf8')).trim()); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return; }
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('无效进程记录');
  if (process.platform === 'win32') throw new Error('当前停止入口仅支持 macOS/Linux');
  let command = '';
  const child = spawn('ps', ['-p', String(pid), '-o', 'command='], { stdio: ['ignore', 'pipe', 'ignore'] });
  for await (const chunk of child.stdout) command += chunk;
  if (command.includes(path.join(root, 'server.mjs'))) process.kill(pid, 'SIGTERM');
  console.log('产品服务已停止。请先关闭客户端窗口，否则再次访问会按需启动产品服务。DSH 保持运行。');
}

async function doctor() {
  const settings = loadSettings();
  console.log('Node:', process.version);
  console.log('DSH:', await healthy(settings.dshOrigin) ? '可连接' : '未启动');
  console.log('工作台:', await healthy(`http://127.0.0.1:${settings.port}`, true) ? '可连接' : '未启动');
  console.log('配置:', await exists(configFile) ? '已生成（请勿上传）' : '未安装');
  console.log('DSH 日志:', await exists(settings.dshLog) ? '可读取（内容不会显示）' : '未找到；连接已有 DSH 时需提供 --dsh-log');
  try { await execute(settings.pandoc, ['--version'], { stdio: 'ignore' }); console.log('Word 导出: Pandoc 可用'); }
  catch { console.log('Word 导出: 未找到 Pandoc；Markdown 不受影响'); }
}

async function main() {
  const [command = 'start', ...args] = process.argv.slice(2);
  if (command === 'setup') return setup(args);
  if (command === 'start') return start(!args.includes('--no-open'));
  if (command === 'serve-detached') return serveDetached();
  if (command === 'stop') return stop();
  if (command === 'doctor') return doctor();
  if (command === 'uninstall') {
    await patchProfile(loadSettings(), false);
    console.log('已移除 Lexstead 客户端插件。刷新 DSH 恢复原首页；项目数据与备份保留。');
    return;
  }
  throw new Error('支持命令：setup / start / stop / doctor / uninstall');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
