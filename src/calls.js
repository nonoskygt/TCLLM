// Registro de llamadas a tools: quién llama (REST, MCP del 7777 o interno), qué tool, cuánto tarda y cómo termina.
// Sirve para identificar al agente que traba el navegador compartido. NO guarda argumentos (pueden llevar datos
// sensibles: textos tecleados, URLs con tokens...).
//
// Identidad del que llama:
//   - REST: cabecera X-TCLLM-Client (el agente pone su nombre), o si falta el User-Agent, más IP:puerto de origen.
//   - MCP (7777): clientInfo.name del initialize + los 8 primeros caracteres del id de sesión.
//   - Llamada lenta de un cliente local: se averigua además qué proceso es (dueño del puerto de origen).
// Los clientes que van DIRECTO al Playwright MCP (8931) no pasan por aquí y no quedan registrados.
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { log } from './log.js';

const L = log('llamadas');
export const callCtx = new AsyncLocalStorage();

const SLOW_MS = 30000;        // a partir de aquí se avisa en el log mientras la llamada sigue en curso
const REPEAT_MS = 60000;      // y se repite el aviso cada minuto
const LOG_ALWAYS_MS = 10000;  // una llamada terminada se registra siempre si tardó más que esto
const RECENT_MAX = 300;

let nextId = 1;
const inFlight = new Map();   // id -> entrada
const recent = [];            // últimas terminadas

const isLocal = (ip) => !ip || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
const who = (e) => `${e.via}:${e.client}${e.ip && !isLocal(e.ip) ? '@' + e.ip : ''}${e.proc ? ` [${e.proc}]` : ''}`;

/** Contexto de quien llama para una petición REST (lo usa el middleware de la API). */
export function restContext(req) {
  const name = String(req.headers['x-tcllm-client'] || '').trim().slice(0, 60);
  const ua = String(req.headers['user-agent'] || '').split(/[\s/]/)[0].slice(0, 30);
  return { via: 'rest', client: name || ua || 'desconocido', ip: req.socket?.remoteAddress, port: req.socket?.remotePort, serverPort: req.socket?.localPort };
}

/** Ejecuta fn registrando la llamada. `tool` es el nombre público (browser_navigate, vm_run...). */
export async function track(tool, fn) {
  const ctx = callCtx.getStore() || { via: 'interno', client: 'tcllm' };
  const e = { id: nextId++, tool, via: ctx.via, client: ctx.client || '?', ip: ctx.ip, port: ctx.port, serverPort: ctx.serverPort, startedAt: Date.now(), warnedAt: 0 };
  inFlight.set(e.id, e);
  try {
    const r = await fn();
    e.outcome = r?.upstream?.isError ? 'error de la tool' : 'ok';
    e.page = pageOf(r);   // en qué pestaña quedó (para saber qué agente usa cada pestaña)
    return r;
  } catch (err) {
    e.outcome = /timed out|timeout/i.test(err?.message || '') || err?.code === -32001 ? 'timeout' : 'error';
    e.error = String(err?.message || err).split('\n')[0].slice(0, 160);
    throw err;
  } finally {
    inFlight.delete(e.id);
    e.ms = Date.now() - e.startedAt;
    recent.push(e); if (recent.length > RECENT_MAX) recent.shift();
    if (tool.startsWith('browser_') || e.ms >= LOG_ALWAYS_MS || e.outcome !== 'ok') {
      const line = `${tool} ${e.outcome} ${e.ms} ms · ${who(e)}${e.error ? ' · ' + e.error : ''}`;
      e.outcome === 'ok' && e.ms < LOG_ALWAYS_MS ? L.info(line) : L.warn(line);
    }
  }
}

/** Página en la que quedó una llamada al navegador: Playwright la informa en cada respuesta ("Page URL: ..."). */
function pageOf(r) {
  const text = (r?.upstream?.content || []).map(c => c?.text || '').join('\n');
  const url = (text.match(/Page URL: (\S+)/) || [])[1];
  if (!url) return null;
  return { url, title: ((text.match(/Page Title: (.*)/) || [])[1] || '').trim() };
}

/** Último uso conocido de cada URL por un agente (el más reciente gana). Excluye llamadas internas de TCLLM. */
export function lastUseByUrl() {
  const m = new Map();
  for (const e of recent) {   // de más viejo a más nuevo: el último que escribe gana
    if (!e.page || e.via === 'interno') continue;
    m.set(e.page.url, { client: e.client, via: e.via, tool: e.tool, at: e.startedAt + (e.ms || 0) });
  }
  return m;
}

/** Qué proceso local es el dueño del puerto de origen de la llamada (una sola vez por llamada, solo si es lenta). */
function resolveProcess(e) {
  if (e.proc !== undefined || !isLocal(e.ip) || !e.port || !e.serverPort) return;
  e.proc = '';   // en curso: no repetir
  const ps = `$c = Get-NetTCPConnection -LocalPort ${e.port} -RemotePort ${e.serverPort} -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
    `if ($c) { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"; $cl = [string]$p.CommandLine; ` +
    `"pid " + $p.ProcessId + " " + $p.Name + " " + $cl.Substring([Math]::Max(0, $cl.Length - 90)) }`;
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
  let out = '';
  p.stdout.on('data', d => out += d);
  p.on('error', () => {});
  // pid 0 = la conexión ya se cerró (el cliente cortó por su lado): no sirve para identificar a nadie
  p.on('exit', () => { const s = out.trim().replace(/\s+/g, ' ').slice(0, 140); e.proc = /^pid 0\b/.test(s) ? '' : s; });
}

// Vigilante: avisa de las llamadas que siguen en curso demasiado tiempo (así se ve quién traba el navegador AHORA)
setInterval(() => {
  const now = Date.now();
  for (const e of inFlight.values()) {
    const el = now - e.startedAt;
    if (el >= SLOW_MS - 10000) resolveProcess(e);   // a los 20 s, para que el aviso de los 30 s ya diga qué proceso es
    if (el < SLOW_MS) continue;
    if (!e.warnedAt || now - e.warnedAt >= REPEAT_MS) {
      e.warnedAt = now;
      L.warn(`EN CURSO hace ${Math.round(el / 1000)} s: ${e.tool} · ${who(e)}`);
    }
  }
}, 10000).unref();

/** Estado para la API/panel. */
export function status({ limit = 50, browserOnly = false } = {}) {
  const now = Date.now();
  const view = (e) => ({ tool: e.tool, via: e.via, client: e.client, ip: e.ip, proc: e.proc || undefined, startedAt: new Date(e.startedAt).toISOString(), ms: e.ms ?? now - e.startedAt, outcome: e.outcome || 'en curso', error: e.error });
  const pick = (e) => !browserOnly || e.tool.startsWith('browser_');
  const byClient = {};
  for (const e of recent) {
    const k = `${e.via}:${e.client}`;
    const b = byClient[k] ||= { calls: 0, slow: 0, errors: 0, maxMs: 0 };
    b.calls++; if (e.ms >= SLOW_MS) b.slow++; if (e.outcome !== 'ok') b.errors++; if (e.ms > b.maxMs) b.maxMs = e.ms;
  }
  return {
    inFlight: [...inFlight.values()].filter(pick).map(view).sort((a, b) => b.ms - a.ms),
    recent: recent.filter(pick).slice(-limit).reverse().map(view),
    byClient,
  };
}
