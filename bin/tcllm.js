#!/usr/bin/env node
// CLI de TCLLM: start | status | mcp-stdio | install-agents | apikey | config
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { loadConfig, CONFIG_FILE, HOME } from '../src/config.js';

const VERSION = createRequire(import.meta.url)('../package.json').version;
const [cmd = 'help', ...rest] = process.argv.slice(2);
const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : null; };

const HELP = `TCLLM ${VERSION} — Total Control for LLMs
  tcllm start                       arranca el servidor (API + MCP + panel + monitor)
  tcllm status                      estado resumido (llama a la API local)
  tcllm mcp-stdio                   servidor MCP por stdio (para clientes sin HTTP)
  tcllm install-agents [--for a,b]  configura MCP + skill en los agentes detectados (claude,codex,opencode,qwen,gemini,cursor,windsurf)
  tcllm apikey                      muestra la API key
  tcllm config                      ruta y contenido (sin secretos) de config.json
`;

// Errores no capturados -> ~/.tcllm/logs/crash.log (el proceso corre oculto bajo la tarea programada)
const crash = (kind) => (e) => { try { fs.mkdirSync(`${HOME}/logs`, { recursive: true }); fs.appendFileSync(`${HOME}/logs/crash.log`, `${new Date().toISOString()} ${kind}: ${e?.stack || e}\n`); } catch {} console.error(e); if (kind === 'uncaughtException') process.exit(1); };
process.on('uncaughtException', crash('uncaughtException'));
process.on('unhandledRejection', crash('unhandledRejection'));

switch (cmd) {
  case 'start': { const { startServer } = await import('../src/server.js'); await startServer(); break; }
  case 'mcp-stdio': {
    // stdout es el transporte MCP: los logs van a stderr
    const { logger } = await import('../src/log.js');
    console.log = (...a) => console.error(...a);
    loadConfig();
    const { runStdio } = await import('../src/mcp.js');
    const { bridge } = await import('../src/bridge.js');
    const { playwright } = await import('../src/playwright.js');
    bridge.start().catch(() => {});
    playwright.start().catch(() => {});
    await runStdio();
    break;
  }
  case 'status': {
    const cfg = loadConfig();
    const r = await fetch(`http://${cfg.server.host === '0.0.0.0' ? '127.0.0.1' : cfg.server.host}:${cfg.server.port}/api/status`, { headers: { Authorization: `Bearer ${cfg.server.apiKey}` } }).catch(e => null);
    if (!r) { console.log('TCLLM no responde en el puerto', cfg.server.port); process.exit(1); }
    const s = await r.json();
    console.log(`TCLLM ${s.tcllm.version} pid ${s.tcllm.pid} uptime ${Math.round(s.tcllm.uptimeMs / 1000)}s  |  VirtualBox ${s.virtualbox.ok ? s.virtualbox.version : 'NO'}  |  Playwright ${s.playwright.listening ? 'up ' + s.playwright.url : 'down'}  |  MCP sessions ${s.mcpSessions}`);
    for (const v of s.vms) console.log(`  VM ${v.name.padEnd(12)} ${v.state.padEnd(9)} ${v.controllable ? 'controlable' : ''} ${v.ssh === true ? 'ssh:ok' : v.ssh === false ? 'ssh:down' : ''}`);
    break;
  }
  case 'install-agents': {
    loadConfig();
    const { install, detect } = await import('../src/agents.js');
    const ids = flag('--for')?.split(',').map(s => s.trim()).filter(Boolean);
    console.log('Agentes detectados:', detect().filter(a => a.installed).map(a => a.title).join(', ') || 'ninguno');
    for (const r of install(ids)) console.log(`${r.ok ? 'OK ' : 'ERR'} ${r.title}: ${r.ok ? r.files.join(', ') : r.error}${r.env ? ' (+ env ' + r.env + ')' : ''}`);
    break;
  }
  case 'apikey': { console.log(loadConfig().server.apiKey); break; }
  case 'config': { const { redactedConfig } = await import('../src/config.js'); loadConfig(); console.log(CONFIG_FILE); console.log(JSON.stringify(redactedConfig(), null, 2)); break; }
  case '--version': case '-v': console.log(VERSION); break;
  default: console.log(HELP);
}
