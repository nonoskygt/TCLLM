// Integración con agentes: detecta los instalados, genera snippets de configuración MCP e instala config + skill.
// Formatos verificados (2026-09): Claude Code (~/.claude.json mcpServers type http), Codex (~/.codex/config.toml
// [mcp_servers.x] url + bearer_token_env_var), OpenCode (opencode.json mcp type remote + headers), Qwen Code y
// Gemini CLI (settings.json mcpServers httpUrl + headers), Cursor (~/.cursor/mcp.json url + headers),
// Windsurf (~/.codeium/windsurf/mcp_config.json serverUrl). Skills SKILL.md: ~/.claude/skills, ~/.codex/skills,
// ~/.config/opencode/skills y ~/.agents/skills (alias multi-runtime).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { getConfig, PKG_ROOT } from './config.js';
import { tools } from './tools.js';
import { log } from './log.js';

const L = log('agents');
const H = os.homedir();
const j = (...p) => path.join(H, ...p);

function baseUrl() { const s = getConfig().server; return `http://${s.host === '0.0.0.0' ? '127.0.0.1' : s.host}:${s.port}`; }
const mcpUrl = () => baseUrl() + '/mcp';
const key = () => getConfig().server.apiKey;

export const AGENTS = {
  claude:   { title: 'Claude Code',  detect: [j('.claude.json'), j('.claude')], config: j('.claude.json'), skills: j('.claude', 'skills', 'tcllm') },
  codex:    { title: 'Codex CLI',    detect: [j('.codex')], config: j('.codex', 'config.toml'), skills: j('.codex', 'skills', 'tcllm') },
  opencode: { title: 'OpenCode',     detect: [j('.config', 'opencode'), j('.local', 'share', 'opencode')], config: j('.config', 'opencode', 'opencode.json'), skills: j('.config', 'opencode', 'skills', 'tcllm') },
  qwen:     { title: 'Qwen Code',    detect: [j('.qwen')], config: j('.qwen', 'settings.json'), context: j('.qwen', 'QWEN.md') },
  gemini:   { title: 'Gemini CLI',   detect: [j('.gemini')], config: j('.gemini', 'settings.json'), context: j('.gemini', 'GEMINI.md') },
  cursor:   { title: 'Cursor',       detect: [j('.cursor')], config: j('.cursor', 'mcp.json') },
  windsurf: { title: 'Windsurf',     detect: [j('.codeium', 'windsurf')], config: j('.codeium', 'windsurf', 'mcp_config.json') },
  agents:   { title: 'Skill genérica (~/.agents/skills, la leen Codex, Copilot, Gemini, OpenCode...)', detect: [], skills: j('.agents', 'skills', 'tcllm') },
};

export function detect() {
  return Object.entries(AGENTS).map(([id, a]) => ({ id, title: a.title, installed: a.detect.some(p => fs.existsSync(p)), config: a.config || null, skills: a.skills || null, configured: a.config ? isConfigured(id) : null }));
}

function isConfigured(id) {
  const a = AGENTS[id];
  try { return fs.existsSync(a.config) && fs.readFileSync(a.config, 'utf8').includes('tcllm'); } catch { return false; }
}

export function snippets() {
  const url = mcpUrl(), k = key();
  return {
    url, apiKey: k,
    // Claude Code va por el puente stdio (src/stdio-bridge.js): con HTTP, un reinicio de TCLLM deja la conexión "failed" y
    // hay que hacer /mcp -> Reconnect a mano en cada sesión. El puente espera y reintenta solo. "playwright" queda como
    // el mismo puente en modo --browser-only (mismas tools y nombres que el Playwright MCP). La key la lee el puente.
    claude: { file: AGENTS.claude.config, cli: `claude mcp add --scope user tcllm -- "${process.execPath}" "${path.join(PKG_ROOT, 'bin', 'tcllm.js')}" mcp-stdio`, json: { mcpServers: {
      tcllm: { type: 'stdio', command: process.execPath, args: [path.join(PKG_ROOT, 'bin', 'tcllm.js'), 'mcp-stdio'], env: {} },
      playwright: { type: 'stdio', command: process.execPath, args: [path.join(PKG_ROOT, 'bin', 'tcllm.js'), 'mcp-stdio', '--browser-only'], env: {} },
    } } },
    claudeHttp: { note: 'Alternativa por HTTP (se cae con cada reinicio de TCLLM)', json: { mcpServers: { tcllm: { type: 'http', url, headers: { Authorization: `Bearer ${k}` } } } } },
    codex: { file: AGENTS.codex.config, toml: `[mcp_servers.tcllm]\nurl = "${url}"\nbearer_token_env_var = "TCLLM_API_KEY"\n`, env: `setx TCLLM_API_KEY "${k}"`, cli: `codex mcp add tcllm --url ${url} --bearer-token-env-var TCLLM_API_KEY` },
    opencode: { file: AGENTS.opencode.config, json: { mcp: { tcllm: { type: 'remote', url, enabled: true, oauth: false, headers: { Authorization: `Bearer ${k}` } } } } },
    qwen: { file: AGENTS.qwen.config, json: { mcpServers: { tcllm: { httpUrl: url, headers: { Authorization: `Bearer ${k}` }, timeout: 120000 } } } },
    gemini: { file: AGENTS.gemini.config, json: { mcpServers: { tcllm: { httpUrl: url, headers: { Authorization: `Bearer ${k}` }, timeout: 120000 } } } },
    cursor: { file: AGENTS.cursor.config, json: { mcpServers: { tcllm: { url, headers: { Authorization: `Bearer ${k}` } } } } },
    windsurf: { file: AGENTS.windsurf.config, json: { mcpServers: { tcllm: { serverUrl: url, headers: { Authorization: `Bearer ${k}` } } } } },
    stdio: { note: 'Para clientes sin soporte HTTP', command: process.execPath, args: [path.join(PKG_ROOT, 'bin', 'tcllm.js'), 'mcp-stdio'] },
    rest: { openapi: baseUrl() + '/api/openapi.json', toolsOpenAI: baseUrl() + '/api/tools/openai', example: `curl -H "Authorization: Bearer ${k}" -X POST ${baseUrl()}/api/tools/vm_list -H "Content-Type: application/json" -d "{}"` },
  };
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } }
function writeJson(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak-tcllm'); fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n'); }

