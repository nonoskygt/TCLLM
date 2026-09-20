// Navegadores para Playwright: detección de los instalados (Chrome, Edge, Brave, y las builds propias de Playwright:
// Chromium, Firefox, WebKit), argumentos de lanzamiento e instalación bajo demanda de las builds de Playwright.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { PKG_ROOT } from './config.js';
import { log } from './log.js';

const L = log('browsers');
const require_ = createRequire(import.meta.url);
const MCP_CLI = path.join(PKG_ROOT, 'node_modules', '@playwright', 'mcp', 'cli.js');

const PF = process.env['ProgramFiles'] || 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const LAD = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

/** Catálogo: id -> cómo se detecta y cómo se lanza. kind: 'channel' (Chrome/Edge del sistema), 'exe' (Chromium de terceros), 'playwright' (build propia). */
export const CATALOG = {
  chrome:   { title: 'Google Chrome',   kind: 'channel', channel: 'chrome',   paths: [path.join(PF, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(PF86, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(LAD, 'Google', 'Chrome', 'Application', 'chrome.exe')] },
  msedge:   { title: 'Microsoft Edge',  kind: 'channel', channel: 'msedge',   paths: [path.join(PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(PF, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(LAD, 'Microsoft', 'Edge', 'Application', 'msedge.exe')] },
  brave:    { title: 'Brave',           kind: 'exe',     engine: 'chromium',  paths: [path.join(PF, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), path.join(PF86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), path.join(LAD, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')] },
  chromium: { title: 'Chromium (build de Playwright)', kind: 'playwright', engine: 'chromium', pwName: 'chromium' },
  firefox:  { title: 'Firefox (build de Playwright)',  kind: 'playwright', engine: 'firefox',  pwName: 'firefox', note: 'Playwright no puede manejar el Firefox normal: usa su propia build con parches.' },
  webkit:   { title: 'WebKit (motor de Safari)',       kind: 'playwright', engine: 'webkit',   pwName: 'webkit' },
};

function browsersDir() {
  const v = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!v) return path.join(LAD, 'ms-playwright');
  if (v === '0') return path.join(PKG_ROOT, 'node_modules', 'playwright-core', '.local-browsers');
  return path.isAbsolute(v) ? v : path.resolve(process.env.INIT_CWD || process.cwd(), v);
}

/** Revisión que exige el playwright-core empaquetado, p.ej. firefox -> "1549". */
export function requiredRevision(pwName) {
  try {
    const b = require_(path.join(PKG_ROOT, 'node_modules', 'playwright-core', 'browsers.json'));
    return b.browsers.find(x => x.name === pwName)?.revision || null;
  } catch { return null; }
}

function playwrightBuildDir(pwName) {
  const rev = requiredRevision(pwName);
  if (!rev) return null;
  const dir = path.join(browsersDir(), `${pwName}-${rev}`);
  return fs.existsSync(path.join(dir, 'INSTALLATION_COMPLETE')) ? dir : null;   // Playwright escribe el marcador al terminar de extraer
}

/** Estado de todos los navegadores del catálogo. */
export function detect() {
  const out = {};
  for (const [id, c] of Object.entries(CATALOG)) {
    if (c.kind === 'playwright') {
      const dir = playwrightBuildDir(c.pwName);
      out[id] = { id, title: c.title, kind: c.kind, installed: !!dir, path: dir, revision: requiredRevision(c.pwName), installable: true, note: c.note };
    } else {
      const p = c.paths.find(x => fs.existsSync(x)) || null;
      out[id] = { id, title: c.title, kind: c.kind, installed: !!p, path: p, installable: false, note: c.note };
    }
  }
  return out;
}

/** Argumentos de @playwright/mcp para un navegador del catálogo (o un id desconocido = canal tal cual). */
export function launchArgs(id, { executablePath } = {}) {
  const c = Object.hasOwn(CATALOG, id) ? CATALOG[id] : null;
  if (!c) throw new Error(`Navegador desconocido: ${id}. Opciones: ${Object.keys(CATALOG).join(', ')}`);
  if (c.kind === 'channel') return executablePath ? ['--browser', 'chromium', '--executable-path', executablePath] : ['--browser', c.channel];
  if (c.kind === 'exe') {
    const exe = executablePath || c.paths.find(x => fs.existsSync(x)) || c.paths[0];   // si falta, Playwright dará un error claro al lanzar
    return ['--browser', c.engine, '--executable-path', exe];
  }
  return ['--browser', c.engine, ...(executablePath ? ['--executable-path', executablePath] : [])];
}

/** Primer navegador instalado por orden de preferencia. */
export function pickDefault(pref = ['chrome', 'msedge', 'brave', 'chromium', 'firefox']) {
  const d = detect();
  return pref.find(id => d[id]?.installed) || 'msedge';
}

const installs = new Map(); // id -> { promise, status, log }
let installQueue = Promise.resolve();

/** Instala una build de Playwright (chromium|firefox|webkit) con el instalador del propio Playwright. Idempotente. */
export function install(id) {
  const c = Object.hasOwn(CATALOG, id) ? CATALOG[id] : null;
  if (!c || c.kind !== 'playwright') throw new Error(`"${id}" no es instalable desde TCLLM (solo chromium, firefox, webkit). Chrome/Edge/Brave se instalan desde su web.`);
  if (installs.get(id)?.status === 'running') return installs.get(id).promise;
  const st = { status: 'running', log: [], startedAt: Date.now() };
  // Una instalación a la vez (el instalador de Playwright usa un lock de directorio; mejor no competir)
  const prev = installQueue;
  st.promise = prev.catch(() => {}).then(() => new Promise((resolve, reject) => {
    L.info(`instalando ${id} (build de Playwright) ...`);
    // --no-remove: que el gc del instalador no borre otras builds del directorio
    const p = spawn(process.execPath, [MCP_CLI, 'install-browser', c.pwName, '--no-progress', '--no-remove'], { windowsHide: true, env: { ...process.env } });
    const ANSI = /\x1b\[[0-9;]*m/g;   // quitar colores ANSI del instalador
    const onData = (d) => { for (const line of String(d).replace(ANSI, '').split(/\r?\n/)) if (line.trim()) { st.log.push(line.trim()); if (st.log.length > 200) st.log.shift(); } };
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    p.on('error', (e) => { st.status = 'error'; st.error = e.message; reject(e); });
    p.on('exit', (code, signal) => {
      if (st.status === 'error') return;
      const ok = code === 0 && !!playwrightBuildDir(c.pwName);
      st.status = ok ? 'done' : 'error'; st.finishedAt = Date.now();
      if (ok) { L.info(`${id} instalado en ${playwrightBuildDir(c.pwName)}`); resolve(detect()[id]); }
      else { st.error = `install-browser salió con código ${code ?? ('señal ' + signal)}`; L.warn(`${id}: ${st.error}`); reject(new Error(st.error + ': ' + st.log.slice(-3).join(' | '))); }
    });
  }));
  installQueue = st.promise;
  installs.set(id, st);
  return st.promise;
}

export function installStatus(id) { const s = installs.get(id); return s ? { status: s.status, error: s.error, log: s.log.slice(-10), startedAt: s.startedAt, finishedAt: s.finishedAt } : null; }
