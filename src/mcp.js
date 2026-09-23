// Servidor MCP "tcllm": expone el registro de tools (vm_*, windows_*, services_*) y hace proxy 1:1 de las tools
// del Playwright MCP como browser_*. Transportes: Streamable HTTP (montado en Express en /mcp) y stdio.
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRequire } from 'node:module';
import { tools, browserTools, callTool } from './tools.js';
import { callCtx } from './calls.js';
import { log } from './log.js';

const L = log('mcp');
const VERSION = createRequire(import.meta.url)('../package.json').version;

/** Convierte el resultado de un handler a contenido MCP. */
export function toMcpContent(result) {
  if (result && result.image) {
    const { image, mime, ...rest } = result;
    return [{ type: 'image', data: Buffer.from(image).toString('base64'), mimeType: mime || 'image/png' }, { type: 'text', text: JSON.stringify(rest) }];
  }
  if (result && result.upstream) return result.upstream.content || [{ type: 'text', text: JSON.stringify(result.upstream) }];
  if (typeof result === 'string') return [{ type: 'text', text: result }];
  return [{ type: 'text', text: JSON.stringify(result ?? null, null, 2) }];
}

export function createMcpServer() {
  const server = new Server({ name: 'tcllm', version: VERSION }, { capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      ...(await browserTools()).map(t => ({ name: t.name, description: `[Navegador Playwright] ${t.description}`, inputSchema: t.inputSchema })),
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: args } = req.params;
    // Identidad para el registro de llamadas (src/calls.js): nombre del cliente MCP + inicio del id de sesión
    const st = callCtx.getStore();
    const client = `${server.getClientVersion()?.name || 'cliente'}#${String(extra?.sessionId || st?.sid || '').slice(0, 8)}`;
    const run = () => callTool(name, args || {});
    try {
      const result = st ? await callCtx.run({ ...st, client }, run) : await callCtx.run({ via: 'mcp-stdio', client }, run);
      const isError = !!(result && result.upstream && result.upstream.isError);
      return { content: toMcpContent(result), isError };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  });
  return server;
}

const INSTRUCTIONS = `TCLLM da control total de máquinas virtuales VirtualBox (vm_*) y de un navegador Playwright (browser_*).
Flujo típico con una VM: vm_list -> vm_start (si no está running) -> vm_screenshot -> vm_click/vm_key/vm_type -> vm_run para leer datos del guest.
Reglas: usa vm_run (PowerShell dentro) para obtener información, no interpretes capturas si no hace falta; para reiniciar Windows usa
vm_restart (nunca "shutdown /r" a mano: bajo Hyper-V el reinicio se cuelga y vm_restart lo vigila); vm_type para texto corto ASCII,
vm_paste para texto largo/Unicode. Las coordenadas de vm_click son las de la última vm_screenshot.
Navegador: browser_list muestra los navegadores disponibles (Chrome, Edge, Brave, Firefox, Chromium, WebKit) y el activo; browser_use cambia de
navegador (relanza Playwright: se pierden las pestañas de todos los agentes); browser_install descarga Firefox/Chromium/WebKit.`;

// ---------- Streamable HTTP (sesiones) ----------
const sessions = new Map(); // sessionId -> transport

export async function handleHttp(req, res) {
  const sid = req.headers['mcp-session-id'];
  let transport = sid && sessions.get(sid);
  if (!transport) {
    if (req.method !== 'POST') return res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Sesión MCP no encontrada; inicia con initialize' }, id: null });
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { sessions.set(id, transport); L.info(`sesión MCP ${id.slice(0, 8)} abierta (${sessions.size} activas)`); },
    });
    transport.onclose = () => { if (transport.sessionId) { sessions.delete(transport.sessionId); L.info(`sesión MCP ${transport.sessionId.slice(0, 8)} cerrada`); } };
    const server = createMcpServer();
    await server.connect(transport);
  }
  // El contexto viaja con la petición hasta el handler de la tool (registro de llamadas: IP/puerto de origen)
  const ctx = { via: 'mcp', client: '?', ip: req.socket?.remoteAddress, port: req.socket?.remotePort, serverPort: req.socket?.localPort, sid: sid || '' };
  await callCtx.run(ctx, () => transport.handleRequest(req, res, req.body));
}

export function sessionCount() { return sessions.size; }

export async function runStdio() {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}
