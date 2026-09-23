// Supervisor del Playwright MCP: lo lanza como hijo, lo relanza si muere, vigila su salud y expone un cliente MCP
// (para el proxy browser_* y el panel). El navegador es el Chrome/Edge/Chromium instalado.
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createRequire } from 'node:module';
import { PKG_ROOT, getConfig } from './config.js';
import { log } from './log.js';
import * as windows from './windows.js';
import * as browsers from './browsers.js';
import * as sessions from './sessions.js';
import { saveConfig } from './config.js';

const L = log('playwright');
const VERSION = createRequire(import.meta.url)('../package.json').version;
const CLI = path.join(PKG_ROOT, 'node_modules', '@playwright', 'mcp', 'cli.js');
const INIT_PAGE = path.join(PKG_ROOT, 'ps', 'init-page.cjs');
const NO_LEAVE_DIALOGS = path.join(PKG_ROOT, 'ps', 'no-leave-dialogs.js');

class PlaywrightSupervisor {
  constructor() { this.proc = null; this.restarts = 0; this.startedAt = null; this.lastExit = null; this.stopping = false; this.client = null; this.tools = null; this.events = []; }

  get cfg() { return getConfig().playwright; }
  /** Modo de sesiones: perfil en disco (persistente) vs contexto en memoria por cliente (aislado). */
  get persistent() { return (this.cfg.sessions || 'persistent') === 'persistent'; }
  /** Puerto efectivo: el configurado, o el siguiente libre si estaba ocupado por algo ajeno. */
  get port() { return this.effectivePort || this.cfg.port; }
  /** Dirección a la que TCLLM se conecta. Si el servidor escucha en todas las interfaces (0.0.0.0 / ::) hay que hablarle
   *  por loopback; y siempre por IP literal: "localhost" puede resolver a ::1, donde podría haber otro servidor ajeno. */
  get clientHost() { const h = this.cfg.host; if (h === '::' || h === '::1') return '::1'; if (h === '0.0.0.0' || h === 'localhost' || !h) return '127.0.0.1'; return h; }
  get url() { return `http://${this.clientHost}:${this.port}/mcp`; }

  args() {
    const c = this.cfg;
    const a = ['--port', String(this.port), '--host', c.host, ...browsers.launchArgs(c.browser, { executablePath: c.executablePath })];
    if (c.allowAnyHost) {
      a.push('--allowed-hosts', '*');   // acepta cualquier cabecera Host (el filtro por red queda en el firewall)
    } else {
      const hosts = [`localhost:${this.port}`, `127.0.0.1:${this.port}`, ...(c.allowedHosts || [])];
      a.push('--allowed-hosts', hosts.join(','));
    }
    if (this.persistent) {
      // Perfil en disco: lo que se loguee sobrevive. --shared-browser-context porque un perfil solo admite un
      // contexto: sin él, el segundo cliente MCP recibiría "Browser is already in use for <userDataDir>".
      a.push('--user-data-dir', sessions.profileDir(c.browser), '--shared-browser-context');
    } else {
      if (c.isolated) a.push('--isolated');
      // --storage-state solo vale en modo aislado (Playwright: "storage state file for isolated sessions")
      const st = sessions.sharedFile();
      if (c.isolated && st && fs.existsSync(st)) a.push('--storage-state', st);
    }
    if (c.headless) a.push('--headless');
    if (c.freeFileDialogs) a.push('--init-page', INIT_PAGE);
    // Sin cuadros "¿Salir del sitio?" (beforeunload): bloquean a los agentes y el cierre limpio del navegador.
    if (c.blockLeaveDialogs !== false) a.push('--init-script', NO_LEAVE_DIALOGS);
    a.push('--allow-unrestricted-file-access');
    return [...a, ...(c.extraArgs || [])];
  }

