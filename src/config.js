// Configuración de TCLLM: config.json (junto al paquete o en TCLLM_HOME) con valores por defecto.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOME = process.env.TCLLM_HOME || path.join(os.homedir(), '.tcllm');
export const CONFIG_FILE = process.env.TCLLM_CONFIG || path.join(HOME, 'config.json');

const DEFAULTS = {
  server: { host: '127.0.0.1', port: 7777, apiKey: '' },
  paths: {
    vboxManage: 'C:\\Program Files\\Oracle\\VirtualBox\\VBoxManage.exe',
    virtualBoxVM: 'C:\\Program Files\\Oracle\\VirtualBox\\VirtualBoxVM.exe',
    dataDir: path.join(HOME, 'data'),
  },
  // VMs conocidas (credenciales del guest para guestcontrol/SSH). Las demás se listan pero sin control interno.
  vms: {
    // "MiVM": { user: "<usuario del guest>", password: "<contrasena>", sshPort: 2222, sshKey: "C:\\Users\\<tu>\\.ssh\\id_ed25519", sharedFolder: "C:\\compartida" }
  },
  playwright: {
    enabled: true,
    port: 8932,
    host: '127.0.0.1',
    allowedHosts: [],            // extra hosts para --allowed-hosts (cabecera Host, host:port exacto; además de host:port propios)
    allowAnyHost: false,         // --allowed-hosts * : acepta cualquier cabecera Host (desactiva la protección anti-rebinding)
    allowedNetworks: [],         // IPs/subredes de CLIENTE permitidas por el firewall de Windows (p.ej. "192.168.2.0/24"); [] = no gestionado
    browser: 'firefox',          // por defecto Firefox (build de Playwright); tambien chrome | msedge | brave | chromium | webkit (ver src/browsers.js)
    executablePath: '',          // ruta a un ejecutable Chromium alternativo (Vivaldi, Opera...) o build propia
    // 'persistent': perfil en disco por navegador (~/.tcllm/profiles/<id>) -> los logins sobreviven al cierre y, al
    //   cambiar de navegador, TCLLM traspasa cookies/localStorage. Todos los clientes comparten el contexto.
    // 'isolated': contexto en memoria por cliente (aislamiento entre agentes), pero NO persiste nada.
    sessions: 'persistent',
    profilesDir: '',             // por defecto ~/.tcllm/profiles
    isolated: true,              // solo se usa en sessions:'isolated'
    headless: false,
    storageState: '',            // bolsa común de logins (portable entre navegadores); vacío = ~/.tcllm/storage-state.json
    freeFileDialogs: false,      // --init-page para no interceptar el diálogo de archivos (útil para humanos)
    blockLeaveDialogs: true,     // --init-script que impide los cuadros "¿Salir del sitio?" (beforeunload) en todas las páginas
    callTimeoutMs: 300000,       // tiempo máximo de una llamada a una tool del navegador (el SDK traía 60 s)
    // Argumentos extra para Chrome/Edge/Brave (van por un --config al Playwright MCP). --test-type oculta el aviso
    // "No se admite el indicador --disable-blink-features=AutomationControlled" sin quitar ese indicador, que el MCP
    // pone para que los sitios no detecten la automatización (y no bloqueen los logins).
    chromeArgs: ['--test-type'],
    keepBrowserVisible: true,    // el monitor muestra la ventana del navegador si aparece oculta sin que TCLLM la haya ocultado
    extraArgs: [],
    restartDelayMs: 3000,
  },
  monitor: { intervalMs: 10000, historySize: 500 },
  watchdog: { enabled: true, samplesToReset: 3, sampleMs: 30000 },
};

function deepMerge(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = deepMerge(base[k], v);
    else out[k] = v;
  }
  return out;
}

let cached = null;

export function loadConfig() {
  let file = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try { file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '')); } // tolera BOM (PowerShell 5.1)
    catch (e) { throw new Error(`config.json inválido (${CONFIG_FILE}): ${e.message}`); }
  }
  const cfg = deepMerge(DEFAULTS, file);
  if (!cfg.server.apiKey) {
    cfg.server.apiKey = crypto.randomBytes(24).toString('base64url');
    saveConfig(cfg);
  }
  fs.mkdirSync(cfg.paths.dataDir, { recursive: true });
  cached = cfg;
  return cfg;
}

export function getConfig() { return cached || loadConfig(); }

export function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
  cached = cfg;
}

// Versión sin secretos para el panel/API.
export function redactedConfig(cfg = getConfig()) {
  const c = JSON.parse(JSON.stringify(cfg));
  c.server.apiKey = c.server.apiKey ? '***' : '';
  for (const vm of Object.values(c.vms)) if (vm.password) vm.password = '***';
  return c;
}

export function vmCredentials(name) {
  const v = getConfig().vms[name];
  return v ? { user: v.user, password: v.password, sshPort: v.sshPort, sshKey: v.sshKey } : null;
}
