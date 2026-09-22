// API REST + OpenAPI + export OpenAI tools. Todo sale del registro de tools (tools.js) más rutas de conveniencia.
import express from 'express';
import { createRequire } from 'node:module';
import { tools, toolByName, browserTools, callTool, openaiTools } from './tools.js';
import { services } from './services.js';
import { playwright } from './playwright.js';
import { getConfig, saveConfig, redactedConfig } from './config.js';
import { logger } from './log.js';
import * as agents from './agents.js';
import { sessionCount } from './mcp.js';
import crypto from 'node:crypto';

const VERSION = createRequire(import.meta.url)('../package.json').version;

export function authMiddleware(req, res, next) {
  const key = getConfig().server.apiKey;
  const h = req.headers.authorization || '';
  const given = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-api-key'] || req.query.api_key);
  if (!given) return res.status(401).json({ error: 'Falta API key (Authorization: Bearer <key> o X-Api-Key)' });
  const a = Buffer.from(String(given)), b = Buffer.from(key || '');
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  return res.status(401).json({ error: 'API key inválida' });
}

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).then((r) => { if (r === undefined) return; if (r && r.image) { res.type(r.mime || 'image/png'); res.set('X-Image-Width', String(r.width)); res.set('X-Image-Height', String(r.height)); return res.send(r.image); } res.json(r); })
  .catch((e) => res.status(e.status || 500).json({ error: e.message }));

