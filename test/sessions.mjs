// Prueba de sesiones persistentes: una cookie puesta por un agente debe sobrevivir (1) al reinicio del navegador y
// (2) al cambio a otro navegador. Requiere un TCLLM en marcha con playwright.sessions = "persistent".
//
//   TCLLM_URL=http://127.0.0.1:7777 TCLLM_KEY=... node test/sessions.mjs [otroNavegador]
//
// Deja el navegador como estaba al empezar.
const URL_ = (process.env.TCLLM_URL || 'http://127.0.0.1:7777').replace(/\/$/, '');
const KEY = process.env.TCLLM_KEY || process.argv[3];
const OTHER = process.argv[2] || 'firefox';
if (!KEY) { console.error('Falta TCLLM_KEY'); process.exit(2); }

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FALL'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) failures++; };
const api = async (p, opts = {}) => {
  const r = await fetch(URL_ + '/api' + p, { ...opts, headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status} ${typeof j === 'string' ? j : j.error}`);
  return j;
};
const tool = (name, args = {}) => api(`/browser/tools/${name}`, { method: 'POST', body: args });
const textOf = (r) => (r.upstream?.content || r.content || []).map(c => c.text || '').join('\n');

const st0 = await api('/sessions');
check('modo persistente', st0.persistent === true, `mode=${st0.mode}`);
if (!st0.persistent) { console.log('\nRESULTADO: FALLO (pon playwright.sessions = "persistent")'); process.exit(1); }

const before = (await api('/browser')).browser;
const VALUE = 'tcllm_' + Date.now().toString(36);
console.log(`Navegador inicial: ${before} · cookie de prueba: ${VALUE}`);

// 1) un "agente" se loguea: cookie de un año en example.com
await tool('navigate', { url: 'https://example.com/' });
await tool('evaluate', { function: `() => { document.cookie = 'tcllm_persist=${VALUE}; max-age=31536000; path=/'; return document.cookie; }` });
const justSet = textOf(await tool('evaluate', { function: '() => document.cookie' }));
check('cookie escrita', justSet.includes(VALUE), justSet.trim().slice(0, 80));

// 2) reinicio del MISMO navegador -> debe seguir ahí (esto es lo que el modo aislado perdía)
await api('/browser/restart', { method: 'POST' });
await tool('navigate', { url: 'https://example.com/' });
const afterRestart = textOf(await tool('evaluate', { function: '() => document.cookie' }));
check(`persiste tras reiniciar ${before}`, afterRestart.includes(VALUE), afterRestart.trim().slice(0, 80));

// 3) cambio de navegador -> TCLLM traspasa las sesiones al perfil del nuevo
const sw = await api('/browser/use', { method: 'POST', body: { browser: OTHER } });
check(`cambio a ${OTHER}`, sw.applied === true || sw.unchanged === true, JSON.stringify(sw.sessions || {}).slice(0, 120));
await tool('navigate', { url: 'https://example.com/' });
const afterSwitch = textOf(await tool('evaluate', { function: '() => document.cookie' }));
check(`persiste al pasar a ${OTHER}`, afterSwitch.includes(VALUE), afterSwitch.trim().slice(0, 80));

// vuelve al navegador original
if (before !== OTHER) await api('/browser/use', { method: 'POST', body: { browser: before } });
const end = await api('/sessions');
console.log(`Bolsa común: ${end.shared.cookies} cookies · perfiles: ${end.profiles.map(p => p.id + ' ' + p.sizeMB + 'MB').join(', ')}`);
console.log(`\n${failures ? 'RESULTADO: FALLO' : 'RESULTADO: OK'}`);
process.exit(failures ? 1 : 0);
