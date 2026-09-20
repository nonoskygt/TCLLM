// Wrapper de VBoxManage (VirtualBox). Todo asíncrono; sin módulos nativos.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getConfig } from './config.js';
import { log } from './log.js';

const L = log('vbox');

export class VBoxError extends Error {
  constructor(msg, { code, stderr } = {}) { super(msg); this.code = code; this.stderr = stderr; }
}

function vbm() { return getConfig().paths.vboxManage; }

/** Ejecuta VBoxManage y devuelve stdout (lanza VBoxError con el mensaje limpio si falla). */
export function run(args, { timeout = 120000, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(vbm(), args, { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !allowFail) {
        let m = (stderr || '').split(/\r?\n/).find(l => l.includes('error:')) || err.message;
        const pi = args.indexOf('--password');            // nunca filtrar la contraseña del guest en errores/logs
        if (pi >= 0 && args[pi + 1]) m = m.split(args[pi + 1]).join('***');
        return reject(new VBoxError(m.replace(/^VBoxManage\.exe: error: /, '').trim(), { code: err.code, stderr: pi >= 0 ? undefined : stderr }));
      }
      resolve(stdout);
    });
  });
}

export async function available() {
  try { return { ok: true, version: (await run(['--version'])).trim() }; }
  catch (e) { return { ok: false, error: e.message }; }
}

function parseMachineReadable(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).replace(/^"|"$/g, '');
    let v = line.slice(i + 1);
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

/** Lista de VMs registradas: [{name, uuid}] */
export async function list() {
  const text = await run(['list', 'vms']);
  return [...text.matchAll(/^"(.+)" \{([0-9a-f-]+)\}/gm)].map(m => ({ name: m[1], uuid: m[2] }));
}

export async function running() {
  const text = await run(['list', 'runningvms']);
  return [...text.matchAll(/^"(.+)" \{([0-9a-f-]+)\}/gm)].map(m => m[1]);
}

/** Info completa (showvminfo --machinereadable) como objeto plano. */
export async function info(name) {
  const raw = parseMachineReadable(await run(['showvminfo', name, '--machinereadable']));
  const snaps = [];
  for (const [k, v] of Object.entries(raw)) {
    const m = k.match(/^SnapshotName(-\d+)*$/);
    if (m) snaps.push({ name: v, uuid: raw['SnapshotUUID' + (m[1] || '')], current: raw.CurrentSnapshotName === v });
  }
  const forwards = Object.entries(raw).filter(([k]) => k.startsWith('Forwarding(')).map(([, v]) => {
    const [rule, proto, hostIp, hostPort, guestIp, guestPort] = v.split(',');
    return { rule, proto, hostIp, hostPort: +hostPort, guestIp, guestPort: +guestPort };
  });
  return {
    name: raw.name, uuid: raw.UUID, state: raw.VMState, stateChanged: raw.VMStateChangeTime,
    os: raw.ostype, memoryMB: +raw.memory, cpus: +raw.cpus, vramMB: +raw.vram, firmware: raw.firmware,
    graphics: raw.graphicscontroller, configFile: raw.CfgFile, logFolder: raw.LogFldr,
    snapshots: snaps, currentSnapshot: raw.CurrentSnapshotName || null, forwards,
    guestAdditionsRunLevel: raw.GuestAdditionsRunLevel ? +raw.GuestAdditionsRunLevel : null,
    guestAdditionsVersion: raw.GuestAdditionsVersion || null,
    sessionName: raw.SessionName || null, // headless | GUI/Qt | ...
  };
}

export async function state(name) {
  try { return (await info(name)).state; } catch (e) { return 'unknown'; }
}

export async function start(name, type = 'headless') {
  await run(['startvm', name, '--type', type]);
  L.info(`startvm ${name} (${type})`);
}
export const acpiPowerButton = (name) => run(['controlvm', name, 'acpipowerbutton']);
export const powerOff = (name) => run(['controlvm', name, 'poweroff']);
export const reset = (name) => run(['controlvm', name, 'reset']);
export const saveState = (name) => run(['controlvm', name, 'savestate']);
export const pause = (name) => run(['controlvm', name, 'pause']);
export const resume = (name) => run(['controlvm', name, 'resume']);

export const snapshotTake = (name, snap, description = '') => run(['snapshot', name, 'take', snap, ...(description ? ['--description', description] : [])]);
export const snapshotRestore = (name, snap) => run(['snapshot', name, 'restore', snap]);
export const snapshotDelete = (name, snap) => run(['snapshot', name, 'delete', snap]);

export async function guestProperty(name, prop) {
  const out = await run(['guestproperty', 'get', name, prop], { allowFail: true });
  const m = out.match(/^Value: (.*)$/m);
  return m ? m[1].trim() : null;
}

export async function guestProperties(name) {
  const out = await run(['guestproperty', 'enumerate', name], { allowFail: true });
  const props = {};
  for (const m of out.matchAll(/^(\S+)\s+=\s+'(.*?)'\s+@/gm)) props[m[1]] = m[2];
  return props;
}

