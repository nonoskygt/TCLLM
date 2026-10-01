#!/usr/bin/env node
// Encuentra el Playwright MCP de TCLLM en la red SIN depender de la IP (la laptop cambia de IP entre cable y Wi-Fi).
// Orden: --host / TCLLM_HOST -> nombre de host de la laptop -> última dirección que funcionó -> barrido del /24 propio.
// Sin dependencias (Node >= 18). Imprime la URL del MCP en stdout (con --json, un objeto); sale con 1 si no encuentra nada.
//   node find-tcllm.mjs [--port 8931] [--host NOMBRE_O_IP] [--no-scan] [--json]
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_PORT = 8931;
export const DEFAULT_NAMES = ['NONOLAPTOP', 'nonolaptop.local', 'nonolaptop.lan'];
const VIRTUAL_MAC = /^(0a|08):00:27|^00:50:56|^00:0c:29|^00:15:5d/i;   // VirtualBox, VMware, Hyper-V: no son la LAN
const cacheFile = () => process.env.TCLLM_CACHE || path.join(os.homedir(), '.tcllm-last-host');

/** ¿Hay un Playwright MCP en host:port? GET /mcp sin sesión responde 400 "Invalid request" (no abre sesión ni toca el navegador). */
export async function probe(host, port = DEFAULT_PORT, timeoutMs = 1500) {
  try {
    const r = await fetch(`http://${host}:${port}/mcp`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.status === 400 && (await r.text()).includes('Invalid request');
  } catch { return false; }
}

function tcpOpen(host, port, ms) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** Prefijos /24 (a.b.c) de las interfaces reales con IP privada; se saltan loopback y las de VirtualBox/VMware/Hyper-V. */
export function localSubnets() {
  const out = new Set();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || VIRTUAL_MAC.test(a.mac || '')) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) continue;
      out.add(a.address.split('.').slice(0, 3).join('.'));
    }
  }
  return [...out];
}

/** Barre prefix.1-254 buscando el puerto abierto y, si lo está, comprueba que sea el Playwright MCP. Devuelve las IPs que lo son. */
export async function scan(prefix, port = DEFAULT_PORT, { concurrency = 64, tcpMs = 500 } = {}) {
  const found = [];
  const ips = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < ips.length) { const ip = ips[next++]; if (await tcpOpen(ip, port, tcpMs) && await probe(ip, port)) found.push(ip); }
  }));
  return found;
}

function readCache() { try { return fs.readFileSync(cacheFile(), 'utf8').trim(); } catch { return ''; } }
function writeCache(host) { try { fs.writeFileSync(cacheFile(), host + '\n'); } catch {} }

/** Busca el MCP. Devuelve { host, url, via: 'nombre'|'cache'|'barrido', tried } o null. */
export async function find({ port = DEFAULT_PORT, names = DEFAULT_NAMES, extra = [], scanLan = true } = {}) {
  const tried = [];
  const candidates = [...new Set([...extra, process.env.TCLLM_HOST, ...names].filter(Boolean))];
  for (const h of candidates) {
    tried.push(h);
    if (await probe(h, port)) { writeCache(h); return { host: h, url: `http://${h}:${port}/mcp`, via: 'nombre', tried }; }
  }
  const cached = readCache();
  if (cached && !tried.includes(cached)) {
    tried.push(cached);
    if (await probe(cached, port)) return { host: cached, url: `http://${cached}:${port}/mcp`, via: 'cache', tried };
  }
  if (scanLan) {
    for (const prefix of localSubnets()) {
      tried.push(`${prefix}.0/24`);
      const hits = await scan(prefix, port);
      if (hits.length) { writeCache(hits[0]); return { host: hits[0], url: `http://${hits[0]}:${port}/mcp`, via: 'barrido', tried, all: hits }; }
    }
  }
  return null;
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const port = +(opt('--port') || process.env.TCLLM_PORT || DEFAULT_PORT);
  const res = await find({ port, extra: opt('--host') ? [opt('--host')] : [], scanLan: !argv.includes('--no-scan') });
  if (!res) {
    console.error(`No encontré el Playwright MCP de TCLLM en el puerto ${port}. ¿Está encendida la laptop y en la misma red? (el firewall solo deja entrar a las redes permitidas en el panel)`);
    process.exitCode = 1;
    return;
  }
  console.log(argv.includes('--json') ? JSON.stringify(res) : res.url);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
