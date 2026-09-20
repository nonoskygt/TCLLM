// Cliente del sidecar PowerShell (ps/bridge.ps1): un proceso persistente, peticiones JSON por línea.
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { PKG_ROOT } from './config.js';
import { log } from './log.js';

const L = log('bridge');
const SCRIPT = path.join(PKG_ROOT, 'ps', 'bridge.ps1');

class Bridge {
  constructor() { this.proc = null; this.pending = new Map(); this.nextId = 1; this.starting = null; }

  start() {
    if (this.proc) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.proc = p;
      const rl = readline.createInterface({ input: p.stdout });
      rl.on('line', (line) => {
        let msg; try { msg = JSON.parse(line); } catch { return L.debug('línea no JSON del bridge: ' + line); }
        const pend = this.pending.get(msg.id);
        if (!pend) return;
        this.pending.delete(msg.id);
        clearTimeout(pend.timer);
        msg.ok ? pend.resolve(msg.result) : pend.reject(new Error(msg.error || 'bridge error'));
      });
      p.stderr.on('data', (d) => L.warn('stderr: ' + String(d).trim().slice(0, 300)));
      p.on('exit', (code) => {
        L.warn(`bridge terminó (code ${code})`);
        this.proc = null; this.starting = null;
        for (const [, pend] of this.pending) pend.reject(new Error('bridge terminó'));
        this.pending.clear();
      });
      // Primer ping: Add-Type tarda un par de segundos la primera vez.
      this._send({ op: 'ping' }, 30000).then(() => { this.starting = null; L.info('bridge PowerShell listo'); resolve(); }).catch(reject);
    });
    return this.starting;
  }

  _send(req, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`bridge timeout (${req.op})`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, ...req }) + '\n');
    });
  }

  async call(op, params = {}, timeoutMs) {
    await this.start();
    return this._send({ op, ...params }, timeoutMs);
  }

  stop() { if (this.proc) { try { this.proc.stdin.write(JSON.stringify({ id: 0, op: 'exit' }) + '\n'); } catch {} setTimeout(() => this.proc?.kill(), 1000); } }
}

export const bridge = new Bridge();
