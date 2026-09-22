// Cliente MCP mínimo (Streamable HTTP con fetch) para hablar directamente con el Playwright MCP que supervisa TCLLM
// desde scripts (check-login.mjs, test/multi-client.mjs). Sin API key: es el servidor Playwright "crudo", no el /mcp de TCLLM.
import { getConfig } from '../src/config.js';

/** URL del Playwright MCP según la config (por loopback; si escucha en 0.0.0.0 se usa 127.0.0.1). */
export function defaultUrl() {
  const pw = getConfig().playwright;
  const h = pw.host === '::' || pw.host === '::1' ? '[::1]' : (pw.host === '0.0.0.0' || pw.host === 'localhost' || !pw.host ? '127.0.0.1' : pw.host);
  return `http://${h}:${pw.port}/mcp`;
}

function parseSse(text) {
  return text.split(/\r?\n\r?\n/)
    .map(chunk => chunk.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join(''))
    .filter(Boolean)
    .map(d => { try { return JSON.parse(d); } catch { return null; } })
    .filter(Boolean);
}

export class McpHttpClient {
  constructor(name, base = defaultUrl()) { this.name = name; this.base = base; this.sessionId = null; this.protocolVersion = null; this.nextId = 1; }
  headers() {
    const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    if (this.protocolVersion) h['mcp-protocol-version'] = this.protocolVersion;
    return h;
  }
  async request(method, params) {
    const id = this.nextId++;
    const res = await fetch(this.base, { method: 'POST', headers: this.headers(), body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    if (!res.ok) throw new Error(`${this.name} ${method}: HTTP ${res.status} ${await res.text()}`);
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    let msg;
    if ((res.headers.get('content-type') || '').includes('text/event-stream'))
      msg = parseSse(await res.text()).find(m => m.id === id);
    else
      msg = await res.json();
    if (!msg) throw new Error(`${this.name} ${method}: sin respuesta`);
    if (msg.error) throw new Error(`${this.name} ${method}: ${JSON.stringify(msg.error)}`);
    return msg.result;
  }
  async notify(method, params) {
    const res = await fetch(this.base, { method: 'POST', headers: this.headers(), body: JSON.stringify({ jsonrpc: '2.0', method, params }) });
    if (!res.ok) throw new Error(`${this.name} ${method}: HTTP ${res.status} ${await res.text()}`);
  }
  async init() {
    const r = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: this.name, version: '1.0' } });
    this.protocolVersion = r.protocolVersion;
    await this.notify('notifications/initialized', {});
    await this.openStream();
    return r;
  }
  // Stream SSE GET: por aquí llegan las peticiones del servidor. El Playwright MCP en modo HTTP hace ping cada 3 s
  // (timeout 5 s) y cierra la sesión si nadie contesta; hay que responderlos.
  async openStream() {
    this._abort = new AbortController();
    const res = await fetch(this.base, {
      method: 'GET',
      headers: { accept: 'text/event-stream', 'mcp-session-id': this.sessionId, 'mcp-protocol-version': this.protocolVersion },
      signal: this._abort.signal,
    });
    if (!res.ok) throw new Error(`${this.name} GET stream: HTTP ${res.status}`);
    this._streamDone = (async () => {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let m;
        while ((m = buf.match(/\r?\n\r?\n/))) {
          const chunk = buf.slice(0, m.index);
          buf = buf.slice(m.index + m[0].length);
          for (const msg of parseSse(chunk + '\n\n')) {
            if (!msg.method || msg.id === undefined) continue; // solo peticiones del servidor
            const body = msg.method === 'ping'
              ? { jsonrpc: '2.0', id: msg.id, result: {} }
              : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } };
            fetch(this.base, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) }).catch(() => {});
          }
        }
      }
    })().catch(() => {});
  }
  async call(tool, args) {
    const r = await this.request('tools/call', { name: tool, arguments: args });
    const text = (r.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (r.isError) throw new Error(`${this.name} ${tool}: ${text}`);
    return text;
  }
  async close() {
    if (!this.sessionId) return;
    const res = await fetch(this.base, { method: 'DELETE', headers: this.headers() });
    this._abort?.abort();
    if (!res.ok && res.status !== 404) throw new Error(`${this.name} DELETE: HTTP ${res.status}`);
  }
}
