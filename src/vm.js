// Operaciones de alto nivel sobre VMs (combinan vbox + guest + watchdog + ventanas).
import * as vbox from './vbox.js';
import * as guest from './guest.js';
import * as watchdog from './watchdog.js';
import * as windows from './windows.js';
import { getConfig } from './config.js';
import { log } from './log.js';

const L = log('vm');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const hasCreds = (name) => !!getConfig().vms[name]?.user;

export async function summary(name) {
  const i = await vbox.info(name);
  const c = getConfig().vms[name] || {};
  return {
    name: i.name, state: i.state, stateChanged: i.stateChanged, os: i.os, memoryMB: i.memoryMB, cpus: i.cpus,
    session: i.sessionName, guestAdditions: i.guestAdditionsVersion, guestRunLevel: i.guestAdditionsRunLevel,
    snapshots: i.snapshots, currentSnapshot: i.currentSnapshot, forwards: i.forwards,
    controllable: hasCreds(name), sshPort: c.sshPort || null, sharedFolder: c.sharedFolder || null,
  };
}

export async function listAll() {
  const vms = await vbox.list();
  return Promise.all(vms.map(v => summary(v.name).catch(e => ({ name: v.name, state: 'unknown', error: e.message }))));
}

/** Enciende (o reanuda) headless y espera a que el guest responda (si tiene credenciales). */
export async function start(name, { type = 'headless', wait = true, maxMs = 900000, onEvent } = {}) {
  const st = await vbox.state(name);
  if (st !== 'running') { await vbox.start(name, type); await sleep(15000); }
  if (!wait || !hasCreds(name)) return { name, state: await vbox.state(name), waited: false };
  const r = await watchdog.waitReady(name, { maxMs, onEvent });
  return { name, state: await vbox.state(name), waited: true, ...r };
}

/** Apagado limpio (shutdown /s si hay credenciales; si no ACPI) con poweroff forzado a los 4 min. */
export async function stop(name, { force = false } = {}) {
  const st = await vbox.state(name);
  if (st === 'poweroff') return { name, state: st, action: 'already-off' };
  if (force) { await vbox.powerOff(name); return { name, state: await vbox.state(name), action: 'poweroff' }; }
  if (st === 'saved' || st === 'paused' || st === 'aborted') { await vbox.powerOff(name).catch(() => vbox.run(['discardstate', name])); return { name, state: await vbox.state(name), action: 'discarded' }; }
  if (hasCreds(name)) await guest.runPS(name, 'shutdown /s /t 3 /f', { timeoutMs: 20000 }).catch(() => vbox.acpiPowerButton(name));
  else await vbox.acpiPowerButton(name);
  for (let i = 0; i < 24; i++) { await sleep(10000); if (await vbox.state(name) === 'poweroff') return { name, state: 'poweroff', action: 'clean-shutdown' }; }
  L.warn(`${name}: no apagó en 4 min -> poweroff forzado`);
  await vbox.powerOff(name);
  return { name, state: await vbox.state(name), action: 'forced-poweroff' };
}

/** Reinicio seguro: shutdown /r + watchdog (resetea si se cuelga) + espera a que responda. */
export async function restart(name, { maxMs = 900000, onEvent } = {}) {
  if (!hasCreds(name)) { await vbox.reset(name); return { name, action: 'reset', note: 'sin credenciales: reset duro' }; }
  await guest.runPS(name, 'shutdown /r /t 3 /f', { timeoutMs: 20000 }).catch(e => L.warn(`${name}: shutdown /r falló (${e.message}); reset duro`) || vbox.reset(name));
  await sleep(20000);
  const r = await watchdog.waitReady(name, { maxMs, onEvent });
  return { name, action: 'restart', ...r };
}

export const reset = async (name) => { await vbox.reset(name); return { name, action: 'reset' }; };
export const saveState = async (name) => { await vbox.saveState(name); return { name, state: await vbox.state(name) }; };

export async function screenshot(name) {
  const st = await vbox.state(name);
  if (st !== 'running') throw new Error(`La VM "${name}" no está en ejecución (${st})`);
  return vbox.screenshot(name);
}

export const run = (name, code, opts) => guest.runPS(name, code, opts);
export const runAdmin = (name, code, opts) => guest.runPSAdmin(name, code, opts);
export const runSSH = (name, cmd, opts) => guest.runSSH(name, cmd, opts);
export const copyTo = guest.copyTo;
export const copyFrom = guest.copyFrom;

export const show = (name) => windows.showVm(name);
export const hide = (name) => windows.hideVm(name);

export const snapshots = {
  list: async (name) => (await vbox.info(name)).snapshots,
  take: async (name, snap, description) => { await vbox.snapshotTake(name, snap, description); return { name, snapshot: snap, action: 'taken' }; },
  restore: async (name, snap) => {
    const st = await vbox.state(name);
    if (st === 'running') throw new Error('Apaga la VM antes de restaurar un snapshot');
    await vbox.snapshotRestore(name, snap); return { name, snapshot: snap, action: 'restored' };
  },
  delete: async (name, snap) => { await vbox.snapshotDelete(name, snap); return { name, snapshot: snap, action: 'deleted' }; },
};
