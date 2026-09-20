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

const L = log('playwright');
const VERSION = createRequire(import.meta.url)('../package.json').version;
const CLI = path.join(PKG_ROOT, 'node_modules', '@playwright', 'mcp', 'cli.js');
const INIT_PAGE = path.join(PKG_ROOT, 'ps', 'init-page.cjs');

class PlaywrightSupervisor {
  constructor() { this.proc = null; this.restarts = 0; this.startedAt = null; this.lastExit = null; this.stopping = false; this.client = null; this.tools = null; this.events = []; }

  get cfg() { return getConfig().playwright; }
  /** Puerto efectivo: el configurado, o el siguiente libre si estaba ocupado por algo ajeno. */
  get port() { return this.effectivePort || this.cfg.port; }
  get url() { return `http://${this.cfg.host}:${this.port}/mcp`; }

  args() {
    const c = this.cfg;
    const a = ['--port', String(this.port), '--host', c.host, '--browser', c.browser];
    const hosts = [`localhost:${this.port}`, `127.0.0.1:${this.port}`, ...(c.allowedHosts || [])];
    a.push('--allowed-hosts', hosts.join(','));
    if (c.isolated) a.push('--isolated');
    if (c.headless) a.push('--headless');
    if (c.storageState && fs.existsSync(c.storageState)) a.push('--storage-state', c.storageState);
    if (c.freeFileDialogs) a.push('--init-page', INIT_PAGE);
    a.push('--allow-unrestricted-file-access');
    return [...a, ...(c.extraArgs || [])];
  }

  async start() {
    if (!this.cfg.enabled) { L.info('Playwright MCP deshabilitado en config'); return; }
    if (this.proc) return;
    this.stopping = false;
    // Si ya hay algo escuchando en el puerto (p.ej. un Playwright MCP externo o huérfano), lo adoptamos en vez de morir en bucle.
    this.effectivePort = null;
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

  async stop() {
    this.stopping = true; this._dropClient();
    if (!this.proc) return;
    const p = this.proc;
    await new Promise((resolve) => { p.once('exit', resolve); p.kill(); setTimeout(() => { try { p.kill('SIGKILL'); } catch {} resolve(); }, 5000); });
  }

  async restart() { await this.stop(); this.restarts = 0; await this.start(); await this.waitListening(30000); return this.status(); }

  tcpCheck(timeout = 2000) {
    return new Promise((resolve) => {
      const s = net.connect({ host: this.cfg.host, port: this.port });
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
      enabled: this.cfg.enabled, running: !!this.proc, adopted: !!this.adopted, pid: this.proc?.pid || null, listening, mcpOk, toolCount,
      url: this.url, port: this.port, configuredPort: this.cfg.port, browser: this.cfg.browser, isolated: this.cfg.isolated, restarts: this.restarts,
      uptimeMs: this.startedAt && this.proc ? Date.now() - this.startedAt : 0, lastExit: this.lastExit,
      windows: browserWindows.map(w => ({ hwnd: w.hwnd, title: w.title, visible: w.visible })),
    };
  }
}

export const playwright = new PlaywrightSupervisor();
