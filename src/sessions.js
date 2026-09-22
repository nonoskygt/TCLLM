// Sesiones persistentes: que los logins sobrevivan al cierre del navegador Y al cambio de navegador.
//
// Dos piezas, porque Playwright no da las dos en una:
//   1) Perfil en disco por navegador (~/.tcllm/profiles/<id>) -> --user-data-dir. Lo que loguees queda ahí
//      (cookies, localStorage, IndexedDB...) y sobrevive a reinicios del MISMO navegador.
//      Ojo: el perfil es por motor; el de Chrome no lo puede leer Firefox.
//   2) Bolsa común (~/.tcllm/storage-state.json): cookies + localStorage portables ENTRE navegadores.
//      Al dejar un navegador se exporta su perfil a la bolsa; al entrar en otro se siembra desde la bolsa.
//
// Export/siembra solo con el Playwright MCP parado: el perfil queda bloqueado mientras el navegador corre.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PKG_ROOT, HOME, getConfig } from './config.js';
import { CATALOG, detect } from './browsers.js';
import { log } from './log.js';

const L = log('sessions');
const require_ = createRequire(import.meta.url);
const pw = require_(path.join(PKG_ROOT, 'node_modules', 'playwright-core'));

export const PROFILES_DIR = () => getConfig().playwright.profilesDir || path.join(HOME, 'profiles');
export const profileDir = (id) => path.join(PROFILES_DIR(), id);
export const sharedFile = () => getConfig().playwright.storageState || path.join(HOME, 'storage-state.json');

/** Abre un contexto persistente sobre un perfil con el navegador del catálogo (mismo motor/canal que usa el MCP). */
export async function launchProfile(id, dir = profileDir(id), { headless = true } = {}) {
  const c = Object.hasOwn(CATALOG, id) ? CATALOG[id] : null;
  if (!c) throw new Error(`Navegador desconocido: ${id}`);
  const d = detect()[id];
  const exe = getConfig().playwright.executablePath || '';
  fs.mkdirSync(dir, { recursive: true });
  const base = { headless, viewport: null };
  if (c.kind === 'channel') return pw.chromium.launchPersistentContext(dir, { ...base, ...(exe ? { executablePath: exe } : { channel: c.channel }) });
  if (c.kind === 'exe') {
    const p = exe || d.path;
    if (!p) throw new Error(`${d.title} no está instalado`);
    return pw.chromium.launchPersistentContext(dir, { ...base, executablePath: p });
  }
  if (!d.installed) throw new Error(`${d.title} no está instalado (browser_install)`);
  return pw[c.engine].launchPersistentContext(dir, base);
}

const EMPTY = { cookies: [], origins: [] };
const liveCookie = (c) => !(c.expires > 0 && c.expires < Date.now() / 1000);

/** Fusiona dos storage states: cookies por dominio+path+nombre, localStorage por origen+clave. Gana `add`. */
export function merge(base = EMPTY, add = EMPTY) {
  const key = (c) => `${c.domain}|${c.path}|${c.name}`;
  const cookies = new Map((base.cookies || []).filter(liveCookie).map(c => [key(c), c]));
  for (const c of (add.cookies || []).filter(liveCookie)) cookies.set(key(c), c);
  const origins = new Map((base.origins || []).map(o => [o.origin, o]));
  for (const o of add.origins || []) {
    const prev = origins.get(o.origin);
    if (!prev) { origins.set(o.origin, o); continue; }
    const ls = new Map((prev.localStorage || []).map(i => [i.name, i]));
    for (const i of o.localStorage || []) ls.set(i.name, i);
    origins.set(o.origin, { ...prev, ...o, localStorage: [...ls.values()] });
  }
  return { cookies: [...cookies.values()], origins: [...origins.values()] };
}

export function readShared() {
  try {
    const s = JSON.parse(fs.readFileSync(sharedFile(), 'utf8'));
    return { cookies: Array.isArray(s.cookies) ? s.cookies : [], origins: Array.isArray(s.origins) ? s.origins : [] };
  } catch { return { ...EMPTY }; }
}

export function writeShared(state) {
  const f = sharedFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, f);   // atómico: nadie lee un archivo a medias
  return f;
}

/** ¿Hay perfil en disco para ese navegador? */
export function hasProfile(id) { try { return fs.readdirSync(profileDir(id)).length > 0; } catch { return false; } }