export function skillMarkdown() {
  const url = baseUrl();
  const list = tools.map(t => `- \`${t.name}\`: ${t.description}`).join('\n');
  return `---
name: tcllm
description: "Use when a task needs to control a VirtualBox virtual machine (start/stop/restart, screenshots, mouse, keyboard, run PowerShell inside, files, snapshots) or a Playwright browser through TCLLM, or to switch which browser the agents use. Triggers: 'la VM', 'máquina virtual', 'VirtualBox', 'TCLLM', 'dentro de Windows', 'navegador', 'abrí/usá chrome', 'abrí firefox', 'abrí brave', 'cambiá el navegador', 'abrí Windows', 'abrí la VM'."
---

# TCLLM — control total de VMs y navegador para agentes

TCLLM corre en \`${url}\` (panel: \`${url}/\`). Úsalo por **MCP** (servidor \`tcllm\`, tools \`vm_*\`, \`browser_*\`,
\`windows_*\`, \`services_*\`) o por **REST** (\`${url}/api/openapi.json\`, auth \`Authorization: Bearer <apiKey>\`).

## Comandos rápidos (lo que pide el usuario → qué tool llamar)
- **"abrí / usá / cambiá a chrome"** → \`browser_use { "browser": "chrome" }\`. Igual con \`firefox\`, \`brave\`, \`edge\` (=\`msedge\`), \`chromium\`, \`webkit\`.
- **"abrí / encendé Windows / la VM / la máquina"** → \`vm_list\` para ver el nombre (p.ej. \`Win11\`), luego \`vm_start { "vm": "Win11" }\`; \`vm_show { "vm": "Win11" }\` para verla.
- **"mostrá / ocultá el navegador"** → \`browser_windows_show\` / \`browser_windows_hide\`. **"mostrá / ocultá la VM"** → \`vm_show\` / \`vm_hide\`.
- **"¿qué navegadores hay?" / "cuál está activo"** → \`browser_list\`.

> Un solo Playwright compartido: \`browser_use\` lo **relanza** y afecta a todos los agentes conectados (se pierden las pestañas). Cámbialo solo cuando te lo pidan; si el navegador ya es el activo, no hace nada. Chrome, Edge y Brave ya vienen instalados; Firefox/Chromium/WebKit se bajan con \`browser_install\`.

## Navegador compartido: reglas de convivencia (el usuario lo pidió explícitamente)
- **Trabajá en una PESTAÑA propia**: \`browser_tabs { "action": "new" }\`, navegá ahí y al terminar \`browser_tabs { "action": "close" }\`. No toques pestañas de otros agentes.
- **Prohibido abrir ventanas o contextos nuevos**: nada de \`browser.newContext()\`, \`browser.newPage()\`, \`window.open\` ni copiar \`storageState\` a otro contexto dentro de \`browser_run_code_unsafe\`. Cada contexto nuevo abre una VENTANA en el escritorio del usuario. Los logins ya están en el perfil compartido: no hace falta otro contexto.
- **Nada de bucles** que abran o recarguen cosas cada pocos segundos. Llamadas cortas (< 30 s); si hace falta esperar, esperá dentro de una sola llamada.
- Identificate por REST con la cabecera \`X-TCLLM-Client: <tu-nombre>\` (así el usuario ve qué agente usa cada pestaña en el panel).

## Flujo con una VM
1. \`vm_list\` → estado. Si no está \`running\`: \`vm_start\` (tarda 1-5 min; espera solo).
2. \`vm_screenshot\` → mira la pantalla. Coordenadas de \`vm_click\`/\`vm_drag\` = las de esa imagen.
3. Datos del guest (procesos, archivos, versión, RAM…): \`vm_run\` (PowerShell dentro), **no** capturas. \`admin: true\` para elevado.
4. GUI: \`vm_click\`, \`vm_key\` ("win+r", "ctrl+alt+del", "enter"), \`vm_type\` (ASCII corto), \`vm_paste\` (largo/Unicode).
5. Al terminar cierra lo que abriste (\`vm_run\` con \`Stop-Process\`). No apagues la VM si no te lo pidieron.

## Reglas
- Reiniciar Windows: **solo** \`vm_restart\` (vigila el cuelgue de VirtualBox sobre Hyper-V y resetea). Nunca \`shutdown /r\` a mano.
- Si la VM está en negro y no responde: \`vm_reset\`.
- \`vm_show\` / \`vm_hide\` muestran u ocultan su ventana en el host; \`browser_windows_show/hide\` las del navegador.
- Navegador: tools \`browser_*\` (navigate, snapshot, click, type, …) = Playwright MCP vía TCLLM. \`browser_list\` dice qué navegadores hay
  (Chrome, Edge, Brave, Firefox, Chromium, WebKit) y cuál está activo; \`browser_use\` cambia de navegador (relanza Playwright: se pierden las pestañas);
  \`browser_install\` descarga Firefox/Chromium/WebKit (100-200 MB, tarda).

## Tools
${list}
`;
}

