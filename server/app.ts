import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { APP_NAME, VERSION, WEB_DIST } from './config.js';
import { log } from './logger.js';
import { adminApi } from './api/admin.js';
import { anthropicApi } from './api/anthropic.js';
import { openaiApi } from './api/openai.js';
import { apiGuard, rateLimit } from './http-utils.js';

/**
 * Builds the complete HTTP surface: both gateways, dashboard API and static files.
 * Kept separate from the launcher so tests can exercise the production middleware stack.
 */
export function createApp(): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    if (c.req.path.startsWith('/v1') || c.req.path.startsWith('/api')) {
      log.debug('http', { method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - started });
    }
  });

  app.use('/v1/*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['*'], exposeHeaders: ['*'] }));
  app.use('/v1/*', rateLimit);
  app.use('/v1/*', apiGuard);

  app.route('/', openaiApi);
  app.route('/', anthropicApi);
  app.route('/api', adminApi);

  app.get('/api/health', (c) => c.json({ ok: true, app: APP_NAME, version: VERSION, ts: Date.now() }));

  app.notFound((c) => {
    const url = new URL(c.req.url);
    if (url.pathname.startsWith('/api') || url.pathname.startsWith('/v1')) {
      return c.json({ error: { message: `No route for ${c.req.method} ${url.pathname}`, type: 'not_found', code: 'not_found' } }, 404);
    }
    const indexFile = path.join(WEB_DIST, 'index.html');
    if (c.req.method === 'GET' && fs.existsSync(indexFile)) {
      return c.html(fs.readFileSync(indexFile, 'utf8'));
    }
    return c.text('MagmaX Rotator: dashboard bundle not built. Run `npm run build`.', 503);
  });

  app.use('/*', serveStatic({ root: WEB_DIST }));

  app.onError((err, c) => {
    log.error('unhandled_error', { path: c.req.path, error: err.message, stack: err.stack?.split('\n').slice(0, 4) });
    if (c.req.path.startsWith('/v1/messages')) {
      return c.json({ type: 'error', error: { type: 'api_error', message: err.message } }, 500);
    }
    if (c.req.path.startsWith('/v1')) {
      return c.json({ error: { message: err.message, type: 'server_error', code: 'internal_error' } }, 500);
    }
    return c.json({ error: err.message, code: 'internal_error' }, 500);
  });

  return app;
}
