// Exporta cookies/localStorage a storage-state.json para que los agentes del Playwright MCP de TCLLM (modo --isolated)
// arranquen logueados. Abre el MISMO navegador que usa el servidor (config playwright.browser) con un perfil persistente:
// te logueas, vuelves a esta consola y pulsas Enter → se guarda el estado y se cierra el navegador. El servidor lo relee
// en cada contexto nuevo: no hace falta reiniciarlo.
//
//   tcllm login [--browser chrome|msedge|brave|chromium|firefox|webkit] [--profile <dir>] [--out <archivo>]
//               [--visit <url>[,<url>...]] [--auto] [--replace]
//
// --visit   abre esas URLs antes de guardar. IMPORTANTE: el localStorage solo se exporta de los orígenes visitados en
//           ESTA sesión (así funciona Playwright); las cookies se exportan todas.
// --auto    no espera Enter: visita (si hay --visit), guarda y cierra. Para refrescos por script.
// --replace reemplaza el archivo destino. Por defecto FUSIONA con el existente (cookies por dominio+path+nombre,
//           localStorage por origen+clave), para acumular logins de varios perfiles o navegadores.
// Autoguarda cada 30 s y al cerrar pestañas, por si cierras la ventana a mano.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { PKG_ROOT, HOME, getConfig } from '../src/config.js';
import { CATALOG, detect } from '../src/browsers.js';

const require_ = createRequire(import.meta.url);
const pw = require_(path.join(PKG_ROOT, 'node_modules', 'playwright-core'));

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const flag = (name) => args.includes(name);
const cfg = getConfig().playwright;
const browserId = opt('--browser', cfg.browser);
const outFile = path.resolve(opt('--out', cfg.storageState || path.join(HOME, 'storage-state.json')));
const profileDir = path.resolve(opt('--profile', path.join(HOME, `login-profile-${browserId}`)));
const visits = opt('--visit', '').split(',').map(s => s.trim()).filter(Boolean);
const auto = flag('--auto');
const replace = flag('--replace');

const CANARY = { name: 'pwmcp_test', value: 'ok', domain: 'example.com', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' };

/** Lanza un contexto persistente con el navegador del catálogo (mismo motor/canal que el servidor). */
async function launch(id) {
  const c = Object.hasOwn(CATALOG, id) ? CATALOG[id] : null;
  if (!c) throw new Error(`Navegador desconocido: ${id}. Opciones: ${Object.keys(CATALOG).join(', ')}`);
  const d = detect()[id];
  if (!d.installed && !cfg.executablePath) throw new Error(`${d.title} no está instalado.${d.installable ? ' Instálalo con browser_install o desde el panel.' : ''}`);
  const base = { headless: false, viewport: null };
  if (c.kind === 'channel') return pw.chromium.launchPersistentContext(profileDir, { ...base, ...(cfg.executablePath ? { executablePath: cfg.executablePath } : { channel: c.channel }) });
  if (c.kind === 'exe') return pw.chromium.launchPersistentContext(profileDir, { ...base, executablePath: cfg.executablePath || d.path });
  return pw[c.engine].launchPersistentContext(profileDir, base);
}

function readExisting() {
  if (replace) return { cookies: [], origins: [] };
  try {
    const s = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    return { cookies: Array.isArray(s.cookies) ? s.cookies : [], origins: Array.isArray(s.origins) ? s.origins : [] };
  } catch { return { cookies: [], origins: [] }; }
}

function merge(base, add) {
  const now = Date.now() / 1000;
  const live = c => !(c.expires > 0 && c.expires < now);
  const key = c => `${c.domain}|${c.path}|${c.name}`;
  const cookies = new Map(base.cookies.filter(live).map(c => [key(c), c]));
  for (const c of add.cookies.filter(live)) cookies.set(key(c), c);
  const origins = new Map(base.origins.map(o => [o.origin, o]));
  for (const o of add.origins) {
    const prev = origins.get(o.origin);
    if (!prev) { origins.set(o.origin, o); continue; }
    const ls = new Map((prev.localStorage || []).map(i => [i.name, i]));
    for (const i of o.localStorage || []) ls.set(i.name, i);
    origins.set(o.origin, { ...prev, ...o, localStorage: [...ls.values()] });
  }
  return { cookies: [...cookies.values()], origins: [...origins.values()] };
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
const context = await launch(browserId);

let closed = false;
let lastSaved = null;
async function save(reason) {
  if (closed) return false;
  try {
    const fresh = await context.storageState();
    const state = merge(readExisting(), fresh);
    // Cookie canario (solo se envía a example.com): permite que test/multi-client.mjs verifique la inyección de logins.
    state.cookies = state.cookies.filter(c => c.name !== CANARY.name);
    state.cookies.push(CANARY);
    const tmp = `${outFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, outFile);
    const real = state.cookies.filter(c => c.name !== CANARY.name);
    const domains = [...new Set(real.map(c => c.domain.replace(/^\./, '')))].sort();
    lastSaved = new Date();
    console.log(`[${lastSaved.toLocaleTimeString()}] guardado (${reason}${replace ? ', reemplazo' : ', fusionado'}): ${real.length} cookies, ${state.origins.length} origins con localStorage -> ${outFile}`);
    console.log(`   este perfil aportó: ${fresh.cookies.length} cookies, ${fresh.origins.length} origins (${fresh.origins.map(o => o.origin).join(', ') || 'ninguno'})`);
    if (domains.length) console.log(`   dominios: ${domains.join(', ')}`);
    return true;
  } catch (e) {
    console.log(`   no se pudo guardar (${reason}): ${e.message}`);
    return false;
  }
}

context.on('page', page => page.on('close', () => { if (!closed && context.pages().length) save('pestaña cerrada'); }));
const timer = setInterval(() => save('autoguardado'), 30_000);
context.on('close', () => {
  if (closed) return;
  closed = true;
  clearInterval(timer);
  console.log(lastSaved
    ? `Navegador cerrado. Último guardado: ${lastSaved.toLocaleTimeString()}.`
    : 'Navegador cerrado sin haber guardado nada (cierra con Enter en la consola la próxima vez).');
  process.exit(lastSaved ? 0 : 1);
});

console.log(`Navegador: ${CATALOG[browserId].title} (${browserId})`);
console.log(`Perfil:    ${profileDir}`);
console.log(`Destino:   ${outFile} (${replace ? 'reemplazar' : 'fusionar con el existente'})`);
console.log('');

for (const [i, url] of visits.entries()) {
  const page = i === 0 && context.pages().length ? context.pages()[0] : await context.newPage();
  process.stdout.write(`Visitando ${url} ... `);
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(3_000); // redirecciones de SPA / SSO
    console.log(`-> ${page.url()}  [${(await page.title().catch(() => '')).slice(0, 60)}]`);
  } catch (e) {
    console.log(`ERROR: ${e.message.split('\n')[0]}`);
  }
}

if (auto) {
  const ok = await save('auto');
  clearInterval(timer);
  closed = true;
  await context.close().catch(() => {});
  process.exit(ok ? 0 : 1);
}

console.log('Navegador abierto. Loguea/visita los sitios que quieras que los agentes tengan.');
console.log('Cuando termines, pulsa Enter AQUÍ para guardar y cerrar.');
console.log('');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await new Promise(resolve => rl.question('', resolve));
rl.close();
const ok = await save('Enter');
clearInterval(timer);
closed = true;
await context.close().catch(() => {});
process.exit(ok ? 0 : 1);