function installSkill(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMarkdown());
  return path.join(dir, 'SKILL.md');
}

function appendContext(file, marker, text) {
  let cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (cur.includes(marker)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, cur + (cur.endsWith('\n') || !cur ? '' : '\n') + text);
  return true;
}

/** Instala config MCP + skill para los agentes indicados (por defecto: los detectados). */
export function install(ids) {
  const s = snippets();
  const targets = ids?.length ? ids : detect().filter(a => a.installed).map(a => a.id);
  if (!targets.includes('agents')) targets.push('agents');
  const done = [];
  for (const id of targets) {
    const a = AGENTS[id]; if (!a) continue;
    const r = { id, title: a.title, files: [] };
    try {
      switch (id) {
        case 'claude': { const c = readJson(a.config); c.mcpServers = { ...(c.mcpServers || {}), ...s.claude.json.mcpServers }; writeJson(a.config, c); r.files.push(a.config); r.files.push(installSkill(a.skills)); break; }
        case 'codex': {
          fs.mkdirSync(path.dirname(a.config), { recursive: true });
          let t = fs.existsSync(a.config) ? fs.readFileSync(a.config, 'utf8') : '';
          if (!/\[mcp_servers\.tcllm\]/.test(t)) { if (fs.existsSync(a.config)) fs.copyFileSync(a.config, a.config + '.bak-tcllm'); t += (t && !t.endsWith('\n') ? '\n' : '') + '\n' + s.codex.toml; fs.writeFileSync(a.config, t); }
          try { execFileSync('setx', ['TCLLM_API_KEY', s.apiKey], { windowsHide: true, stdio: 'ignore' }); r.env = 'TCLLM_API_KEY (usuario)'; } catch (e) { r.envError = e.message; }
          r.files.push(a.config); r.files.push(installSkill(a.skills)); break;
        }
        case 'opencode': { const c = readJson(a.config); if (!c.$schema) c.$schema = 'https://opencode.ai/config.json'; c.mcp = { ...(c.mcp || {}), ...s.opencode.json.mcp }; writeJson(a.config, c); r.files.push(a.config); r.files.push(installSkill(a.skills)); break; }
        case 'qwen': case 'gemini': {
          const c = readJson(a.config); c.mcpServers = { ...(c.mcpServers || {}), ...s[id].json.mcpServers }; writeJson(a.config, c); r.files.push(a.config);
          if (appendContext(a.context, '<!-- tcllm -->', `\n<!-- tcllm -->\n# TCLLM\nPara controlar máquinas virtuales VirtualBox o el navegador Playwright usa el servidor MCP \`tcllm\` (tools vm_*, browser_*). Guía: ${s.url.replace('/mcp', '')}/api/skill.md — reglas: reinicia Windows solo con vm_restart; lee datos del guest con vm_run, no con capturas.\n`)) r.files.push(a.context);
          break;
        }
        case 'cursor': case 'windsurf': { const c = readJson(a.config); c.mcpServers = { ...(c.mcpServers || {}), ...s[id].json.mcpServers }; writeJson(a.config, c); r.files.push(a.config); break; }
        case 'agents': { r.files.push(installSkill(a.skills)); break; }
      }
      r.ok = true; L.info(`integración ${id}: ${r.files.join(', ')}`);
    } catch (e) { r.ok = false; r.error = e.message; L.warn(`integración ${id} falló: ${e.message}`); }
    done.push(r);
  }
  return done;
}
