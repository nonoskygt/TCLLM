// Prueba del puente stdio: una sesión MCP por stdio sobrevive a un REINICIO del servidor TCLLM sin reconectar.
// Mata el servidor (el de TCLLM_HOME), lo vuelve a arrancar y llama de nuevo por la MISMA sesión.
// Úsalo contra una instancia de desarrollo, no contra la de producción (la reinicia).
//
//   TCLLM_HOME=D:\TCLLM\.dev-home node test/stdio-bridge.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../src/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig();
const api = `http://127.0.0.1:${cfg.server.port}/api`;
let fails = 0;
const check = (n, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FALL'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) fails++; };
const status = () => fetch(api + '/status', { headers: { Authorization: 'Bearer ' + cfg.server.apiKey } }).then(r => r.json());

async function session(args) {
  const c = new Client({ name: 'prueba', version: '1' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'bin', 'tcllm.js'), 'mcp-stdio', ...args], env: { ...process.env }, stderr: 'ignore' }));
  return c;
}
const text = (r) => (r.content || []).map(x => x.text || '').join(' ');

// 1) sesión completa
const full = await session(['--name', 'prueba-stdio']);
const tools = (await full.listTools()).tools.map(t => t.name);
check('lista de tools completa', tools.includes('vm_list') && tools.includes('browser_navigate'), `${tools.length} tools`);
const r1 = await full.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
check('llamada antes del reinicio', !r1.isError, text(r1).slice(0, 60));

// 2) sesión solo navegador (sustituye al MCP "playwright")
const bo = await session(['--browser-only', '--name', 'prueba-stdio-nav']);
const bnames = (await bo.listTools()).tools.map(t => t.name);
check('--browser-only: solo tools del Playwright MCP', bnames.length > 10 && bnames.every(n => n.startsWith('browser_')) && !bnames.includes('browser_use'), `${bnames.length} tools`);
await bo.close();

// 3) reinicio del servidor con la sesión abierta
const before = await status();
process.kill(before.tcllm.pid);
console.log(`servidor TCLLM (pid ${before.tcllm.pid}) detenido; lo relanzo en 5 s`);
setTimeout(() => {
  const p = spawn(process.execPath, [path.join(root, 'bin', 'tcllm.js'), 'start'], { cwd: root, env: { ...process.env }, detached: true, stdio: 'ignore', windowsHide: true });
  p.unref();
}, 5000);
const t0 = Date.now();
const r2 = await full.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
check('la MISMA sesión funciona tras el reinicio (sin reconectar)', !r2.isError, `respondió en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
const after = await status();
check('fue otro proceso de servidor', after.tcllm.pid !== before.tcllm.pid, `pid ${before.tcllm.pid} -> ${after.tcllm.pid}`);

// 4) quedó identificada en el registro del servidor nuevo
const calls = await fetch(api + '/calls', { headers: { Authorization: 'Bearer ' + cfg.server.apiKey } }).then(r => r.json());
check('registrada con su nombre', calls.recent.some(x => x.client === 'prueba-stdio'), calls.recent.slice(0, 3).map(x => x.client).join(', '));
await full.close();
console.log(fails ? `\nRESULTADO: FALLO (${fails})` : '\nRESULTADO: OK');
// exitCode en vez de process.exit(): salir de golpe con el hijo stdio cerrándose dispara un assert de libuv en Windows
process.exitCode = fails ? 1 : 0;
