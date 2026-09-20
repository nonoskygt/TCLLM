// Servidor TCLLM: Express con API REST (/api), MCP Streamable HTTP (/mcp), panel web (/) y WebSocket (/ws).
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { createRequire } from 'node:module';
import { loadConfig, getConfig, PKG_ROOT, HOME } from './config.js';
import { logger, log } from './log.js';
import { apiRouter, authMiddleware } from './api.js';
import { handleHttp } from './mcp.js';
import { services } from './services.js';
import { playwright } from './playwright.js';
import { bridge } from './bridge.js';

const L = log('server');
const VERSION = createRequire(import.meta.url)('../package.json').version;

export async function startServer() {
  const cfg = loadConfig();
  logger.setFile(path.join(HOME, 'logs', 'tcllm.log'));
  L.info(`TCLLM ${VERSION} arrancando (home ${HOME})`);

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Api-Key, Mcp-Session-Id, Mcp-Protocol-Version'); res.set('Access-Control-Expose-Headers', 'Mcp-Session-Id'); res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS'); if (req.method === 'OPTIONS') return res.sendStatus(204); next(); });

  // Público: salud y panel estático (el panel pide la API key al usuario)
  app.get('/api/health', (req, res) => res.json({ ok: true, name: 'tcllm', version: VERSION, uptimeMs: Date.now() - services.startedAt }));
  app.use('/', express.static(path.join(PKG_ROOT, 'panel'), { index: 'index.html' }));

  // MCP
  app.use('/mcp', authMiddleware, express.json({ limit: '10mb' }), (req, res) => handleHttp(req, res).catch(e => { L.error('mcp: ' + e.message); if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: e.message }, id: null }); }));

  // API
  app.use('/api', authMiddleware, apiRouter());
  app.use((err, req, res, next) => { L.error(err.message); res.status(500).json({ error: err.message }); });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    const k = url.searchParams.get('api_key');
    if (k !== cfg.server.apiKey) { ws.close(4401, 'unauthorized'); return; }
    ws.send(JSON.stringify({ type: 'hello', version: VERSION, logs: logger.recent(100), events: services.events(50), status: services.last }));
  });
  const broadcast = (msg) => { const s = JSON.stringify(msg); for (const c of wss.clients) if (c.readyState === 1) c.send(s); };
  logger.on('log', (e) => broadcast({ type: 'log', entry: e }));
  services.on('event', (e) => broadcast({ type: 'event', event: e }));
  services.on('status', (s) => broadcast({ type: 'status', status: s }));

  await new Promise((resolve, reject) => server.listen(cfg.server.port, cfg.server.host, resolve).once('error', reject));
  L.info(`escuchando en http://${cfg.server.host}:${cfg.server.port}  (panel /, API /api, MCP /mcp)`);

  bridge.start().catch(e => L.warn('bridge: ' + e.message));
  playwright.start();
  services.startMonitor();

  const shutdown = async () => { L.info('apagando...'); services.stopMonitor(); await playwright.stop(); bridge.stop(); server.close(); setTimeout(() => process.exit(0), 500); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  return { app, server, cfg };
}
