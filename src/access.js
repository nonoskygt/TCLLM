// Gestión de conexiones al Playwright MCP en dos capas:
//   1) Cabecera Host (--allowed-hosts de Playwright): exacto host:port, o '*' para aceptar cualquiera. NO entiende subredes.
//   2) Red de CLIENTE (firewall de Windows, puerto TCP): sí soporta IPs y subredes (192.168.2.0/24). Aplicar pide administrador.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PKG_ROOT, HOME, getConfig, saveConfig } from './config.js';
import { playwright } from './playwright.js';
import { log } from './log.js';

const L = log('access');
const FW_SCRIPT = path.join(PKG_ROOT, 'ps', 'firewall.ps1');
const RULE = (port) => `TCLLM Playwright (${port})`;

/** IPv4 no internas de la máquina, con su interfaz. */
export function localIPv4() {
  const out = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) out.push({ iface, address: a.address });
  }
  return out;
}

const IP_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const isByte = (n) => Number.isInteger(+n) && +n >= 0 && +n <= 255;
function isIPv4(s) { const m = IP_RE.exec(s); return !!m && m.slice(1).every(isByte); }
/** Valida una entrada de red: IPv4, IPv4/CIDR (0-32), rango "a-b", o los comodines any/*. Devuelve la forma normalizada o null. */
export function normalizeNetwork(s) {
  s = String(s || '').trim().toLowerCase();
  if (!s) return null;
  if (s === '*' || s === 'any' || s === 'cualquiera' || s === '0.0.0.0/0') return 'Any';
  if (s.includes('/')) { const [ip, bits] = s.split('/'); return isIPv4(ip) && Number.isInteger(+bits) && +bits >= 0 && +bits <= 32 ? `${ip}/${bits}` : null; }
  if (s.includes('-')) { const [a, b] = s.split('-').map(x => x.trim()); return isIPv4(a) && isIPv4(b) ? `${a}-${b}` : null; }
  return isIPv4(s) ? s : null;
}
/** Valida una entrada de Host (cabecera): host o host:port, sin espacios ni comas. Añade el puerto si falta. */
export function normalizeHost(s, port) {
  s = String(s || '').trim().toLowerCase();
  if (!s || /[\s,]/.test(s)) return null;
  if (s === '*') return '*';
  if (s.startsWith('[')) return /^\[[0-9a-f:]+\](:\d+)?$/.test(s) ? (s.includes(']:') ? s : `${s}:${port}`) : null;   // IPv6 [::1]:port
  const host = s.includes(':') ? s : `${s}:${port}`;
  return /^[a-z0-9.\-]+:\d+$/.test(host) ? host : null;
}

/** Hosts que el instalador/config deberían aceptar siempre: loopback + cada IPv4 local + el hostname, todos con el puerto. */
export function suggestedHosts(port) {
  const h = os.hostname().toLowerCase();
  return [...new Set([`localhost:${port}`, `127.0.0.1:${port}`, ...localIPv4().map(x => `${x.address}:${port}`), `${h}:${port}`])];
}

/** Estado del firewall para el puerto: lee las reglas propias/heredadas (no requiere administrador). */
export function firewallStatus(port) {
  return new Promise((resolve) => {
    const ps = `try{$rs=Get-NetFirewallRule -DisplayName 'TCLLM Playwright*','Playwright MCP' -ErrorAction SilentlyContinue;$o=@();foreach($r in $rs){$pf=$r|Get-NetFirewallPortFilter -ErrorAction SilentlyContinue;if(($pf.LocalPort -contains '${port}') -or ($pf.LocalPort -contains 'Any')){$af=$r|Get-NetFirewallAddressFilter -ErrorAction SilentlyContinue;$o+=[pscustomobject]@{name=$r.DisplayName;enabled=[bool]($r.Enabled -eq 1 -or $r.Enabled -eq 'True');action="$($r.Action)";remote=@($af.RemoteAddress)}}};$o|ConvertTo-Json -Compress -Depth 4}catch{'[]'}`;
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch {} resolve({ error: 'timeout leyendo el firewall' }); }, 12000);
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('error', (e) => { clearTimeout(timer); resolve({ error: e.message }); });
    p.on('exit', () => {
      clearTimeout(timer);
      try { const j = JSON.parse(out.trim() || '[]'); const rules = Array.isArray(j) ? j : [j]; resolve({ rules }); }
      catch { resolve({ error: (err || out).trim().split(/\r?\n/)[0]?.slice(0, 160) || 'sin datos' }); }
    });
  });
}

/** Comando manual (elevado) equivalente, para copiar/pegar si el usuario prefiere hacerlo a mano. */
export function firewallCommand(port = getConfig().playwright.port, nets = getConfig().playwright.allowedNetworks || []) {
  const clean = nets.map(normalizeNetwork).filter(Boolean);
  const any = clean.length === 0 || clean.includes('Any');
  const ra = any ? 'Any' : "@('" + clean.filter(n => n !== 'Any').join("','") + "')";
  return `Remove-NetFirewallRule -DisplayName '${RULE(port)}','Playwright MCP' -ErrorAction SilentlyContinue; ` +
    `New-NetFirewallRule -DisplayName '${RULE(port)}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -RemoteAddress ${ra} -Profile Any`;
}

