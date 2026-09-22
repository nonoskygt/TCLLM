// Prueba multi-agente del Playwright MCP de TCLLM: abre DOS sesiones MCP a la vez contra el servidor, navega cada una a
// una URL distinta, comprueba que los contextos están aislados, que aparecen dos ventanas nuevas del navegador y cierra
// ambas. Si el storage-state contiene la cookie canario pwmcp_test para example.com (la pone `tcllm login`), comprueba
// además que la inyección de logins llega al contexto.
//
//   node test/multi-client.mjs [url-del-mcp]      (por defecto la de la config, p.ej. http://127.0.0.1:8931/mcp)
import fs from 'node:fs';
import path from 'node:path';
import { McpHttpClient, defaultUrl } from '../tools/mcp-client.mjs';
import { getConfig, HOME } from '../src/config.js';
import * as windows from '../src/windows.js';
import { bridge } from '../src/bridge.js';

const BASE = process.argv[2] || defaultUrl();
const stateFile = getConfig().playwright.storageState || path.join(HOME, 'storage-state.json');

// Ventanas visibles de navegadores lanzados por Playwright (EnumWindows real vía el bridge PowerShell). Desde un proceso
// aparte no sabemos cuáles son "nuestras" (eso lo sabe el servidor), así que contamos todas las de Playwright.
async function browserWindows() {
  try { return (await windows.list()).filter(w => w.kind.startsWith('browser') && w.visible).map(w => w.title); } catch { return []; }
}

function canaryPresent() {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return (state.cookies || []).some(c => c.name === 'pwmcp_test' && /example\.com$/.test(c.domain));
  } catch { return false; }
}

const t0 = Date.now();
const fail = (m) => { console.error(`FALLO: ${m}`); process.exitCode = 1; };
const a = new McpHttpClient('test-agent-A', BASE);
const b = new McpHttpClient('test-agent-B', BASE);
console.log(`Servidor: ${BASE}`);
const winsBefore = (await browserWindows()).length;
console.log(`Ventanas de navegador (Playwright) antes: ${winsBefore}`);

try {
  const [ia] = await Promise.all([a.init(), b.init()]);
  console.log(`A conectado (sesión ${a.sessionId.slice(0, 8)}...), B conectado (sesión ${b.sessionId.slice(0, 8)}...), servidor ${ia.serverInfo?.name} ${ia.serverInfo?.version}`);
  if (a.sessionId === b.sessionId) fail('las dos sesiones comparten id');

  const [na, nb] = await Promise.all([
    a.call('browser_navigate', { url: 'https://example.com/' }),
    b.call('browser_navigate', { url: 'https://example.org/' }),
  ]);
  const titleOf = (t) => (t.match(/Page Title: (.*)/) || [])[1] || '(sin título)';
  console.log(`A navegó: ${titleOf(na)} | B navegó: ${titleOf(nb)}`);

  const [ta, tb] = await Promise.all([a.call('browser_tabs', { action: 'list' }), b.call('browser_tabs', { action: 'list' })]);
  const tabsOf = (t) => (t.match(/^- \d+:/gm) || []).length;
  console.log(`Pestañas que ve A: ${tabsOf(ta)} | que ve B: ${tabsOf(tb)} (cada agente solo ve las suyas)`);
  if (tabsOf(ta) !== 1 || tabsOf(tb) !== 1) fail('un agente ve pestañas del otro: los contextos no están aislados');
  if (/example\.org/.test(ta) || /example\.com/.test(tb)) fail('un agente ve la URL del otro');

  const wins = await browserWindows();
  console.log(`Ventanas con las dos sesiones abiertas: ${wins.length} -> ${wins.join(' | ')}`);
  if (wins.length < winsBefore + 2) fail(`esperaba ${winsBefore + 2} ventanas visibles (2 nuevas), hay ${wins.length}`);

  if (canaryPresent()) {
    const cookie = await a.call('browser_evaluate', { function: '() => document.cookie' });
    const ok = cookie.includes('pwmcp_test=ok');
    console.log(`Cookie canario del storage-state en example.com: ${ok ? 'PRESENTE' : 'AUSENTE'}`);
    if (!ok) fail('el storage-state no se inyectó en el contexto del agente');
  } else {
    console.log(`Sin cookie canario en ${stateFile}: se omite la comprobación de inyección de logins.`);
  }
} catch (e) {
  fail(e.message);
} finally {
  await Promise.all([a.close().catch(e => fail(`cierre A: ${e.message}`)), b.close().catch(e => fail(`cierre B: ${e.message}`))]);
  await new Promise(r => setTimeout(r, 1500));
  console.log(`Ventanas tras cerrar las sesiones: ${(await browserWindows()).length}`);
  console.log(`${process.exitCode ? 'RESULTADO: FALLO' : 'RESULTADO: OK'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  bridge.stop();
}
