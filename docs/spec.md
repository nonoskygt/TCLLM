# TCLLM — Total Control for LLMs — Diseño

**Qué es**: un servicio instalable (Windows) que da a cualquier LLM/agente control remoto de (a) máquinas virtuales
VirtualBox y (b) navegadores Playwright, con API REST, servidor MCP, panel de administración web, monitor/supervisor
de servicios y gestor de ventanas (mostrar/ocultar).

Unifica en un producto dos piezas que suelen vivir por separado: un controlador de VMs (VBoxManage + COM + Win32) y un
Playwright MCP compartido entre agentes.

## Principios
1. **Un solo proceso, un solo puerto** (`tcllm start`, por defecto `:7777`): API, MCP, panel y salud.
2. **Cualquier LLM**: REST + OpenAPI 3.1 (`/api/openapi.json`) + export de tools en formato OpenAI
   (`/api/tools/openai`) + MCP (Streamable HTTP en `/mcp`, y stdio con `tcllm mcp-stdio`).
3. **Un registro único de tools** (`src/tools.js`: nombre, descripción, JSON Schema, handler) del que salen MCP, REST,
   OpenAI tools y OpenAPI. Añadir una tool = una entrada.
4. **Sin módulos nativos**: Node puro + PowerShell "sidecar" persistente (`ps/bridge.ps1`) para COM de VirtualBox (ratón),
   Win32 (ventanas) y portapapeles. Empaquetable con Node incluido.
5. **Convivir con lo que haya**: si el puerto del Playwright MCP ya tiene un Playwright MCP, TCLLM lo adopta; si lo ocupa
   otro programa, usa el siguiente puerto libre. No toca servicios ajenos.
6. **Windows en sesión interactiva** (tarea programada al iniciar sesión), no servicio de Windows: mostrar/ocultar
   ventanas exige sesión de usuario.

## Componentes (src/)
| Módulo | Responsabilidad |
|---|---|
| `config.js` | `config.json` (puerto, host, apiKey, VMs, playwright, rutas). Valores por defecto sensatos. Tolera BOM. |
| `tools.js` | Registro único de tools: `vm_*`, `windows_*`, `services_*` + proxy `browser_*` (tools del Playwright MCP). |
| `vbox.js` | VBoxManage: list/info/start/stop/reset/snapshots/screenshot/keyboard; enmascara la contraseña del guest en errores. |
| `guest.js` | Ejecutar PowerShell dentro (guestcontrol + `-EncodedCommand`), elevado (RunAs sin UAC), copiar archivos, SSH. |
| `input.js` | Ratón absoluto (COM `IMouse`), teclado (scancodes), `paste` vía portapapeles compartido. |
| `windows.js` | Enumerar/mostrar/ocultar ventanas (Win32 ShowWindow) de VMs (VirtualBoxVM.exe) y del navegador de nuestro Playwright (por árbol de procesos). Attach GUI a VM headless (`VirtualBoxVM --separate --startvm`). |
| `watchdog.js` | Cuelgue de reinicio bajo Hyper-V/NEM: pantalla congelada + IF=0 en todas las vCPU + RIP estático → reset. |
| `browsers.js` | Catálogo de navegadores (Chrome, Edge, Brave, Chromium, Firefox, WebKit): detección, argumentos de lanzamiento, instalación de builds de Playwright. |
| `playwright.js` | Supervisor del Playwright MCP (spawn, restart, salud TCP+MCP, adopción, puerto libre), cliente MCP para el proxy. |
| `services.js` | Monitor: tcllm, VirtualBox, cada VM (estado, GA, sshd), Playwright MCP, host (CPU/RAM/disco). Historial y eventos. Relanza Playwright si desaparece. |
| `mcp.js` | Servidor MCP `tcllm` (low-level Server: tools/list y tools/call sobre el registro + proxy). Sesiones Streamable HTTP y stdio. |
| `api.js` | REST + OpenAPI + auth Bearer/apiKey + export OpenAI tools + config. |
| `agents.js` | Detecta agentes instalados, genera snippets e instala config MCP + SKILL.md (Claude Code, Codex, OpenCode, Qwen Code, Gemini CLI, Cursor, Windsurf, `~/.agents/skills`). |
| `server.js` | Express: monta API, MCP, panel estático, WebSocket de eventos/logs. |
| `panel/` | SPA sin framework: Dashboard, VMs (control remoto en vivo), Navegador, Ventanas, Servicios, Conectar, Logs, Ajustes. |
| `tools/` | `login.mjs` (`tcllm login`: exporta/fusiona logins al storage-state con el navegador del servidor), `check-login.mjs` (`tcllm check-login`), `mcp-client.mjs` (cliente Streamable HTTP mínimo para hablar con el Playwright MCP crudo). `test/multi-client.mjs`: prueba de aislamiento multi-agente. |

## Seguridad
- API key obligatoria (`Authorization: Bearer <key>` o `X-Api-Key`); se genera en la instalación y se muestra en el panel.
- `host` por defecto `127.0.0.1`; exponer a LAN es una decisión explícita en config. Sin TLS propio (reverse proxy).
- Las credenciales del guest viven en `config.json` (permisos de usuario). VBoxManage las recibe como argumento (así lo exige
  VirtualBox); TCLLM las enmascara en mensajes de error y no las escribe en logs.

## Empaquetado / instalación
- `scripts/install.ps1`: copia a `%LOCALAPPDATA%\TCLLM`, Node incluido en el paquete (o winget si falta y hay winget),
  VirtualBox con winget si falta (opcional), Firefox (build de Playwright) como navegador por defecto con fallback a Chrome/Edge, config inicial con API key, tarea programada
  `TCLLM` al iniciar sesión + cada 5 min como watchdog (`MultipleInstances=IgnoreNew`: sin duplicados; relanza si el proceso
  murió sin cerrar sesión, p.ej. apagado abortado) (oculta: `wscript` + `start-hidden.vbs`; `conhost --headless` si no hay VBScript), PATH de usuario.
- `scripts/pack.ps1` → `dist/TCLLM-<ver>-win64.zip` (código + node_modules + runtime Node) y `TCLLM-<ver>-setup.exe`:
  stub C# (`scripts/sfx/Setup.cs`) compilado con el `csc.exe` de .NET Framework que trae Windows, con el ZIP adjunto tras el
  marcador `TCLLMZIP!`; al ejecutarlo extrae a `%TEMP%` y lanza `install.ps1`.
- `tcllm` CLI: `start`, `status`, `mcp-stdio`, `install-agents [--for claude,codex,opencode,qwen,gemini,cursor,windsurf]`,
  `apikey`, `config`. El empaquetado es `npm run pack`.

## Fuera de alcance (v1)
Linux/macOS host, hipervisores distintos de VirtualBox, multiusuario/roles, TLS, firma de código del instalador.
