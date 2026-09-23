// Puente MCP por stdio hacia el servidor TCLLM (API REST del 7777). Lo lanza cada agente como proceso hijo:
//   tcllm mcp-stdio                  -> todas las tools de TCLLM (vm_*, browser_*, windows_*, services_*, sessions_*)
//   tcllm mcp-stdio --browser-only   -> solo las del Playwright MCP, con sus nombres de siempre (sustituye al MCP "playwright")
//
// Por qué: con MCP por HTTP, si TCLLM se reinicia el cliente (Claude Code) ve el puerto cerrado, marca el servidor como
// caído y NO reintenta: hay que hacer /mcp -> Reconnect a mano en cada sesión. El puente vive mientras viva la sesión:
// si TCLLM no contesta, espera y reintenta solo (hasta 2 min), y el agente solo ve una llamada más lenta.
// No ejecuta nada por su cuenta (no lanza Playwright ni toca VirtualBox): todo pasa por el servidor, que además lo
// registra en /api/calls con el nombre de este cliente.
import fs from 'node:fs';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getConfig, HOME } from './config.js';

const RETRY_MS = 120000;        // cuánto esperar a que TCLLM vuelva (un reinicio tarda ~15-30 s)
const CALL_TIMEOUT_MS = 330000; // un poco más que playwright.callTimeoutMs (5 min)
const CACHE = path.join(HOME, 'tools-cache.json');
const err = (...a) => process.stderr.write(a.join(' ') + '\n');   // stdout es el canal MCP: nada de console.log

function base() {
  const s = getConfig().server;
  const h = s.host === '0.0.0.0' || s.host === '::' || !s.host ? '127.0.0.1' : s.host;
  return `http://${h}:${s.port}/api`;
}

/** Errores de conexión (TCLLM caído o reiniciándose): se reintentan. Un HTTP con respuesta NO se reintenta. */
const transient = (e) => /ECONNREFUSED|ECONNRESET|fetch failed|socket hang up|UND_ERR|other side closed|EPIPE/i.test(`${e?.message} ${e?.cause?.code} ${e?.cause?.message}`);

async function request(pathname, { method = 'GET', body, client } = {}) {
  const t0 = Date.now();
  let wait = 500;
  for (;;) {
    try {
      const r = await fetch(base() + pathname, {
        method,
        headers: { Authorization: `Bearer ${getConfig().server.apiKey}`, 'Content-Type': 'application/json', 'X-TCLLM-Client': client },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      return r;
    } catch (e) {
      if (!transient(e) || Date.now() - t0 > RETRY_MS) throw e;
      err(`[tcllm-stdio] TCLLM no responde (${e?.cause?.code || e.message}); reintento en ${wait} ms`);
      await new Promise(res => setTimeout(res, wait));
      wait = Math.min(wait * 2, 5000);
    }
  }
}

function readCache() { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return null; } }
function writeCache(tools) { try { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(tools)); } catch { /* sin disco no pasa nada */ } }

/** Tools del servidor. Si TCLLM no está, se usa la última lista buena (así el agente arranca igual). */
async function listTools(client) {
  try {
    const r = await request('/tools', { client });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { tools } = await r.json();
    writeCache(tools);
    return tools;
  } catch (e) {
    const cached = readCache();
    if (cached) { err(`[tcllm-stdio] uso la lista de tools guardada (${e.message})`); return cached; }
    throw e;
  }
}

/** Respuesta REST -> contenido MCP. */
async function toMcp(r) {
  const ct = r.headers.get('content-type') || '';
  if (ct.startsWith('image/')) {
    const data = Buffer.from(await r.arrayBuffer()).toString('base64');
    return { content: [{ type: 'image', data, mimeType: ct.split(';')[0] }], isError: false };
  }
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = null; }
  if (!r.ok) return { content: [{ type: 'text', text: `Error: ${j?.error || text || 'HTTP ' + r.status}` }], isError: true };
  if (j && j.upstream) return { content: j.upstream.content || [{ type: 'text', text: JSON.stringify(j.upstream) }], isError: !!j.upstream.isError };
  return { content: [{ type: 'text', text: typeof j === 'string' ? j : JSON.stringify(j ?? text, null, 2) }], isError: false };
}

export async function runBridge({ browserOnly = false, name } = {}) {
  // Identidad en el registro de llamadas: nombre explícito, o la carpeta de trabajo de la sesión que lanzó el puente
  const client = (name || process.env.TCLLM_CLIENT || `stdio:${path.basename(process.cwd())}`).slice(0, 60);
  const server = new Server({ name: browserOnly ? 'playwright (via tcllm)' : 'tcllm', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const all = await listTools(client);
    const tools = browserOnly ? all.filter(t => t.proxy) : all;
    return { tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema || { type: 'object', properties: {} } })) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name: tool, arguments: args } = req.params;
    try { return await toMcp(await request(`/tools/${encodeURIComponent(tool)}`, { method: 'POST', body: args || {}, client })); }
    catch (e) { return { content: [{ type: 'text', text: `Error: TCLLM no respondió (${e?.cause?.code || e.message}). ¿Está corriendo la tarea "TCLLM"?` }], isError: true }; }
  });
  await server.connect(new StdioServerTransport());
  err(`[tcllm-stdio] puente listo -> ${base()} como "${client}"${browserOnly ? ' (solo navegador)' : ''}`);
}
