// Watchdog del cuelgue de reinicio (VirtualBox sobre Hyper-V / NEM): cuando Windows pide reiniciar, el reset
// nunca llega. Firma: pantalla negra o congelada (PNG pequeño) + las vCPU con IF=0 + RIP sin cambio en N muestras.
// Ver docs/spec.md. Se usa en vmStart/vmRestart y como vigilancia opcional continua.
import * as vbox from './vbox.js';
import * as guest from './guest.js';
import { getConfig } from './config.js';
import { log } from './log.js';

const L = log('watchdog');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function ifClear(rflags) { return (BigInt(rflags) & 0x200n) === 0n; }
function coarse(rip) { return rip.slice(0, -2); } // 256 B: un bucle de espera oscila entre pocas instrucciones

/** Una muestra: {frozen:boolean, size, ifAllClear, sig} */
export async function sample(vm, cpus) {
  let size = 0;
  try { size = (await vbox.screenshot(vm, { retries: 1 })).png.length; } catch { size = 0; }
  const regs = await vbox.cpuRegisters(vm, cpus);
  const ifAllClear = regs.length > 0 && regs.every(r => ifClear(r.rflags));
  const sig = regs.map(r => coarse(r.rip) + ':' + (ifClear(r.rflags) ? 0 : 1)).join('|');
  return { size, ifAllClear, sig, frozen: size < 20000 && ifAllClear };
}

/**
 * Vigila la VM hasta que Windows responda (guestcontrol) o se agote el tiempo; resetea si detecta el cuelgue.
 * Devuelve {ready, resets, elapsedMs, reason}.
 */
export async function waitReady(vm, { maxMs = 900000, onEvent } = {}) {
  const cfg = getConfig().watchdog;
  const cpus = (await vbox.info(vm)).cpus || 4;
  const t0 = Date.now();
  let prev = null, same = 0, resets = 0;
  while (Date.now() - t0 < maxMs) {
    const st = await vbox.state(vm);
    if (st !== 'running') return { ready: false, resets, elapsedMs: Date.now() - t0, reason: `VM ${st}` };
    const s = await sample(vm, cpus);
    if (cfg.enabled && s.frozen && prev && s.sig === prev) same++; else same = 0;
    prev = s.sig;
    if (same >= cfg.samplesToReset - 1) {
      resets++; same = 0; prev = null;
      L.warn(`${vm}: cuelgue de reinicio detectado -> reset #${resets}`);
      onEvent?.({ type: 'watchdog-reset', vm, resets });
      await vbox.reset(vm);
      await sleep(20000);
      continue;
    }
    if (s.size > 100000 && await guest.ready(vm).catch(() => false)) {
      return { ready: true, resets, elapsedMs: Date.now() - t0, reason: 'guest responde' };
    }
    await sleep(cfg.sampleMs);
  }
  return { ready: false, resets, elapsedMs: Date.now() - t0, reason: 'timeout' };
}

/** ¿Está la VM colgada ahora mismo? (dos muestras separadas 30 s) */
export async function isHung(vm) {
  const cpus = (await vbox.info(vm)).cpus || 4;
  const a = await sample(vm, cpus);
  if (!a.frozen) return false;
  await sleep(30000);
  const b = await sample(vm, cpus);
  return b.frozen && a.sig === b.sig;
}