  async start() {
    if (!this.cfg.enabled) { L.info('Playwright MCP deshabilitado en config'); return; }
    if (this.proc) return;
    this.stopping = false;
    // Si ya hay algo escuchando en el puerto (p.ej. un Playwright MCP externo o huérfano), lo adoptamos en vez de morir en bucle.
    this.effectivePort = null;
    const det = browsers.detect();
    if (!det[this.cfg.browser]?.installed && !this.cfg.executablePath && Object.hasOwn(browsers.CATALOG, this.cfg.browser)) {
      const alt = browsers.pickDefault();
      L.warn(`el navegador configurado (${this.cfg.browser}) no está instalado; uso ${alt} (cámbialo en el panel > Navegador)`);
      const cfg = getConfig(); cfg.playwright.browser = alt; saveConfig(cfg);
    }
    if (await this.tcpCheck()) {
      try { await this.listTools(); this.adopted = true; L.warn(`puerto ${this.cfg.port} ya tiene un Playwright MCP: adoptado (no lo gestiona TCLLM)`); return; }
      catch (e) {
        this._dropClient();
        L.warn(`puerto ${this.cfg.port} ocupado por otro programa (${(e.message || '').split(/\r?\n/)[0].slice(0, 80)}); busco un puerto libre`);
        for (let p = this.cfg.port + 1; p < this.cfg.port + 100; p++) { this.effectivePort = p; if (!await this.tcpCheck()) break; }
        L.warn(`Playwright MCP usará el puerto ${this.port}`);
      }
    }
    this.adopted = false;
    // Primer arranque con perfil nuevo: lo sembramos con la bolsa común para no empezar deslogueado.
    if (this.persistent && !sessions.hasProfile(this.cfg.browser)) {
      const shared = sessions.readShared();
      if (shared.cookies.length || shared.origins.length) {
        L.info(`perfil nuevo de ${this.cfg.browser}: sembrando ${shared.cookies.length} cookies de la bolsa común`);
        try { await sessions.seedInto(this.cfg.browser, shared); }
        catch (e) { L.warn(`no se pudo sembrar el perfil: ${e.message.split('\n')[0]}`); }
      }
    }
    const args = this.args();
    const p = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, PW_MCP: '1' } });
    this.proc = p; this.startedAt = Date.now(); windows.setBrowserOwner(p.pid);
    L.info(`Playwright MCP arrancando (pid ${p.pid}): ${args.join(' ')}`);
    const onData = (d) => { const s = String(d).trim(); if (s && !/Put this in your client config|mcpServers|"url"|^[{}\s]*$|legacy SSE/.test(s)) L.info(`[pw] ${s.slice(0, 300)}`); };
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    p.on('exit', (code, signal) => {
      this.lastExit = { code, signal, at: Date.now() };
      this.proc = null; this._dropClient();
      if (this.stopping) return L.info('Playwright MCP detenido');
      this.restarts++;
      L.warn(`Playwright MCP terminó (code ${code}); reinicio en ${this.cfg.restartDelayMs} ms (reinicio #${this.restarts})`);
      setTimeout(() => { this.start().catch(e => L.error('restart: ' + e.message)); }, this.cfg.restartDelayMs);
    });
  }

  /** Cierra el navegador con WM_CLOSE (taskkill sin /F) y espera a que salga.
   *  Imprescindible en modo persistente: Chrome/Firefox solo vuelcan cookies y localStorage al perfil al salir limpios;
   *  si matamos el proceso del MCP (TerminateProcess) se pierde todo lo que el agente hubiera logueado. */
  async closeBrowserGracefully(timeoutMs = 25000) {
    const pid = this.proc?.pid;
    if (!pid) return { closed: 0 };
    const NAMES = "@('chrome.exe','msedge.exe','brave.exe','firefox.exe')";
    const kids = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Where-Object { $_.Name -in ${NAMES} }`;
    const cmd = [
      "$ErrorActionPreference='SilentlyContinue'",
      `$kids = @(${kids})`,
      'foreach ($k in $kids) { Start-Process taskkill.exe -ArgumentList @("/PID", "$($k.ProcessId)") -NoNewWindow -Wait }',
      `$deadline = (Get-Date).AddMilliseconds(${timeoutMs})`,
      `while ((Get-Date) -lt $deadline) { if (@(${kids}).Count -eq 0) { break }; Start-Sleep -Milliseconds 300 }`,
      // Si sigue vivo (p.ej. un cuadro "¿Salir del sitio?" de una página cargada antes del init-script lo traba),
      // se fuerza: mejor perder lo no volcado de esa pestaña que dejar el perfil bloqueado ("Browser is already in use").
      `$left = @(${kids}); foreach ($k in $left) { Start-Process taskkill.exe -ArgumentList @("/PID", "$($k.ProcessId)", "/T", "/F") -NoNewWindow -Wait }`,
      'Write-Output ("closed=" + $kids.Count + " forced=" + $left.Count)',
    ].join('; ');
    return new Promise((resolve) => {
      const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { windowsHide: true });
      let out = '';
      const timer = setTimeout(() => { try { p.kill(); } catch {} resolve({ timeout: true }); }, timeoutMs + 10000);
      p.stdout.on('data', d => out += d);
      p.on('error', () => { clearTimeout(timer); resolve({ error: true }); });
      p.on('exit', () => { clearTimeout(timer); const s = out.trim(); if (s) L.info(`navegador cerrado limpiamente (${s})`); resolve({ info: s }); });
    });
  }

  async stop() {
    this.stopping = true;
    // Primero el navegador (para que vuelque el perfil), luego el proceso del MCP.
    if (this.persistent && this.proc) { try { await this.closeBrowserGracefully(); } catch (e) { L.warn(`cierre limpio del navegador: ${e.message}`); } }
    this._dropClient();
    if (!this.proc) return;
    const p = this.proc;
    await new Promise((resolve) => { p.once('exit', resolve); p.kill(); setTimeout(() => { try { p.kill('SIGKILL'); } catch {} resolve(); }, 5000); });
  }

  /** Cambia el navegador (chrome|msedge|brave|chromium|firefox|webkit), lo guarda en config y relanza el Playwright MCP. */
  async useBrowser(id, { executablePath } = {}) {
    const d = browsers.detect();
    if (typeof id !== 'string' || !Object.hasOwn(browsers.CATALOG, id)) throw new Error(`Navegador desconocido: ${id}. Opciones: ${Object.keys(browsers.CATALOG).join(', ')}`);
    if (executablePath) {
      if (!['brave', 'chromium', 'chrome', 'msedge'].includes(id)) throw new Error('executablePath solo vale para navegadores Chromium (brave, chromium, chrome, msedge)');
      if (!fs.existsSync(executablePath)) throw new Error(`No existe el ejecutable: ${executablePath}`);
    }
    if (!this.cfg.enabled) return { browser: id, applied: false, note: 'Playwright está deshabilitado en config (playwright.enabled=false)' };
    if (!d[id].installed && !executablePath) throw new Error(`${d[id].title} no está instalado.${d[id].installable ? ' Instálalo con browser_install / POST /api/browser/install.' : ''}`);
    const cfg = getConfig();
    if (id === cfg.playwright.browser && (executablePath || '') === (cfg.playwright.executablePath || '')) return { browser: id, unchanged: true, status: await this.status() };
    const from = cfg.playwright.browser;
    cfg.playwright.browser = id; cfg.playwright.executablePath = executablePath || ''; saveConfig(cfg);
    L.info(`cambiando navegador a ${id}`);
    if (this.adopted) return { browser: id, applied: false, note: `hay un Playwright MCP externo en el puerto ${this.port} que TCLLM adoptó; párralo (o cambia playwright.port) para que TCLLM lance el suyo con ${id}`, status: await this.status() };
    // Traspaso de sesiones: con el MCP parado el perfil está libre, así que exportamos el que dejamos y sembramos el nuevo.
    await this.stop();
    let transfer = null;
    if (this.persistent) {
      try { transfer = await sessions.transfer(from, id); }
      catch (e) { transfer = { error: e.message }; L.warn(`traspaso de sesiones ${from} -> ${id}: ${e.message}`); }
    }
    this.restarts = 0;
    await this.start();
    await this.waitListening(30000);
    return { browser: id, applied: true, sessions: transfer, status: await this.status() };
  }

  async restart() { await this.stop(); this.restarts = 0; await this.start(); await this.waitListening(30000); return this.status(); }

  /** Vuelca a la bolsa común los logins del perfil activo (hay que parar el navegador: el perfil está bloqueado). */
  async saveSessions() {
    if (!this.persistent) return { saved: false, note: 'sessions="isolated": no hay perfil en disco que guardar (cambia playwright.sessions a "persistent")' };
    const id = this.cfg.browser;
    await this.stop();
    let out;
    try { out = await sessions.saveFrom(id); }
    catch (e) { out = { saved: false, error: e.message }; L.warn(`guardar sesiones de ${id}: ${e.message}`); }
    this.restarts = 0;
    await this.start();
    await this.waitListening(30000);
    return { browser: id, ...out, status: await this.status() };
  }

  tcpCheck(timeout = 2000) {
    return new Promise((resolve) => {
      const s = net.connect({ host: this.clientHost, port: this.port });
      const done = (ok) => { s.destroy(); resolve(ok); };
      s.once('connect', () => done(true)); s.once('error', () => done(false)); s.setTimeout(timeout, () => done(false));
    });
  }

  async waitListening(maxMs = 30000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) { if (await this.tcpCheck()) return true; await new Promise(r => setTimeout(r, 500)); }
    return false;
  }

  _dropClient() { if (this.client) { this.client.close().catch(() => {}); } this.client = null; this.tools = null; }

  /** Cliente MCP conectado al Playwright MCP (sesión propia de TCLLM, reutilizada). */
  async getClient() {
    if (this.client) return this.client;
    if (!await this.tcpCheck()) throw new Error(`Playwright MCP no responde en ${this.url}`);
    const client = new Client({ name: 'tcllm', version: VERSION });
    const transport = new StreamableHTTPClientTransport(new URL(this.url));
    await client.connect(transport);
    client.onclose = () => { if (this.client === client) { this.client = null; this.tools = null; } };
    this.client = client;
    return client;
  }

  async listTools() {
    if (this.tools) return this.tools;
    const c = await this.getClient();
    this.tools = (await c.listTools()).tools;
    return this.tools;
  }

  async callTool(name, args = {}) {
    const c = await this.getClient();
    try { return await c.callTool({ name, arguments: args }); }
    catch (e) { this._dropClient(); throw e; }
  }

  async status() {
    const listening = this.cfg.enabled ? await this.tcpCheck() : false;
    let mcpOk = false, toolCount = null;
    if (listening) { try { toolCount = (await this.listTools()).length; mcpOk = true; } catch (e) { L.debug('mcp check: ' + e.message); } }
    const browserWindows = listening ? (await windows.list().catch(() => [])).filter(w => w.kind === 'browser') : [];
    return {
      enabled: this.cfg.enabled, running: !!this.proc, adopted: !!this.adopted, adoptedNote: this.adopted ? 'Playwright MCP externo: TCLLM no controla su navegador ni puede cambiarlo' : undefined, pid: this.proc?.pid || null, listening, mcpOk, toolCount,
      url: this.url, host: this.cfg.host, port: this.port, configuredPort: this.cfg.port, allowedHosts: this.cfg.allowedHosts || [], storageState: sessions.sharedFile(), browser: this.cfg.browser,
      sessions: this.persistent ? 'persistent' : 'isolated', profileDir: this.persistent ? sessions.profileDir(this.cfg.browser) : null, browserTitle: browsers.CATALOG[this.cfg.browser]?.title || this.cfg.browser, isolated: this.cfg.isolated, restarts: this.restarts,
      uptimeMs: this.startedAt && this.proc ? Date.now() - this.startedAt : 0, lastExit: this.lastExit,
      windows: browserWindows.map(w => ({ hwnd: w.hwnd, title: w.title, visible: w.visible })),
    };
  }
}

export const playwright = new PlaywrightSupervisor();
