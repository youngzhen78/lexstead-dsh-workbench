import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const root = path.dirname(fileURLToPath(import.meta.url));
export const configFile = path.join(root, 'config.local.json');

export function validateOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw new Error('DSH 地址必须是 http://127.0.0.1:端口，不能包含凭据或路径');
  }
  return url.origin;
}

export function loadSettings(env = process.env) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(configFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const stateDir = path.resolve(env.LEXSTEAD_STATE_DIR || saved.stateDir || path.join(root, '.state'));
  const port = Number(env.PORT || saved.port || 3088);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('产品端口必须在 1024 到 65535 之间');
  return {
    port, stateDir,
    workspace: path.resolve(env.LEXSTEAD_WORKSPACE || saved.workspace || path.join(root, 'workspace')),
    dshHome: path.resolve(env.DSH_HOME || saved.dshHome || path.join(os.homedir(), '.dsh')),
    dshOrigin: validateOrigin(env.DSH_ORIGIN || saved.dshOrigin || 'http://127.0.0.1:3080'),
    dshRoot: env.DSH_ROOT || saved.dshRoot || '',
    dshLog: env.DSH_LOG || saved.dshLog || path.join(stateDir, 'dsh.log'),
    pandoc: env.PANDOC || saved.pandoc || 'pandoc',
    clientApp: env.LEXSTEAD_CLIENT_APP || saved.clientApp || '',
  };
}

export const settings = loadSettings();
