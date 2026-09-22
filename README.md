# TCLLM — Total Control for LLMs

[![Release](https://img.shields.io/github/v/release/nonoskygt/TCLLM?label=descargar&color=d9480f)](https://github.com/nonoskygt/TCLLM/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-15181c)](LICENSE)
![Windows](https://img.shields.io/badge/Windows-10%2F11-15181c)

Control remoto de **máquinas virtuales VirtualBox** y **navegadores Playwright** para cualquier LLM o agente:
API REST + OpenAPI, servidor MCP, tools en formato OpenAI, panel de administración web, monitor/supervisor de
servicios y gestor de ventanas (mostrar/ocultar). Un solo proceso, un solo puerto. Windows 10/11.

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

## Descarga e instalación (Windows)
Descarga desde [Releases](https://github.com/nonoskygt/TCLLM/releases/latest). Node.js va incluido; no hace falta instalar nada más.

- **`TCLLM-<versión>-setup.exe`**: ejecútalo. Extrae el paquete a `%TEMP%` y lanza el instalador.
  Windows SmartScreen avisará porque el ejecutable no está firmado: *Más información → Ejecutar de todas formas*.
- **`TCLLM-<versión>-win64.zip`**: extráelo y ejecuta `install.cmd`
  (o `powershell -ExecutionPolicy Bypass -File scripts\install.ps1`).

El instalador copia TCLLM a `%LOCALAPPDATA%\TCLLM`, crea `%USERPROFILE%\.tcllm\config.json` con una API key,
registra la tarea programada `TCLLM` (arranca oculto al iniciar sesión; un segundo disparador cada 5 min lo relanza si el
proceso murió sin cerrar sesión) y la lanza. Descarga la build de **Firefox** de Playwright
(navegador por defecto; `-NoFirefox` para omitirlo y usar Chrome/Edge). Si falta VirtualBox lo instala con winget (pide UAC).
Todo por usuario, sin admin salvo VirtualBox.

Después:
1. Abre `http://127.0.0.1:7777/` e introduce la API key (`tcllm apikey` en una terminal nueva).
2. Añade tus VMs en `config.json` → `vms` (usuario/contraseña del guest, puerto SSH opcional) para ejecutar comandos dentro.
   Sin credenciales, TCLLM las puede encender/apagar/capturar/teclear igualmente.
3. `tcllm install-agents` configura el MCP + skill en los agentes detectados
   (o `--for claude,codex,opencode,qwen,gemini,cursor,windsurf`).

Desinstalar: `%LOCALAPPDATA%\TCLLM\scripts\uninstall.ps1` (`-Purge` borra también config y logs).

## Uso desde agentes
- **MCP (HTTP)**: `http://127.0.0.1:7777/mcp` con `Authorization: Bearer <apiKey>`.
  36 tools propias — 25 `vm_*`, 5 de ventanas (`windows_list`, `window_show/hide`, `browser_windows_show/hide`),
  3 de navegadores (`browser_list`, `browser_use`, `browser_install`), 3 de servicios (`services_status`, `service_restart`,
  `services_events`) — más las del Playwright MCP como `browser_*` (proxy 1:1; 25 en @playwright/mcp 0.0.82).
- **MCP (stdio)**: `tcllm mcp-stdio` (para clientes sin HTTP).
- **REST**: `POST /api/tools/<tool>` con JSON; rutas de conveniencia `/api/vms/:vm/...`, `/api/browser/...`, `/api/windows`, `/api/status`.
  OpenAPI en `/api/openapi.json`; definiciones OpenAI function-calling en `/api/tools/openai`; skill en `/api/skill.md`.
- Panel → **Conectar agentes** muestra los snippets exactos por agente y los instala con un clic.

## Config (`%USERPROFILE%\.tcllm\config.json`)
```json
{
  "server": { "host": "127.0.0.1", "port": 7777, "apiKey": "<generada por el instalador>" },
  "vms": {
    "MiVM": { "user": "<usuario del guest>", "password": "<contraseña>", "sshPort": 2222, "sshKey": "C:\\Users\\<tú>\\.ssh\\id_ed25519" }
  },
  "playwright": { "enabled": true, "port": 8932, "browser": "firefox", "sessions": "persistent", "storageState": "", "allowedHosts": [], "allowAnyHost": false, "allowedNetworks": [] },
  "monitor": { "intervalMs": 10000 },
  "watchdog": { "enabled": true }
}
```
`playwright.browser`: `firefox` (por defecto) `| chrome | msedge | brave | chromium | webkit`.
`host: "0.0.0.0"` expone API/MCP/panel a la red (protegido solo por la API key; pon TLS delante si sale de tu LAN).
Si el puerto de Playwright está ocupado por otro programa, TCLLM usa el siguiente libre; si ya hay un Playwright MCP
escuchando ahí, lo adopta sin relanzarlo.

### Gestionar el acceso desde el panel (Conexiones)
El panel tiene una sección **Conexiones** para controlar quién usa el Playwright MCP, en dos capas:

- **Redes/IPs permitidas (firewall de Windows)** — la que filtra por dirección de quien se conecta. Acepta IPs (`192.168.2.50`), **subredes** (`192.168.2.0/24`), rangos (`192.168.2.10-192.168.2.60`) o `any`. "Aplicar" pide administrador (UAC), crea la regla `TCLLM Playwright (<puerto>)` y quita la vieja `Playwright MCP`.
- **Hosts permitidos (cabecera Host)** — la protección anti-rebinding de Playwright: `host:puerto` exactos o `*`. No entiende subredes (por eso la restricción por red va en el firewall).

### Playwright MCP compartido en la LAN (otros equipos/agentes sin pasar por TCLLM)
El Playwright MCP que supervisa TCLLM es un `@playwright/mcp` normal: cualquier cliente MCP puede usarlo directo, sin API key.
Para exponerlo a la red, en `playwright`: `"host": "0.0.0.0"`, `"port": 8931`, `"allowedHosts": ["192.168.2.20:8931"]`
(el servidor rechaza con 403 cualquier cabecera `Host` que no esté en la lista; `localhost:<port>` y `127.0.0.1:<port>` van siempre).
TCLLM le habla por `127.0.0.1` (nunca por `localhost`, que en Windows puede resolver a `::1` y encontrarse con otro servidor ajeno).

### Sesiones persistentes (los logins no se pierden)
Por defecto (`playwright.sessions: "persistent"`) cada navegador tiene **su perfil en disco** en `%USERPROFILE%\.tcllm\profiles\<navegador>`:

- Lo que loguees (vos o un agente) **sigue ahí** al cerrar el navegador y al reiniciar TCLLM.
- Al **cambiar de navegador**, TCLLM exporta las cookies y el localStorage del perfil que deja y **siembra** el del nuevo
  (`%USERPROFILE%\.tcllm\storage-state.json` es la bolsa común portable entre motores), así que los logins te siguen de
  Chrome a Firefox o Brave.
- Un perfil nuevo se siembra con la bolsa común, para no empezar deslogueado.

> Para que esto funcione TCLLM cierra el navegador con WM_CLOSE antes de pararlo: Chrome y Firefox solo vuelcan cookies y
> localStorage al perfil cuando salen limpios. Las cookies **de sesión** (sin caducidad) no persisten nunca, por diseño del navegador.

**Contrapartida:** un perfil en disco admite un solo contexto, así que todos los agentes conectados **comparten el navegador**
(mismas pestañas; dos navegaciones a la vez se pisan). Si necesitás aislamiento por agente, poné `playwright.sessions: "isolated"`:
cada cliente recibe su contexto, se inyecta `storage-state.json` al crearlo… pero nada de lo que loguees se guarda.

| | `persistent` (por defecto) | `isolated` |
|---|---|---|
| Los logins sobreviven al cierre | sí | no |
| Se traspasan entre navegadores | sí (automático al cambiar) | solo lo que haya en `storage-state.json` |
| Aislamiento entre agentes | no (contexto compartido) | sí |

Herramientas:
```
tcllm login                                   # abre el navegador con perfil propio y guarda logins en la bolsa común
tcllm check-login https://sitio/              # abre una sesión de agente real y dice OK / NO LOGUEADO
node test/sessions.mjs                        # prueba: una cookie sobrevive al reinicio y al cambio de navegador
node test/multi-client.mjs                    # dos agentes a la vez (según el modo: compartido o aislado)
```
Panel → **Navegador → Sesiones**: modo activo, cookies y dominios de la bolsa, tamaño de cada perfil y
**Guardar sesiones ahora** (`sessions_save` / `POST /api/sessions/save`: vuelca el perfil activo a la bolsa; reinicia el navegador).
La bolsa contiene cookies y tokens de sesión reales: no la compartas.

## Detalles que importan
- **VirtualBox sobre Hyper-V (NEM)**: si el host tiene Hyper-V/WSL2/Docker, VirtualBox va lento y **el reinicio de Windows dentro
  de la VM se cuelga**. `vm_start`/`vm_restart` llevan un watchdog (pantalla congelada + IF=0 en todas las vCPU + RIP estático → reset).
- **Navegadores**: Firefox por defecto (build propia de Playwright, instalada por el instalador); también Chrome, Edge y Brave (los
  instalados en el sistema) y las builds de Playwright de Chromium y WebKit (se descargan desde el panel o con `browser_install`). Se cambia en caliente desde el panel (Navegador), por MCP
  (`browser_use`) o por API (`POST /api/browser/use`). Playwright no puede manejar el Firefox normal: usa su build con parches.
  Contexto aislado por cliente MCP (`--isolated`); `storageState` inyecta logins en cada contexto. `freeFileDialogs` deja usar el
  diálogo de archivos nativo a un humano.
- Mostrar/ocultar usa `ShowWindow` (Win32): nada se cierra. Para una VM headless, "mostrar" engancha una ventana (`VirtualBoxVM --separate`).
- Los comandos dentro del guest viajan en base64 (`-EncodedCommand`): cualquier PowerShell, sin problemas de comillas.
- La contraseña del guest se pasa a `VBoxManage guestcontrol` como argumento (como exige VirtualBox) y se enmascara en los mensajes de error.

## Desarrollo
```powershell
npm install
$env:TCLLM_HOME = '.dev-home'; node bin\tcllm.js start
$env:TCLLM_KEY = '<key>'; node test\smoke.mjs
npm run pack        # dist\TCLLM-<ver>-win64.zip + TCLLM-<ver>-setup.exe (stub C# compilado con csc.exe de .NET Framework)
```
Diseño: `docs/spec.md`. Cambios: `CHANGELOG.md`. Licencias de terceros: `THIRD-PARTY-NOTICES.md`.

## Licencia y autor
MIT © 2026 Danilo Estuardo Gonzalez Rizzo — [github.com/nonoskygt](https://github.com/nonoskygt)
