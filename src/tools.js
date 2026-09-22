// Registro único de tools de TCLLM. De aquí salen: servidor MCP, API REST (/api/tools), export OpenAI y OpenAPI.
// Cada tool: { name, description, inputSchema (JSON Schema), handler(args) -> result }
// result: cualquier JSON serializable, o { image: Buffer, mime, width, height, ... } para imágenes.
import * as vm from './vm.js';
import * as input from './input.js';
import * as windows from './windows.js';
import { playwright } from './playwright.js';
import { bridge } from './bridge.js';
import { services } from './services.js';
import * as browsers from './browsers.js';
import * as sessions from './sessions.js';

const S = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const VM = { type: 'string', description: 'Nombre de la VM en VirtualBox (p.ej. "Win11")' };
const NUM = (d) => ({ type: 'number', description: d });
const STR = (d) => ({ type: 'string', description: d });
const BOOL = (d) => ({ type: 'boolean', description: d });

export const tools = [
  // ---------- VMs ----------
  { name: 'vm_list', description: 'Lista las máquinas virtuales de VirtualBox con su estado (running/poweroff/saved), snapshots y si TCLLM puede controlarlas por dentro.', inputSchema: S({}), handler: () => vm.listAll() },
  { name: 'vm_info', description: 'Detalle de una VM: estado, RAM, CPUs, Guest Additions, snapshots, reenvíos de puertos.', inputSchema: S({ vm: VM }, ['vm']), handler: ({ vm: n }) => vm.summary(n) },
  { name: 'vm_start', description: 'Enciende (o reanuda) la VM y espera a que Windows responda. Resetea automáticamente si detecta el cuelgue de arranque/reinicio de VirtualBox sobre Hyper-V. Tarda 1-5 minutos.', inputSchema: S({ vm: VM, type: { type: 'string', enum: ['headless', 'gui', 'separate'], description: 'headless (sin ventana, por defecto) o con ventana' }, wait: BOOL('Esperar a que el guest responda (por defecto true)') }, ['vm']), handler: ({ vm: n, type, wait }) => vm.start(n, { type, wait: wait !== false, onEvent: services.emit }) },
  { name: 'vm_stop', description: 'Apaga la VM limpiamente (shutdown /s dentro del guest o botón ACPI); poweroff forzado si no apaga en 4 min. force=true apaga de golpe.', inputSchema: S({ vm: VM, force: BOOL('Apagado forzado inmediato') }, ['vm']), handler: ({ vm: n, force }) => vm.stop(n, { force }) },
  { name: 'vm_restart', description: 'Reinicia Windows dentro de la VM de forma segura (shutdown /r + watchdog que resetea si el reinicio se cuelga) y espera a que responda. ÚSALO en vez de reiniciar desde Windows.', inputSchema: S({ vm: VM }, ['vm']), handler: ({ vm: n }) => vm.restart(n, { onEvent: services.emit }) },
  { name: 'vm_reset', description: 'Reset duro (como pulsar reset). Útil si la VM está colgada en negro.', inputSchema: S({ vm: VM }, ['vm']), handler: ({ vm: n }) => vm.reset(n) },
  { name: 'vm_save_state', description: 'Guarda el estado de la VM en disco y la detiene (como hibernar).', inputSchema: S({ vm: VM }, ['vm']), handler: ({ vm: n }) => vm.saveState(n) },
  { name: 'vm_screenshot', description: 'Captura de pantalla de la VM (PNG). Las coordenadas para vm_click/vm_drag son las de esta imagen (0,0 arriba a la izquierda).', inputSchema: S({ vm: VM }, ['vm']), handler: async ({ vm: n }) => { const s = await vm.screenshot(n); return { image: s.png, mime: 'image/png', width: s.width, height: s.height }; } },
  { name: 'vm_click', description: 'Clic de ratón en la VM en coordenadas de la captura.', inputSchema: S({ vm: VM, x: NUM('X'), y: NUM('Y'), button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Botón (left por defecto)' }, count: NUM('1 = clic, 2 = doble clic') }, ['vm', 'x', 'y']), handler: ({ vm: n, x, y, button, count }) => input.click(n, x, y, button || 'left', count || 1) },
  { name: 'vm_move', description: 'Mueve el puntero del ratón de la VM (hover).', inputSchema: S({ vm: VM, x: NUM('X'), y: NUM('Y') }, ['vm', 'x', 'y']), handler: ({ vm: n, x, y }) => input.move(n, x, y) },
  { name: 'vm_drag', description: 'Arrastra con el botón izquierdo desde (x1,y1) hasta (x2,y2).', inputSchema: S({ vm: VM, x1: NUM('X inicio'), y1: NUM('Y inicio'), x2: NUM('X fin'), y2: NUM('Y fin') }, ['vm', 'x1', 'y1', 'x2', 'y2']), handler: ({ vm: n, x1, y1, x2, y2 }) => input.drag(n, x1, y1, x2, y2) },
  { name: 'vm_scroll', description: 'Rueda del ratón en (x,y): amount>0 baja, amount<0 sube (en "ticks").', inputSchema: S({ vm: VM, x: NUM('X'), y: NUM('Y'), amount: NUM('Ticks, negativo = arriba') }, ['vm', 'x', 'y', 'amount']), handler: ({ vm: n, x, y, amount }) => input.scroll(n, x, y, amount) },
  { name: 'vm_key', description: 'Pulsa una tecla o combinación en la VM: "enter", "ctrl+alt+del", "win+r", "alt+f4", "ctrl+shift+esc", "f5", "up"...', inputSchema: S({ vm: VM, keys: STR('Combinación, teclas separadas por +') }, ['vm', 'keys']), handler: ({ vm: n, keys }) => input.key(n, keys) },
  { name: 'vm_type', description: 'Escribe texto en la VM como si se tecleara (ASCII por scancodes; si hay caracteres no ASCII usa el portapapeles). Para texto largo usa vm_paste.', inputSchema: S({ vm: VM, text: STR('Texto a escribir') }, ['vm', 'text']), handler: ({ vm: n, text }) => input.type(n, text) },
  { name: 'vm_paste', description: 'Pega texto (Unicode, cualquier longitud) en la VM vía portapapeles compartido + Ctrl+V.', inputSchema: S({ vm: VM, text: STR('Texto a pegar') }, ['vm', 'text']), handler: ({ vm: n, text }) => input.paste(n, text) },
  { name: 'vm_run', description: 'Ejecuta PowerShell DENTRO de la VM y devuelve la salida como texto. admin=true lo ejecuta elevado (sin prompt UAC). Es la forma correcta de leer datos del guest (procesos, archivos, registro...), no las capturas.', inputSchema: S({ vm: VM, command: STR('Código PowerShell'), admin: BOOL('Ejecutar elevado (administrador)'), timeoutMs: NUM('Timeout en ms (120000 por defecto)') }, ['vm', 'command']), handler: async ({ vm: n, command, admin, timeoutMs }) => ({ output: admin ? await vm.runAdmin(n, command, { timeoutMs }) : await vm.run(n, command, { timeoutMs }) }) },
  { name: 'vm_ssh', description: 'Ejecuta un comando por SSH en la VM (PowerShell, token elevado). Requiere sshPort/sshKey en la config de la VM.', inputSchema: S({ vm: VM, command: STR('Comando') }, ['vm', 'command']), handler: async ({ vm: n, command }) => ({ output: await vm.runSSH(n, command) }) },
  { name: 'vm_copy_to', description: 'Copia un archivo del host a un directorio de la VM.', inputSchema: S({ vm: VM, localPath: STR('Ruta en el host'), guestDir: STR('Directorio destino en la VM') }, ['vm', 'localPath', 'guestDir']), handler: async ({ vm: n, localPath, guestDir }) => { await vm.copyTo(n, localPath, guestDir); return { copied: localPath, to: guestDir }; } },
  { name: 'vm_copy_from', description: 'Copia un archivo de la VM a un directorio del host.', inputSchema: S({ vm: VM, guestPath: STR('Ruta en la VM'), localDir: STR('Directorio destino en el host') }, ['vm', 'guestPath', 'localDir']), handler: async ({ vm: n, guestPath, localDir }) => { await vm.copyFrom(n, guestPath, localDir); return { copied: guestPath, to: localDir }; } },
  { name: 'vm_show', description: 'Muestra la ventana de la VM en el escritorio del host (si corre headless, le engancha una ventana).', inputSchema: S({ vm: VM }, ['vm']), handler: ({ vm: n }) => vm.show(n) },
  { name: 'vm_hide', description: 'Oculta la ventana de la VM (la VM sigue corriendo).', inputSchema: S({ vm: VM }, ['vm']), handler: ({ vm: n }) => vm.hide(n) },
  { name: 'vm_snapshot_list', description: 'Lista los snapshots de la VM.', inputSchema: S({ vm: VM }, ['vm']), handler: ({ vm: n }) => vm.snapshots.list(n) },
  { name: 'vm_snapshot_take', description: 'Crea un snapshot de la VM (funciona en caliente).', inputSchema: S({ vm: VM, name: STR('Nombre del snapshot'), description: STR('Descripción') }, ['vm', 'name']), handler: ({ vm: n, name, description }) => vm.snapshots.take(n, name, description) },
  { name: 'vm_snapshot_restore', description: 'Restaura un snapshot (la VM debe estar apagada). Descarta el estado actual.', inputSchema: S({ vm: VM, name: STR('Nombre del snapshot') }, ['vm', 'name']), handler: ({ vm: n, name }) => vm.snapshots.restore(n, name) },
  { name: 'vm_snapshot_delete', description: 'Borra un snapshot.', inputSchema: S({ vm: VM, name: STR('Nombre del snapshot') }, ['vm', 'name']), handler: ({ vm: n, name }) => vm.snapshots.delete(n, name) },

  // ---------- Ventanas ----------
  { name: 'windows_list', description: 'Lista las ventanas gestionables del host: las de las VMs (VirtualBoxVM) y las del navegador de Playwright, con su hwnd y visibilidad.', inputSchema: S({}), handler: () => windows.list() },
  { name: 'window_show', description: 'Muestra (y trae al frente) una ventana por hwnd.', inputSchema: S({ hwnd: STR('hwnd de windows_list') }, ['hwnd']), handler: ({ hwnd }) => windows.show(hwnd) },
  { name: 'window_hide', description: 'Oculta una ventana por hwnd (el proceso sigue).', inputSchema: S({ hwnd: STR('hwnd de windows_list') }, ['hwnd']), handler: ({ hwnd }) => windows.hide(hwnd) },
  // ---------- Navegadores ----------
  { name: 'browser_list', description: 'Navegadores disponibles para Playwright (Chrome, Edge, Brave, Chromium, Firefox, WebKit): cuáles están instalados y cuál está activo.', inputSchema: S({}), handler: async () => { const st = await playwright.status(); return { active: st.adopted ? null : playwright.cfg.browser, configured: playwright.cfg.browser, executablePath: playwright.cfg.executablePath || '', note: st.adopted ? st.adoptedNote : undefined, browsers: Object.values(browsers.detect()), playwright: st }; } },
  { name: 'browser_use', description: 'Cambia el navegador que controla Playwright: se guarda en config y se relanza el Playwright MCP, así que TODOS los agentes conectados pierden sus pestañas. Si ya es el activo no hace nada. Firefox/Chromium/WebKit deben estar instalados (browser_install).', inputSchema: S({ browser: { type: 'string', enum: Object.keys(browsers.CATALOG), description: 'chrome | msedge | brave | chromium | firefox | webkit' }, executablePath: STR('Solo con brave/chromium: ruta a otro ejecutable Chromium (Vivaldi, Opera...)') }, ['browser']), handler: ({ browser, executablePath }) => playwright.useBrowser(browser, { executablePath }) },
  { name: 'browser_install', description: 'Descarga e instala una build de Playwright (chromium, firefox o webkit; 100-200 MB). BLOQUEA hasta terminar (de segundos a varios minutos según la conexión); si tu cliente corta por timeout la descarga sigue: vuelve a llamar, es idempotente. Chrome/Edge/Brave se instalan desde su web.', inputSchema: S({ browser: { type: 'string', enum: ['chromium', 'firefox', 'webkit'] } }, ['browser']), handler: async ({ browser }) => ({ installed: await browsers.install(browser), status: browsers.installStatus(browser) }) },
  { name: 'browser_windows_show', description: 'Muestra las ventanas del navegador controlado por Playwright.', inputSchema: S({}), handler: () => windows.showBrowser() },
  { name: 'browser_windows_hide', description: 'Oculta las ventanas del navegador controlado por Playwright (sigue funcionando).', inputSchema: S({}), handler: () => windows.hideBrowser() },

  // ---------- Sesiones (logins persistentes) ----------
  { name: 'sessions_status', description: 'Estado de las sesiones persistentes: modo (persistent/isolated), perfiles en disco por navegador y qué logins hay en la bolsa común (cookies y dominios).', inputSchema: S({}), handler: () => sessions.status() },
  { name: 'sessions_save', description: 'Guarda en la bolsa común los logins que haya ahora en el perfil del navegador activo, para que se puedan llevar a otro navegador. OJO: reinicia el navegador (el perfil está bloqueado mientras corre) y se pierden las pestañas abiertas.', inputSchema: S({}), handler: () => playwright.saveSessions() },

  // ---------- Servicios ----------
  { name: 'services_status', description: 'Estado de todos los servicios: TCLLM, VirtualBox, cada VM, Playwright MCP (navegador) y el host (CPU/RAM/discos).', inputSchema: S({}), handler: () => services.status() },
  { name: 'service_restart', description: 'Reinicia un servicio gestionado: "playwright" (servidor MCP del navegador) o "bridge" (puente PowerShell).', inputSchema: S({ service: { type: 'string', enum: ['playwright', 'bridge'] } }, ['service']), handler: async ({ service }) => { if (service === 'playwright') return playwright.restart(); bridge.stop(); await new Promise(r => setTimeout(r, 1500)); await bridge.start(); return { service, restarted: true }; } },
  { name: 'services_events', description: 'Últimos eventos del monitor (cambios de estado, reinicios, avisos).', inputSchema: S({ limit: NUM('Máximo de eventos (50 por defecto)') }), handler: ({ limit }) => services.events(limit || 50) },
];

export const toolByName = Object.fromEntries(tools.map(t => [t.name, t]));

/** Tools del Playwright MCP, expuestas con prefijo browser_ (proxy 1:1). */
export async function browserTools() {
  try {
    const up = await playwright.listTools();
    return up.map(t => ({ name: 'browser_' + t.name.replace(/^browser_/, ''), upstream: t.name, description: t.description, inputSchema: t.inputSchema, proxy: true }));
  } catch { return []; }
}

export async function callTool(name, args = {}) {
  const t = toolByName[name];
  if (t) return t.handler(args || {});
  if (name.startsWith('browser_')) {
    const bt = (await browserTools()).find(b => b.name === name);
    if (!bt) throw new Error(`Tool desconocida: ${name}`);
    return { upstream: await playwright.callTool(bt.upstream, args || {}) };
  }
  throw new Error(`Tool desconocida: ${name}`);
}

/** Definiciones en formato OpenAI "tools" (function calling) para cualquier LLM. */
export async function openaiTools({ includeBrowser = true } = {}) {
  const all = [...tools, ...(includeBrowser ? await browserTools() : [])];
  return all.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
}
