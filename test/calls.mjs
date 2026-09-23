// Prueba del registro de llamadas (src/calls.js): identifica a quien llama por REST (cabecera X-TCLLM-Client) y por
// MCP (clientInfo + sesión), y muestra una llamada lenta EN CURSO mientras dura. Requiere un TCLLM en marcha.
//
//   TCLLM_URL=http://127.0.0.1:7777 TCLLM_KEY=... node test/calls.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const URL_ = (process.env.TCLLM_URL || 'http://127.0.0.1:7777').replace(/\/$/, '');
const KEY = process.env.TCLLM_KEY;
if (!KEY) { console.error('Falta TCLLM_KEY'); process.exit(2); }
let fails = 0;
const check = (n, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FALL'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) fails++; };
const rest = (p, body, client) => fetch(URL_ + '/api' + p, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', ...(client ? { 'X-TCLLM-Client': client } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());

// 1) REST identificado
await rest('/browser/tools/tabs', { action: 'list' }, 'prueba-rest');
// 2) MCP del 7777 con nombre de cliente propio
const c = new Client({ name: 'prueba-mcp', version: '1' });
await c.connect(new StreamableHTTPClientTransport(new URL(URL_ + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + KEY } } }));
await c.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
await c.close();
// 3) Llamada lenta (35 s) por REST: mientras dura tiene que aparecer EN CURSO con su nombre
const lenta = rest('/browser/tools/wait_for', { time: 35 }, 'prueba-lenta');
await new Promise(r => setTimeout(r, 5000));
const mid = await rest('/calls?browser=1');
const enCurso = mid.inFlight.find(x => x.client === 'prueba-lenta');
check('llamada lenta visible EN CURSO', !!enCurso, enCurso ? `${enCurso.tool} lleva ${Math.round(enCurso.ms / 1000)} s` : JSON.stringify(mid.inFlight).slice(0, 120));
await lenta;

const end = await rest('/calls?browser=1&limit=20');
const seen = (client) => end.recent.find(x => x.client === client || x.client.startsWith(client));
check('REST identificado por X-TCLLM-Client', !!seen('prueba-rest'), seen('prueba-rest') && `${seen('prueba-rest').via}:${seen('prueba-rest').client}`);
check('MCP identificado por clientInfo + sesión', !!seen('prueba-mcp#'), seen('prueba-mcp#') && `${seen('prueba-mcp#').via}:${seen('prueba-mcp#').client}`);
const l = seen('prueba-lenta');
check('llamada lenta registrada con su duración', !!l && l.ms >= 30000, l && `${Math.round(l.ms / 1000)} s ${l.outcome}${l.proc ? ' · ' + l.proc : ''}`);
check('sin argumentos en el registro', !JSON.stringify(end).includes('"arguments"') && !JSON.stringify(end).includes('"time":35'));
console.log(fails ? `\nRESULTADO: FALLO (${fails})` : '\nRESULTADO: OK');
process.exit(fails ? 1 : 0);
