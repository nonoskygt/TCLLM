# TCLLM — Total Control for LLMs — Diseño

**Qué es**: un servicio instalable (Windows primero) que da a cualquier LLM/agente control remoto de
(a) máquinas virtuales VirtualBox y (b) navegadores Playwright, con API REST, servidor MCP, panel de
administración web, monitor/supervisor de servicios y gestor de ventanas (mostrar/ocultar).

Nace de dos piezas que ya funcionaban por separado en esta máquina: `D:\VMs\tools` (control de la VM Win11)
y `~\playwright-mcp-service` (Playwright MCP compartido multi-agente). TCLLM las unifica en un producto.

## Principios
1. **Un solo proceso, un solo puerto** (`tcllm-server`, por defecto `:7777`): API, MCP, panel y salud.
2. **Cualquier LLM**: REST + OpenAPI 3.1 (`/api/openapi.json`) + export de tools en formato OpenAI
   (`/api/tools/openai`) + MCP (Streamable HTTP en `/mcp`, y stdio con `tcllm mcp-stdio`).
3. **Sin módulos nativos**: Node puro + PowerShell "sidecar" persistente (`ps/bridge.ps1`) para COM de
   VirtualBox (ratón), Win32 (ventanas) y portapapeles. Empaquetable con Node incluido.
4. **No romper lo que hay**: TCLLM supervisa *su* Playwright MCP en el puerto que diga la config; migrar el
   servicio actual (:8931) es un paso explícito.
5. **Windows en sesión interactiva** (tarea programada al iniciar sesión), no servicio de Windows: mostrar/ocultar
   ventanas exige sesión de usuario.

## Componentes (src/)
| Módulo | Responsabilidad |
|---|---|
| `config.js` | `config.json` (puerto, host, apiKey, VMs, playwright, rutas). Valores por defecto sensatos. |
| `vbox.js` | VBoxManage: list/info/start/stop/reset/snapshots/screenshot/keyboard; detección de VirtualBox. |
| `guest.js` | Ejecutar PowerShell dentro (guestcontrol + `-EncodedCommand`), elevado (RunAs sin UAC), copiar archivos. |
| `input.js` | Ratón absoluto (COM `IMouse`), teclado (scancodes), `paste` vía portapapeles compartido. |
| `windows.js` | Enumerar/mostrar/ocultar ventanas (Win32 ShowWindow) de VMs (VirtualBoxVM.exe) y navegadores (chrome/msedge de Playwright). Attach GUI a VM headless (`VirtualBoxVM --separate --startvm`). |
| `watchdog.js` | Cuelgue de reinicio bajo Hyper-V/NEM: pantalla congelada + IF=0 en todas las vCPU + RIP estático → reset. |
| `playwright.js` | Supervisor del Playwright MCP (spawn, restart, salud TCP+MCP initialize), ventanas del navegador. |
| `services.js` | Monitor: tcllm, VirtualBox, cada VM (estado, GA, sshd), Playwright MCP, host (CPU/RAM/disco). Historial y eventos. |
| `mcp.js` | Servidor MCP `tcllm`: tools `vm_*`, `services_*`, `browser_*` (proxy 1:1 al Playwright MCP). |
| `api.js` | REST + OpenAPI + auth Bearer/apiKey + export OpenAI tools. |
| `agents.js` | Genera configuraciones e instala skills para Claude Code, Codex, OpenCode, Qwen Code, Gemini CLI, Cursor, Windsurf. |
| `server.js` | Express: monta API, MCP, panel estático, WebSocket de eventos/logs. |
| `panel/` | SPA sin framework: Dashboard, VMs (control remoto en vivo), Navegador, Servicios, Ventanas, Conectar (snippets), Logs, Ajustes. |

## Seguridad
- API key obligatoria (`Authorization: Bearer <key>` o `X-Api-Key`); se genera en la instalación y se muestra en el panel.
- `host` por defecto `127.0.0.1`; exponer a LAN es una decisión explícita en config.
- Las credenciales del guest viven en `config.json` (permisos de usuario), nunca en logs.

## Empaquetado / instalación
- `scripts/install.ps1`: winget (VirtualBox opcional), Node incluido en el paquete, `npm ci --omit=dev`,
  navegador (Chrome del sistema o `playwright install chromium`), tarea programada `TCLLM`, API key, config inicial.
- `npm run pack` → `dist/TCLLM-<ver>-win64.zip` (código + node_modules + Node runtime) y, si hay `iexpress`,
  `TCLLM-<ver>-setup.exe` auto-extraíble que lanza `install.ps1`.
- `tcllm` CLI: `start`, `status`, `install-agents [--for claude,codex,opencode,qwen,gemini,cursor]`, `mcp-stdio`, `pack`.

## Fuera de alcance (v1)
Linux/macOS host, hipervisores distintos de VirtualBox, multiusuario/roles, TLS (poner un reverse proxy).
