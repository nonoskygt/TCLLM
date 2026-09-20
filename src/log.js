// Logger sencillo: consola + archivo rotativo + buffer en memoria para el panel (WebSocket).
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const MAX_MEM = 1000;
const MAX_FILE = 5 * 1024 * 1024;

class Logger extends EventEmitter {
  constructor() { super(); this.buffer = []; this.file = null; }
  setFile(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); this.file = file; }
  _write(level, mod, msg, extra) {
    const entry = { ts: new Date().toISOString(), level, mod, msg, ...(extra ? { extra } : {}) };
    this.buffer.push(entry);
    if (this.buffer.length > MAX_MEM) this.buffer.shift();
    const line = `${entry.ts} [${level}] ${mod}: ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`;
    if (level === 'error') console.error(line); else console.log(line);
    if (this.file) {
      try {
        if (fs.existsSync(this.file) && fs.statSync(this.file).size > MAX_FILE) fs.renameSync(this.file, this.file + '.1');
        fs.appendFileSync(this.file, line + '\n');
      } catch { /* sin disco no se muere el servidor */ }
    }
    this.emit('log', entry);
  }
  child(mod) {
    return {
      info: (m, x) => this._write('info', mod, m, x),
      warn: (m, x) => this._write('warn', mod, m, x),
      error: (m, x) => this._write('error', mod, m, x),
      debug: (m, x) => { if (process.env.TCLLM_DEBUG) this._write('debug', mod, m, x); },
    };
  }
  recent(n = 200) { return this.buffer.slice(-n); }
}

export const logger = new Logger();
export const log = (mod) => logger.child(mod);