/** Exporta el estado (cookies + localStorage) del perfil de un navegador. Requiere el MCP parado. */
export async function exportFrom(id, { timeoutMs = 60000 } = {}) {
  if (!hasProfile(id)) { L.debug(`sin perfil para ${id}: nada que exportar`); return { ...EMPTY }; }
  let ctx = null;
  const t = setTimeout(() => { ctx?.close().catch(() => {}); }, timeoutMs);
  try {
    ctx = await launchProfile(id);
    const state = await ctx.storageState();
    L.info(`exportadas ${state.cookies.length} cookies y ${state.origins.length} orígenes del perfil ${id}`);
    return state;
  } finally { clearTimeout(t); await ctx?.close().catch(() => {}); }
}

/** Siembra un perfil con el estado común: cookies siempre; localStorage visitando cada origen (best-effort). */
export async function seedInto(id, state = readShared(), { withLocalStorage = true, timeoutMs = 120000 } = {}) {
  const cookies = (state.cookies || []).filter(liveCookie);
  const origins = state.origins || [];
  if (!cookies.length && !origins.length) return { cookies: 0, origins: 0, skipped: true };
  let ctx = null;
  const t = setTimeout(() => { ctx?.close().catch(() => {}); }, timeoutMs);
  let seededOrigins = 0;
  try {
    ctx = await launchProfile(id);
    if (cookies.length) await ctx.addCookies(cookies).catch(e => L.warn(`addCookies: ${e.message.split('\n')[0]}`));
    // localStorage no se puede inyectar sin estar en el origen: visitamos cada uno y lo escribimos. Si el sitio
    // no responde, se salta (las cookies, que es lo que sostiene casi todo login, ya quedaron puestas).
    if (withLocalStorage) {
      for (const o of origins) {
        if (!o.localStorage?.length) continue;
        const page = await ctx.newPage();
        try {
          await page.goto(o.origin, { waitUntil: 'commit', timeout: 15000 });
          await page.evaluate((items) => { for (const i of items) { try { localStorage.setItem(i.name, i.value); } catch {} } }, o.localStorage);
          seededOrigins++;
        } catch (e) { L.debug(`localStorage ${o.origin}: ${e.message.split('\n')[0]}`); }
        finally { await page.close().catch(() => {}); }
      }
    }
    L.info(`perfil ${id} sembrado: ${cookies.length} cookies, ${seededOrigins}/${origins.length} orígenes con localStorage`);
    return { cookies: cookies.length, origins: seededOrigins, totalOrigins: origins.length };
  } finally { clearTimeout(t); await ctx?.close().catch(() => {}); }
}

/** Guarda en la bolsa común lo que haya en el perfil de `id` (logins hechos por los agentes incluidos). */
export async function saveFrom(id) {
  const fresh = await exportFrom(id);
  if (!fresh.cookies.length && !fresh.origins.length) return { saved: false, cookies: 0 };
  const merged = merge(readShared(), fresh);
  writeShared(merged);
  return { saved: true, cookies: merged.cookies.length, origins: merged.origins.length, file: sharedFile() };
}

/** Lleva las sesiones de un navegador a otro: exporta el viejo a la bolsa y siembra el nuevo. MCP parado. */
export async function transfer(fromId, toId, { withLocalStorage = true } = {}) {
  const out = { from: fromId, to: toId };
  if (fromId && fromId !== toId) out.saved = await saveFrom(fromId).catch(e => ({ saved: false, error: e.message }));
  out.seeded = await seedInto(toId, readShared(), { withLocalStorage }).catch(e => ({ error: e.message }));
  return out;
}

/** Resumen para el panel/API. */
export function status() {
  const cfg = getConfig().playwright;
  const shared = readShared();
  const profiles = Object.keys(CATALOG).filter(hasProfile).map(id => {
    let bytes = 0;
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); try { if (e.isDirectory()) walk(p); else bytes += fs.statSync(p).size; } catch {} } };
    try { walk(profileDir(id)); } catch {}
    return { id, title: CATALOG[id].title, dir: profileDir(id), sizeMB: Math.round(bytes / 1048576) };
  });
  const domains = [...new Set(shared.cookies.map(c => String(c.domain || '').replace(/^\./, '')))].sort();
  return {
    mode: cfg.sessions || 'persistent',
    persistent: (cfg.sessions || 'persistent') === 'persistent',
    profilesDir: PROFILES_DIR(), sharedFile: sharedFile(),
    shared: { cookies: shared.cookies.length, origins: shared.origins.length, domains },
    profiles,
  };
}