/** Estado completo para el panel. */
export async function status() {
  const c = getConfig().playwright;
  const port = playwright.port;
  const ips = localIPv4();
  const reachable = [`http://127.0.0.1:${port}/mcp`, ...ips.map(x => `http://${x.address}:${port}/mcp`)];
  return {
    port, host: c.host, exposed: c.host === '0.0.0.0' || c.host === '::',
    allowAnyHost: !!c.allowAnyHost,
    allowedHosts: c.allowedHosts || [],
    effectiveHosts: c.allowAnyHost ? ['*'] : [`localhost:${port}`, `127.0.0.1:${port}`, ...(c.allowedHosts || [])],
    allowedNetworks: c.allowedNetworks || [],
    localIPv4: ips, reachableUrls: reachable, suggestedHosts: suggestedHosts(port),
    firewall: await firewallStatus(port).catch(e => ({ error: e.message })),
    firewallCommand: firewallCommand(port, c.allowedNetworks || []),
  };
}

/** Cambia la capa de cabecera Host y relanza el Playwright MCP (corta las sesiones abiertas). */
export async function setHosts({ allowedHosts, allowAnyHost } = {}) {
  const cfg = getConfig();
  const port = playwright.port;
  if (Array.isArray(allowedHosts)) {
    const norm = [];
    for (const h of allowedHosts) { const n = normalizeHost(h, port); if (!n) throw new Error(`Host inválido: ${h} (usa host o host:puerto, sin espacios)`); if (n !== '*') norm.push(n); }
    cfg.playwright.allowedHosts = [...new Set(norm)];
  }
  if (typeof allowAnyHost === 'boolean') cfg.playwright.allowAnyHost = allowAnyHost;
  saveConfig(cfg);
  L.info(`hosts permitidos actualizados (allowAny=${cfg.playwright.allowAnyHost}, ${cfg.playwright.allowedHosts.length} extra); relanzando Playwright`);
  const restart = await playwright.restart().catch(e => ({ error: e.message }));
  return { ok: true, ...(await status()), restart };
}

/** Añade todas las IPv4 locales + hostname a la lista de hosts (y relanza). */
export async function addLocalHosts() {
  const cfg = getConfig();
  const merged = new Set([...(cfg.playwright.allowedHosts || []), ...suggestedHosts(playwright.port).filter(h => !h.startsWith('localhost:') && !h.startsWith('127.0.0.1:'))]);
  return setHosts({ allowedHosts: [...merged] });
}

/** Guarda la intención de redes permitidas (firewall). No aplica nada: usa applyFirewall(). */
export function setNetworks(networks) {
  if (!Array.isArray(networks)) throw new Error('networks debe ser una lista');
  const norm = [];
  for (const n of networks) { const v = normalizeNetwork(n); if (!v) throw new Error(`Red inválida: ${n} (usa IPv4, IPv4/CIDR como 192.168.2.0/24, rango a-b, o "any")`); norm.push(v); }
  const cfg = getConfig();
  cfg.playwright.allowedNetworks = [...new Set(norm)];
  saveConfig(cfg);
  return { ok: true, allowedNetworks: cfg.playwright.allowedNetworks, firewallCommand: firewallCommand() };
}

/** Aplica las redes permitidas al firewall de Windows. Eleva con UAC (Start-Process -Verb RunAs). */
export async function applyFirewall() {
  const cfg = getConfig().playwright;
  const port = cfg.port;
  const nets = (cfg.allowedNetworks || []).map(normalizeNetwork).filter(Boolean);
  const remote = nets.length === 0 || nets.includes('Any') ? 'Any' : nets.filter(n => n !== 'Any').join(',');
  const resultFile = path.join(HOME, 'logs', 'firewall-apply.json');
  try { fs.rmSync(resultFile, { force: true }); } catch {}
  fs.mkdirSync(path.dirname(resultFile), { recursive: true });
  // powershell externo (no admin) -> Start-Process -Verb RunAs eleva firewall.ps1 (UAC en el escritorio interactivo).
  const inner = `$p=Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${FW_SCRIPT}','-Port','${port}','-Remote','${remote}','-Result','${resultFile}'); exit $p.ExitCode`;
  const exitCode = await new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', inner], { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => err += d);
    p.on('error', reject);
    p.on('exit', (code) => resolve(code));
  });
  // Start-Process -Verb RunAs -Wait no siempre bloquea hasta que el hijo elevado vacía su archivo: esperamos el resultado.
  let res = null;
  for (let i = 0; i < 40; i++) {   // hasta ~6 s tras salir el proceso externo
    try { res = JSON.parse(fs.readFileSync(resultFile, 'utf8')); break; } catch { await new Promise(r => setTimeout(r, 150)); }
  }
  if (!res) throw new Error(exitCode === 0 ? 'no se recibió el resultado del proceso elevado (¿UAC cancelado?)' : `elevación fallida (código ${exitCode})`);
  if (!res.ok) throw new Error(res.error || 'la regla de firewall no se aplicó (revisa permisos)');
  L.info(`firewall aplicado: ${res.name} remote=${JSON.stringify(res.remote)}`);
  return { applied: true, ...res, status: await status() };
}