export function apiRouter() {
  const r = express.Router();
  r.use(express.json({ limit: '10mb' }));

  // --- tools genéricos (cualquier LLM) ---
  r.get('/tools', wrap(async () => ({ tools: [...tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })), ...(await browserTools()).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, proxy: true }))] })));
  r.get('/tools/openai', wrap(async (req) => openaiTools({ includeBrowser: req.query.browser !== '0' })));
  r.post('/tools/:name', wrap(async (req) => callTool(req.params.name, req.body || {})));

  // --- estado / servicios ---
  r.get('/status', wrap(async () => ({ ...(await services.status()), mcpSessions: sessionCount() })));
  r.get('/services', wrap(() => services.status()));
  r.get('/events', wrap((req) => services.events(+req.query.limit || 100)));
  r.post('/services/:name/restart', wrap((req) => callTool('service_restart', { service: req.params.name })));
  r.get('/logs', wrap((req) => logger.recent(+req.query.n || 200)));

  // --- VMs (rutas de conveniencia) ---
  r.get('/vms', wrap(() => callTool('vm_list')));
  r.get('/vms/:vm', wrap((req) => callTool('vm_info', { vm: req.params.vm })));
  for (const op of ['start', 'stop', 'restart', 'reset', 'save_state', 'show', 'hide', 'click', 'move', 'drag', 'scroll', 'key', 'type', 'paste', 'run', 'ssh', 'copy_to', 'copy_from'])
    r.post(`/vms/:vm/${op}`, wrap((req) => callTool('vm_' + op, { ...(req.body || {}), vm: req.params.vm })));
  r.get('/vms/:vm/screenshot.png', wrap((req) => callTool('vm_screenshot', { vm: req.params.vm })));
  r.get('/vms/:vm/screenshot', wrap(async (req) => { const s = await callTool('vm_screenshot', { vm: req.params.vm }); return { width: s.width, height: s.height, png_base64: s.image.toString('base64') }; }));
  r.get('/vms/:vm/snapshots', wrap((req) => callTool('vm_snapshot_list', { vm: req.params.vm })));
  r.post('/vms/:vm/snapshots', wrap((req) => callTool('vm_snapshot_take', { ...(req.body || {}), vm: req.params.vm })));
  r.post('/vms/:vm/snapshots/:name/restore', wrap((req) => callTool('vm_snapshot_restore', { vm: req.params.vm, name: req.params.name })));
  r.delete('/vms/:vm/snapshots/:name', wrap((req) => callTool('vm_snapshot_delete', { vm: req.params.vm, name: req.params.name })));

  // --- ventanas ---
  r.get('/windows', wrap(() => callTool('windows_list')));
  r.post('/windows/:hwnd/show', wrap((req) => callTool('window_show', { hwnd: req.params.hwnd })));
  r.post('/windows/:hwnd/hide', wrap((req) => callTool('window_hide', { hwnd: req.params.hwnd })));

  // --- navegador (Playwright) ---
  r.get('/browser', wrap(() => playwright.status()));
  r.post('/browser/restart', wrap(() => playwright.restart()));
  r.post('/browser/show', wrap(() => callTool('browser_windows_show')));
  r.post('/browser/hide', wrap(() => callTool('browser_windows_hide')));
  r.get('/browser/browsers', wrap(() => callTool('browser_list')));
  r.post('/browser/use', wrap((req) => callTool('browser_use', req.body || {})));
  r.post('/browser/install', wrap(async (req) => { const b = await import('./browsers.js'); const id = req.body?.browser; b.install(id).catch(() => {}); await new Promise(r => setTimeout(r, 500)); return { browser: id, ...(b.installStatus(id) || { status: 'idle' }) }; }));
  r.get('/browser/install/:browser', wrap(async (req) => { const { installStatus } = await import('./browsers.js'); return installStatus(req.params.browser) || { status: 'idle' }; }));
  r.get('/browser/tools', wrap(() => browserTools()));
  r.post('/browser/tools/:name', wrap(async (req) => { const n = req.params.name.startsWith('browser_') ? req.params.name : 'browser_' + req.params.name; return callTool(n, req.body || {}); }));

  // --- acceso / conexiones (cabecera Host + firewall por red de cliente) ---
  r.get('/access', wrap(async () => { const a = await import('./access.js'); return a.status(); }));
  r.post('/access/hosts', wrap(async (req) => { const a = await import('./access.js'); return a.setHosts(req.body || {}); }));
  r.post('/access/hosts/local', wrap(async () => { const a = await import('./access.js'); return a.addLocalHosts(); }));
  r.post('/access/networks', wrap(async (req) => { const a = await import('./access.js'); return a.setNetworks(req.body?.networks || []); }));
  r.post('/access/firewall/apply', wrap(async () => { const a = await import('./access.js'); return a.applyFirewall(); }));

  // --- agentes / integración ---
  r.get('/agents', wrap(() => agents.detect()));
  r.get('/agents/snippets', wrap(() => agents.snippets()));
  r.post('/agents/install', wrap((req) => agents.install(req.body?.agents)));
  r.get('/skill.md', (req, res) => { res.type('text/markdown').send(agents.skillMarkdown()); });

  // --- config ---
  r.get('/config', wrap(() => redactedConfig()));
  r.put('/config', wrap((req) => { const cur = getConfig(); const next = req.body || {}; if (next.server?.apiKey === '***') next.server.apiKey = cur.server.apiKey; for (const [n, v] of Object.entries(next.vms || {})) if (v.password === '***') v.password = cur.vms[n]?.password; saveConfig({ ...cur, ...next, server: { ...cur.server, ...next.server }, vms: next.vms || cur.vms }); return { saved: true, restartNeeded: true }; }));
  r.post('/config/rotate-key', wrap(() => { const cfg = getConfig(); cfg.server.apiKey = crypto.randomBytes(24).toString('base64url'); saveConfig(cfg); return { apiKey: cfg.server.apiKey }; }));
  r.get('/config/apikey', wrap(() => ({ apiKey: getConfig().apiKey ?? getConfig().server.apiKey })));

  r.get('/openapi.json', wrap(async (req) => openapi(req)));
  return r;
}

async function openapi(req) {
  const base = `${req.protocol}://${req.get('host')}/api`;
  const paths = {};
  const all = [...tools, ...(await browserTools())];
  for (const t of all) {
    paths[`/tools/${t.name}`] = { post: { operationId: t.name, summary: t.description, tags: [t.name.split('_')[0]], requestBody: { content: { 'application/json': { schema: t.inputSchema } } }, responses: { 200: { description: t.name === 'vm_screenshot' ? 'PNG' : 'JSON result' } } } };
  }
  paths['/status'] = { get: { operationId: 'status', summary: 'Estado de servicios', responses: { 200: { description: 'OK' } } } };
  paths['/vms/{vm}/screenshot.png'] = { get: { operationId: 'vm_screenshot_png', summary: 'Captura PNG de la VM', parameters: [{ name: 'vm', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'image/png' } } } };
  return {
    openapi: '3.1.0', info: { title: 'TCLLM API', version: VERSION, description: 'Total Control for LLMs: VMs de VirtualBox + navegador Playwright. Autenticación: Authorization: Bearer <apiKey>.' },
    servers: [{ url: base }], components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' }, apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } } }, security: [{ bearer: [] }, { apiKey: [] }], paths,
  };
}
