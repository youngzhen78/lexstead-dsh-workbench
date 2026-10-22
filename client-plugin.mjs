/** Mount Lexstead inside the installed DSH application on its authenticated origin. */
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const name = 'lexstead-client';
export const inject = ['webServer', 'connection'];
const execute = promisify(execFile);

/** Register a same-origin client route without replacing DSH's API or data. */
export function apply(ctx, config) {
  const upstream = new URL(config.upstream);
  const mount = config.mount;
  if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' || upstream.username || upstream.password || mount !== '/lexstead' || !config.root || !config.node) {
    throw new Error('lexstead-client: invalid local deployment configuration');
  }
  let starting;
  let disposed = false;
  const controllers = new Set();
  ctx.effect(() => () => {
    disposed = true;
    for (const controller of controllers) controller.abort();
  }, 'lexstead-client: close proxied requests');

  async function ensureProduct() {
    if (disposed) throw new Error('DSH client integration was unloaded');
    if (starting) return starting;
    starting = (async () => {
      try {
        const response = await fetch(upstream.origin + '/api/health', { signal: AbortSignal.timeout(1200) });
        if (response.ok && (await response.json()).app === 'lexstead-dsh-workbench') return;
      } catch { /* A stopped local product service is started below. */ }
      await execute(config.node, [config.root + '/cli.mjs', 'serve-detached'], { timeout: 10000 });
      for (let attempt = 0; attempt < 30; attempt++) {
        if (disposed) throw new Error('DSH client integration was unloaded');
        try {
          const response = await fetch(upstream.origin + '/api/health', { signal: AbortSignal.timeout(1000) });
          if (response.ok && (await response.json()).app === 'lexstead-dsh-workbench') return;
        } catch { /* Node may still be binding the listener. */ }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('律师工作台服务未能启动，请查看项目 .state/server.log');
    })();
    try { await starting; } finally { starting = undefined; }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: mount,
    async handler(req, res) {
      const rejection = ctx.connection.requestRejection(req);
      if (rejection !== undefined) { res.writeHead(rejection); res.end('DSH authentication required'); return; }
      const url = new URL(req.url, 'http://' + req.headers.host);
      if (url.pathname === mount) {
        res.writeHead(302, { location: mount + '/' + url.search }); res.end(); return;
      }
      try { await ensureProduct(); }
      catch (error) { res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }); res.end(error.message); return; }
      const controller = new AbortController(); controllers.add(controller);
      const headers = { ...req.headers, host: upstream.host, origin: upstream.origin };
      for (const key of ['cookie', 'connection', 'accept-encoding', 'authorization']) delete headers[key];
      const proxy = http.request(new URL(url.pathname.slice(mount.length) + url.search, upstream), {
        method: req.method, headers, signal: controller.signal,
      }, response => {
        const responseHeaders = { ...response.headers };
        delete responseHeaders.connection;
        res.writeHead(response.statusCode || 502, responseHeaders);
        response.pipe(res);
        response.on('error', () => res.destroy());
      });
      proxy.on('error', error => {
        if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('工作台连接失败：' + error.message); }
        else res.destroy();
      });
      res.on('close', () => { controller.abort(); controllers.delete(controller); });
      req.on('aborted', () => controller.abort());
      req.pipe(proxy);
    },
  }), 'lexstead-client: authenticated product route');

  const entryScript = `<script id="lexstead-client-entry">(() => {
    const native = new URLSearchParams(location.search).get('native') === '1';
    if (!native && (location.pathname === '/' || location.pathname === '/index.html')) {
      location.replace('/lexstead/' + location.hash);
    } else if (native) {
      addEventListener('DOMContentLoaded', () => {
        const link = document.createElement('a');
        link.href = '/lexstead/'; link.textContent = '← 返回律师工作台';
        link.style.cssText = 'position:fixed;right:24px;top:12px;z-index:99999;background:#ff4623;color:white;padding:9px 15px;border-radius:6px;text-decoration:none;font:13px sans-serif;box-shadow:0 2px 8px #0002';
        document.body.append(link);
      });
    }
  })();</script>`;
  ctx.effect(() => ctx.webServer.tapIndex(html => html.replace('<head>', '<head>' + entryScript)), 'lexstead-client: application home');
}