/** Captura PNG de la pantalla del guest. Reintenta si la pantalla está en transición (E_FAIL / 0x0). */
export async function screenshot(name, { retries = 6, delayMs = 700 } = {}) {
  const file = path.join(os.tmpdir(), `tcllm-shot-${name}-${process.pid}-${Date.now()}.png`);
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      await run(['controlvm', name, 'screenshotpng', file]);
      const buf = await fs.readFile(file);
      await fs.unlink(file).catch(() => {});
      return { png: buf, ...pngSize(buf) };
    } catch (e) {
      lastErr = e;
      if (!/Unsupported resolution|E_FAIL|not running|is not currently running/i.test(e.message)) throw e;
      if (/not running/i.test(e.message)) throw e;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

export function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Scancodes (set 1). Tecla extendida = prefijo e0. */
export const SCANCODES = {
  esc: 0x01, '1': 0x02, '2': 0x03, '3': 0x04, '4': 0x05, '5': 0x06, '6': 0x07, '7': 0x08, '8': 0x09, '9': 0x0a, '0': 0x0b, '-': 0x0c, '=': 0x0d,
  backspace: 0x0e, tab: 0x0f, q: 0x10, w: 0x11, e: 0x12, r: 0x13, t: 0x14, y: 0x15, u: 0x16, i: 0x17, o: 0x18, p: 0x19, '[': 0x1a, ']': 0x1b,
  enter: 0x1c, ctrl: 0x1d, a: 0x1e, s: 0x1f, d: 0x20, f: 0x21, g: 0x22, h: 0x23, j: 0x24, k: 0x25, l: 0x26, ';': 0x27, "'": 0x28, '`': 0x29,
  shift: 0x2a, '\\': 0x2b, z: 0x2c, x: 0x2d, c: 0x2e, v: 0x2f, b: 0x30, n: 0x31, m: 0x32, ',': 0x33, '.': 0x34, '/': 0x35, rshift: 0x36,
  alt: 0x38, space: 0x39, capslock: 0x3a, f1: 0x3b, f2: 0x3c, f3: 0x3d, f4: 0x3e, f5: 0x3f, f6: 0x40, f7: 0x41, f8: 0x42, f9: 0x43, f10: 0x44,
  numlock: 0x45, scrolllock: 0x46, f11: 0x57, f12: 0x58,
};
export const SCANCODES_EXT = {
  up: 0x48, down: 0x50, left: 0x4b, right: 0x4d, home: 0x47, end: 0x4f, pageup: 0x49, pgup: 0x49, pagedown: 0x51, pgdn: 0x51,
  insert: 0x52, delete: 0x53, del: 0x53, win: 0x5b, meta: 0x5b, rwin: 0x5c, menu: 0x5d, rctrl: 0x1d, ralt: 0x38, kpenter: 0x1c,
};
const ALIASES = { control: 'ctrl', return: 'enter', escape: 'esc', cmd: 'win', super: 'win', windows: 'win', option: 'alt', bksp: 'backspace', ' ': 'space' };

/** "ctrl+alt+del" -> lista de scancodes hex (press en orden, release en orden inverso). */
export function comboToScancodes(combo) {
  const keys = combo.toLowerCase().split('+').map(k => ALIASES[k.trim()] || k.trim());
  const press = [], release = [];
  for (const k of keys) {
    if (k in SCANCODES) { press.push(hex(SCANCODES[k])); release.unshift(hex(SCANCODES[k] | 0x80)); }
    else if (k in SCANCODES_EXT) { press.push('e0', hex(SCANCODES_EXT[k])); release.unshift('e0', hex(SCANCODES_EXT[k] | 0x80)); }
    else throw new Error(`Tecla desconocida: "${k}"`);
  }
  return [...press, ...release];
}
const hex = (n) => n.toString(16).padStart(2, '0');

export async function sendKeys(name, combo) {
  await run(['controlvm', name, 'keyboardputscancode', ...comboToScancodes(combo)]);
}

/** Escribe texto ASCII carácter a carácter (el guest pierde teclas si se envían de golpe bajo NEM). */
export async function typeText(name, text, delayMs = 60) {
  for (const ch of text) {
    if (ch === '\n') { await sendKeys(name, 'enter'); continue; }
    await run(['controlvm', name, 'keyboardputstring', ch]);
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
  }
}

/** Registros de CPU (para el watchdog): [{cpu, rip, rflags}] */
export async function cpuRegisters(name, cpus = 4) {
  const out = [];
  for (let c = 0; c < cpus; c++) {
    const t = await run(['debugvm', name, 'getregisters', '--cpu', String(c), 'rip', 'rflags'], { allowFail: true });
    const rip = t.match(/rip\s*=\s*(0x[0-9a-f]+)/i)?.[1], rflags = t.match(/rflags\s*=\s*(0x[0-9a-f]+)/i)?.[1];
    if (rip && rflags) out.push({ cpu: c, rip, rflags });
  }
  return out;
}

export async function addPortForward(name, rule, hostPort, guestPort, hostIp = '127.0.0.1') {
  const st = await state(name);
  const spec = `${rule},tcp,${hostIp},${hostPort},,${guestPort}`;
  if (st === 'running') await run(['controlvm', name, 'natpf1', spec]);
  else await run(['modifyvm', name, '--natpf1', spec]);
}
