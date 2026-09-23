// Monitor de servicios: estado de TCLLM, VirtualBox, VMs, Playwright MCP, bridge y host. Historial de eventos.
import { EventEmitter } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import { createRequire } from 'node:module';
import * as vbox from './vbox.js';
import { playwright } from './playwright.js';
import { bridge } from './bridge.js';
import { getConfig } from './config.js';
import { log } from './log.js';

const L = log('services');
const VERSION = createRequire(import.meta.url)('../package.json').version;
const tcp = (host, port, timeout = 1500) => new Promise((resolve) => { const s = net.connect({ host, port }); const d = (ok) => { s.destroy(); resolve(ok); }; s.once('connect', () => d(true)); s.once('error', () => d(false)); s.setTimeout(timeout, () => d(false)); });

class Services extends EventEmitter {
  constructor() { super(); this.startedAt = Date.now(); this.last = null; this._events = []; this.prevStates = {}; this.timer = null; this.emit = this.emit.bind(this); }

  pushEvent(ev) {
    const e = { ts: new Date().toISOString(), ...ev };
    this._events.push(e);
    const max = getConfig().monitor.historySize;
    if (this._events.length > max) this._events.splice(0, this._events.length - max);
    super.emit('event', e);
    return e;
  }
  // Compat: services.emit({type,...}) desde otros módulos
  emit(ev, ...rest) { if (typeof ev === 'object') return this.pushEvent(ev); return super.emit(ev, ...rest); }
  events(limit = 50) { return this._events.slice(-limit); }

  async status() {
    const cfg = getConfig();
    const [vb, pw, host] = await Promise.all([
      vbox.available(),
      playwright.status().catch(e => ({ error: e.message })),
      bridge.call('host', {}, 10000).catch(e => ({ error: e.message })),
    ]);
    let vms = [];
    if (vb.ok) {
      const list = await vbox.list().catch(() => []);
      vms = await Promise.all(list.map(async (v) => {
        try {
          const i = await vbox.info(v.name);
          const c = cfg.vms[v.name];
          const ssh = c?.sshPort && i.state === 'running' ? await tcp('127.0.0.1', c.sshPort) : null;
          return { name: v.name, state: i.state, session: i.sessionName, guestRunLevel: i.guestAdditionsRunLevel, guestAdditions: i.guestAdditionsVersion, controllable: !!c?.user, ssh, memoryMB: i.memoryMB, cpus: i.cpus, os: i.os, since: i.stateChanged };
        } catch (e) { return { name: v.name, state: 'unknown', error: e.message }; }
      }));
    }
    const mem = process.memoryUsage();
    const st = {
      ts: new Date().toISOString(),
      tcllm: { version: VERSION, pid: process.pid, uptimeMs: Date.now() - this.startedAt, node: process.version, rssMB: Math.round(mem.rss / 1048576), host: cfg.server.host, port: cfg.server.port },
      virtualbox: vb,
      vms,
      playwright: pw,
      bridge: { alive: !!bridge.proc, pid: bridge.proc?.pid || null },
      host: { ...host, platform: os.platform(), release: os.release(), cpus: os.cpus().length },
    };
    this._diff(st);
    this.last = st;
    return st;
  }

  _diff(st) {
    const cur = {};
    for (const v of st.vms) cur['vm:' + v.name] = v.state;
    cur['playwright'] = st.playwright?.listening ? 'up' : 'down';
    cur['virtualbox'] = st.virtualbox?.ok ? 'up' : 'down';
    cur['bridge'] = st.bridge.alive ? 'up' : 'down';
    for (const [k, v] of Object.entries(cur)) {
      const p = this.prevStates[k];
      if (p !== undefined && p !== v) { this.pushEvent({ type: 'state-change', target: k, from: p, to: v }); L.info(`${k}: ${p} -> ${v}`); }
    }
    this.prevStates = cur;
  }

  startMonitor() {
    // Sin solapar vueltas: si la anterior sigue esperando (p.ej. VirtualBox colgado), esta se salta en vez de apilar consultas
    const tick = async () => { if (this.ticking) return; this.ticking = true; try { const s = await this.status(); super.emit('status', s); if (s.playwright?.enabled && !s.playwright.running && !s.playwright.listening) { L.warn('Playwright MCP no escucha: relanzando'); playwright.start().catch(() => {}); } } catch (e) { L.warn('monitor: ' + e.message); } finally { this.ticking = false; } };
    tick();
    this.timer = setInterval(tick, getConfig().monitor.intervalMs);
  }
  stopMonitor() { clearInterval(this.timer); }
}

export const services = new Services();
