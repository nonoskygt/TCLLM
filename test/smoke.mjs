// Smoke test: requiere un TCLLM en marcha. Uso: TCLLM_URL=http://127.0.0.1:7777 TCLLM_KEY=... node test/smoke.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const URL_ = process.env.TCLLM_URL || 'http://127.0.0.1:7777';
const KEY = process.env.TCLLM_KEY || process.argv[2];
if (!KEY) { console.error('Falta TCLLM_KEY'); process.exit(2); }
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const api = async (p, opts = {}) => { const r = await fetch(URL_ + '/api' + p, { ...opts, headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) } }); return { status: r.status, ct: r.headers.get('content-type') || '', body: (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.arrayBuffer() }; };

const h = await fetch(URL_ + '/api/health').then(r => r.json()); check('health', h.ok === true, h.version);
check('auth rechaza sin key', (await fetch(URL_ + '/api/status')).status === 401);
const st = await api('/status'); check('status', st.status === 200 && st.body.tcllm, `vbox=${st.body.virtualbox?.ok} playwright=${st.body.playwright?.listening} bridge=${st.body.bridge?.alive}`);
const tl = await api('/tools'); check('tools >= 30', tl.body.tools?.length >= 30, tl.body.tools?.length);
const oa = await api('/tools/openai'); check('openai tools', Array.isArray(oa.body) && oa.body[0]?.type === 'function', oa.body.length);
const op = await api('/openapi.json'); check('openapi', op.body.openapi === '3.1.0', Object.keys(op.body.paths || {}).length + ' paths');
const vms = await api('/tools/vm_list', { method: 'POST', body: '{}' }); check('vm_list', Array.isArray(vms.body), vms.body.map?.(v => v.name + ':' + v.state).join(' '));
const br = await api('/browser/browsers'); check('browser list', Array.isArray(br.body.browsers) && br.body.browsers.length === 6 && !!br.body.active, `activo=${br.body.active} instalados=${br.body.browsers?.filter(b => b.installed).map(b => b.id).join(',')}`);
const win = await api('/windows'); check('windows', Array.isArray(win.body), win.body.length);
const acc = await api('/access'); check('access', acc.status === 200 && Array.isArray(acc.body.reachableUrls) && Array.isArray(acc.body.allowedNetworks), `host=${acc.body.host}:${acc.body.port} redes=${acc.body.allowedNetworks?.join(',') || '-'} anyHost=${acc.body.allowAnyHost}`);
const sn = await api('/agents/snippets'); check('snippets', !!sn.body.claude && !!sn.body.codex && !!sn.body.opencode && !!sn.body.qwen);
const sk = await fetch(URL_ + '/api/skill.md?api_key=' + KEY).then(r => r.text()); check('skill.md', sk.startsWith('---\nname: tcllm'));
// MCP
const c = new Client({ name: 'smoke', version: '0' });
await c.connect(new StreamableHTTPClientTransport(new URL(URL_ + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + KEY } } }));
const { tools } = await c.listTools(); check('mcp listTools', tools.length >= 30, tools.length);
const r1 = await c.callTool({ name: 'services_status', arguments: {} }); check('mcp services_status', !r1.isError);
if (st.body.playwright?.listening) {
  const r2 = await c.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.com' } }); check('mcp browser_navigate (proxy)', !r2.isError && JSON.stringify(r2.content).includes('Example Domain'));
  await c.callTool({ name: 'browser_close', arguments: {} });
}
const running = vms.body.find?.(v => v.state === 'running' && v.controllable);
if (running) {
  const shot = await api(`/vms/${encodeURIComponent(running.name)}/screenshot.png`); check('vm screenshot png', shot.ct.includes('image/png') && shot.body.byteLength > 1000, shot.body.byteLength + ' bytes');
  const run = await api(`/vms/${encodeURIComponent(running.name)}/run`, { method: 'POST', body: JSON.stringify({ command: '"tcllm-" + $env:COMPUTERNAME' }) }); check('vm_run', /tcllm-/.test(run.body.output || ''), (run.body.output || run.body.error || '').trim());
} else console.log('SKIP vm screenshot/run (ninguna VM controlable en ejecución)');
await c.close();
console.log(fails ? `\n${fails} fallo(s)` : '\nTodo OK'); process.exit(fails ? 1 : 0);
