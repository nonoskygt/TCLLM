// Ventanas: mostrar/ocultar las de las VMs (VirtualBoxVM.exe) y las de los navegadores Playwright.
import { spawn } from 'node:child_process';
import { bridge } from './bridge.js';
import * as vbox from './vbox.js';
import { getConfig } from './config.js';
import { log } from './log.js';

const L = log('windows');
const hiddenByUs = new Map(); // hwnd -> {kind, title}
let browserOwnerPid = null;   // pid del Playwright MCP que supervisamos (lo fija playwright.js)
export function setBrowserOwner(pid) { browserOwnerPid = pid; }

const BROWSER_PROCS = ['chrome.exe', 'msedge.exe', 'chromium.exe', 'brave.exe', 'firefox.exe', 'Playwright.exe', 'MiniBrowser.exe'];

/** PIDs de navegadores: { ours: Set (hijos de nuestro Playwright MCP), others: Set (otros Playwright, p.ej. otro servicio) } */
export async function browserPids(ownerPid) {
  const procs = await bridge.call('procs', { names: BROWSER_PROCS });
  const ours = new Set(), others = new Set();
  const byPid = new Map(procs.map(p => [p.pid, p]));
  for (const p of procs) {
    if (!/--remote-debugging-pipe|playwright|-juggler-pipe/i.test(p.cmd || '')) continue;
    // ¿desciende de nuestro proceso? (chrome hijo de node; los renderers son hijos del chrome principal)
    let q = p, hops = 0, mine = false;
    while (q && hops++ < 6) { if (q.ppid === ownerPid) { mine = true; break; } q = byPid.get(q.ppid); }
    (mine ? ours : others).add(p.pid);
  }
  return { ours, others };
}

// Nombres de VM solo para poner nombre a las ventanas de VirtualBoxVM: si VirtualBox no contesta rápido, se usa la
// última lista buena. Así la lista de ventanas (y browser_list, el panel...) no se cuelga cuando se cuelga VBoxSVC.
let lastVms = [];
async function vmsQuick(ms = 4000) {
  const got = await Promise.race([vbox.list().then(v => (lastVms = v)).catch(() => null), new Promise(r => setTimeout(() => r(null), ms))]);
  return got || lastVms;
}

/** Lista clasificada de ventanas relevantes: [{hwnd,pid,process,title,visible,kind,vm}] */
export async function list({ includeHidden = true, ownerPid = null } = {}) {
  const [wins, vms, pw] = await Promise.all([bridge.call('windows', { includeHidden }), vmsQuick(), browserPids(ownerPid ?? browserOwnerPid)]);
  const out = [];
  for (const w of wins) {
    let kind = null, vm = null;
    if (/^VirtualBoxVM$/i.test(w.process)) { kind = 'vm'; vm = vms.find(v => w.title.startsWith(v.name.trim()))?.name || null; }
    else if (pw.ours.has(w.pid)) kind = 'browser';
    else if (pw.others.has(w.pid)) kind = 'browser-other';
    else if (/^VirtualBox$/i.test(w.process)) kind = 'vbox-manager';
    if (!kind) continue;
    if (!w.visible && !hiddenByUs.has(String(w.hwnd))) continue; // ventanas ocultas ajenas no nos incumben
    out.push({ ...w, hwnd: String(w.hwnd), kind, vm });
  }
  return out;
}

export async function show(hwnd) { await bridge.call('show', { hwnd }); hiddenByUs.delete(String(hwnd)); return { hwnd, visible: true }; }
export async function hide(hwnd, meta = {}) { await bridge.call('hide', { hwnd }); hiddenByUs.set(String(hwnd), meta); return { hwnd, visible: false }; }
export const minimize = (hwnd) => bridge.call('minimize', { hwnd });
export const foreground = (hwnd) => bridge.call('foreground', { hwnd });

/** Muestra la ventana de una VM; si corre headless, le engancha una GUI (VirtualBoxVM --separate). */
export async function showVm(name) {
  const wins = (await list()).filter(w => w.kind === 'vm' && w.vm === name);
  if (wins.length) { for (const w of wins) await show(w.hwnd); return { vm: name, action: 'shown', windows: wins.length }; }
  const st = await vbox.state(name);
  if (st !== 'running') throw new Error(`La VM "${name}" no está en ejecución (${st})`);
  const exe = getConfig().paths.virtualBoxVM;
  const child = spawn(exe, ['--separate', '--startvm', name], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  L.info(`GUI enganchada a ${name} (VirtualBoxVM --separate, pid ${child.pid})`);
  return { vm: name, action: 'attached-gui', pid: child.pid };
}

export async function hideVm(name) {
  const wins = (await list()).filter(w => w.kind === 'vm' && w.vm === name && w.visible);
  for (const w of wins) await hide(w.hwnd, { kind: 'vm', vm: name, title: w.title });
  return { vm: name, action: 'hidden', windows: wins.length };
}

export async function showBrowser() {
  const wins = (await list()).filter(w => w.kind === 'browser');
  for (const w of wins) await show(w.hwnd);
  return { action: 'shown', windows: wins.length };
}
export async function hideBrowser() {
  const wins = (await list()).filter(w => w.kind === 'browser' && w.visible);
  for (const w of wins) await hide(w.hwnd, { kind: 'browser', title: w.title });
  return { action: 'hidden', windows: wins.length };
}
