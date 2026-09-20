# TCLLM — Total Control for LLMs

Control remoto de **máquinas virtuales VirtualBox** y **navegadores Playwright** para cualquier LLM o agente:
API REST + OpenAPI, servidor MCP, tools en formato OpenAI, panel de administración web, monitor/supervisor de
servicios y gestor de ventanas (mostrar/ocultar). Un solo proceso, un solo puerto. Windows.

```
Claude Code / Codex / OpenCode / Qwen Code / Gemini CLI / Cursor / Windsurf / cualquier LLM
        │  MCP (HTTP o stdio)      │  REST + OpenAPI       │  panel web
        └──────────────────────────┴───────────────────────┴───────────────┐
                                   TCLLM  :7777                            │
   ┌──────────────┬────────────────┬───────────────┬──────────────┬────────┴─────┐
   │ vm_*         │ browser_*      │ windows_*     │ services_*   │ monitor      │
   │ VirtualBox   │ Playwright MCP │ Win32 ShowWnd │ estado/event │ supervisor   │
   │ VBoxManage   │ (supervisado)  │ VirtualBoxVM  │ host/VMs/pw  │ watchdog     │
   └──────────────┴────────────────┴───────────────┴──────────────┴──────────────┘
```

## Instalación (Windows)
1. Descarga `TCLLM-<ver>-win64.zip` (o `TCLLM-<ver>-setup.exe`) y extráelo.
2. Ejecuta `install.cmd` (o `powershell -ExecutionPolicy Bypass -File scripts\install.ps1`).
   - Instala en `%LOCALAPPDATA%\TCLLM`, crea `~\.tcllm\config.json` con una API key, registra la tarea programada
     `TCLLM` (arranca al iniciar sesión, oculta) y la lanza. Node va incluido; VirtualBox se instala con winget si falta.
3. Abre `http://127.0.0.1:7777/` e introduce la API key (`tcllm apikey`).
4. Añade tus VMs en `config.json` → `vms` (usuario/contraseña del guest, puerto SSH opcional) para poder ejecutar
   comandos dentro. Sin credenciales, TCLLM las puede encender/apagar/capturar/teclear igualmente.
5. `tcllm install-agents` configura el MCP + skill en los agentes detectados (o `--for claude,codex,opencode,qwen,gemini,cursor,windsurf`).

Desinstalar: `scripts\uninstall.ps1` (`-Purge` borra también config y logs).

## Uso desde agentes
- **MCP (HTTP)**: `http://127.0.0.1:7777/mcp` con `Authorization: Bearer <apiKey>`. 58 tools: `vm_*` (25), `browser_*` (proxy 1:1 del Playwright MCP), `windows_*`, `services_*`.
- **MCP (stdio)**: `tcllm mcp-stdio` (para clientes sin HTTP).
- **REST**: `POST /api/tools/<tool>` con JSON; rutas de conveniencia `/api/vms/:vm/...`, `/api/browser/...`, `/api/windows`, `/api/status`.
  OpenAPI en `/api/openapi.json`; definiciones OpenAI function-calling en `/api/tools/openai`; skill en `/api/skill.md`.
- Panel → **Conectar agentes** muestra los snippets exactos por agente y los instala con un clic.

## Config (`~\.tcllm\config.json`)
```json
{
  "server": { "host": "127.0.0.1", "port": 7777, "apiKey": "..." },
  "vms": { "Win11": { "user": "claude", "password": "...", "sshPort": 2222, "sshKey": "D:\\VMs\\tools\\id_ed25519" } },
  "playwright": { "enabled": true, "port": 8932, "browser": "chrome", "isolated": true, "headless": false, "storageState": "", "freeFileDialogs": false },
  "monitor": { "intervalMs": 10000 }, "watchdog": { "enabled": true }
}
```
`host: "0.0.0.0"` expone API/MCP/panel a la red (protegido solo por la API key; pon TLS delante si sale de tu LAN).

## Detalles que importan
- **VirtualBox sobre Hyper-V (NEM)**: si el host tiene Hyper-V/WSL2/Docker, VirtualBox va lento y **el reinicio de Windows dentro
  de la VM se cuelga**. `vm_start`/`vm_restart` llevan un watchdog (pantalla congelada + IF=0 en todas las vCPU + RIP estático → reset).
- El navegador de Playwright es el Chrome/Edge instalado, con contexto aislado por cliente MCP (`--isolated`); `storageState`
  inyecta logins en cada contexto. `freeFileDialogs` deja usar el diálogo de archivos nativo a un humano.
- Mostrar/ocultar usa `ShowWindow` (Win32): nada se cierra. Para una VM headless, "mostrar" engancha una ventana (`VirtualBoxVM --separate`).
- Los comandos dentro del guest viajan en base64 (`-EncodedCommand`): cualquier PowerShell, sin problemas de comillas.

## Desarrollo
```
npm install
TCLLM_HOME=.dev-home node bin/tcllm.js start
TCLLM_KEY=<key> node test/smoke.mjs
npm run pack        # dist/TCLLM-<ver>-win64.zip (+ setup.exe con iexpress)
```
Diseño: `docs/spec.md`.
