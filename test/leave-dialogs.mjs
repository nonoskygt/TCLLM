// Prueba: con playwright.blockLeaveDialogs (por defecto) una página que registra "beforeunload" NO debe hacer
// aparecer el cuadro "¿Salir del sitio?" al navegar fuera. Requiere un TCLLM en marcha.
//
//   TCLLM_URL=http://127.0.0.1:7777 TCLLM_KEY=... node test/leave-dialogs.mjs [--expect-dialog]
//
// --expect-dialog invierte la comprobación (para verificar el caso con blockLeaveDialogs=false).
const URL_ = (process.env.TCLLM_URL || 'http://127.0.0.1:7777').replace(/\/$/, '');
const KEY = process.env.TCLLM_KEY;
const EXPECT_DIALOG = process.argv.includes('--expect-dialog');
if (!KEY) { console.error('Falta TCLLM_KEY'); process.exit(2); }

const api = async (p, body) => {
  const r = await fetch(URL_ + '/api' + p, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status} ${j.error || ''}`);
  return j;
};
const tool = (name, args = {}) => api(`/browser/tools/${name}`, args);
const textOf = (r) => (r.upstream?.content || r.content || []).map(c => c.text || '').join('\n');

// Pestaña propia para no pisar la de otro agente (el contexto es compartido en modo persistente)
await tool('tabs', { action: 'new' });
await tool('navigate', { url: 'https://example.com/' });
// Intento de registrar el cuadro de las dos formas habituales
const reg = textOf(await tool('evaluate', { function: `() => {
  window.addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = 'x'; });
  window.onbeforeunload = () => 'x';
  return typeof window.onbeforeunload;
}` }));
// Chrome solo muestra el cuadro si la página tuvo interacción real del usuario: una tecla por CDP cuenta
await tool('press_key', { key: 'Shift' });
// Con el cuadro abierto la navegación se queda esperando hasta el timeout del cliente MCP: eso es el bug.
let nav = '', blocked = false;
try { nav = textOf(await tool('navigate', { url: 'https://example.org/' })); }
catch (e) { blocked = /timed out|timeout/i.test(e.message); nav = e.message; }
let dialog = blocked || /beforeunload|Modal state|dialog/i.test(nav);
// Si hay un cuadro abierto, se acepta (así además queda confirmado que existía) y se sigue
try {
  const h = await tool('handle_dialog', { accept: true });
  const isErr = h.upstream?.isError ?? h.isError;
  if (!isErr) dialog = true;   // solo tiene éxito si había un cuadro de verdad
} catch { /* no había cuadro */ }
if (blocked) nav = textOf(await tool('snapshot', {})).slice(0, 2000);
const url = (nav.match(/Page URL: (\S+)/) || [])[1] || '?';
await tool('tabs', { action: 'close' }).catch(() => {});

console.log(`onbeforeunload tras intentar registrarlo: ${reg.includes('"object"') ? 'null (bloqueado)' : reg.includes('function') ? 'function (registrado)' : reg.replace(/\s+/g, ' ').slice(0, 60)}`);
console.log(`Al navegar fuera: ${dialog ? 'APARECIÓ el cuadro "¿Salir del sitio?"' : 'sin cuadro'} · URL final ${url}`);
const ok = EXPECT_DIALOG ? dialog : (!dialog && /example\.org/.test(url));
console.log(ok ? 'RESULTADO: OK' : 'RESULTADO: FALLO');
process.exit(ok ? 0 : 1);
