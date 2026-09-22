# Changelog

## 0.3.1 — 2026-09-21

- **Panel → Conexiones**: nueva sección para gestionar quién accede al Playwright MCP, en dos capas.
  - **Redes/IPs permitidas (firewall de Windows)**: acepta IPs y **subredes** (`192.168.2.0/24`), rangos (`a-b`) o `any`.
    Un clic en **Mi red 192.168.2.0/24**. Aplicar crea/reemplaza una regla propia `TCLLM Playwright (<puerto>)` y elimina
    la `Playwright MCP` heredada (pide administrador vía UAC). Muestra el comando manual equivalente.
  - **Hosts permitidos (cabecera Host de Playwright)**: `host:puerto` exactos o `*` (cualquiera). Botón "incluir mis IPs".
    Cambiarlo relanza el Playwright MCP.
- REST: `GET /api/access`, `POST /api/access/hosts`, `POST /api/access/hosts/local`, `POST /api/access/networks`,
  `POST /api/access/firewall/apply`. Config: `playwright.allowAnyHost`, `playwright.allowedNetworks`.
- TCLLM se conecta a su Playwright por IP de loopback aunque escuche en `0.0.0.0` (evita el `::1` de terceros).

## 0.3.0 — 2026-09-21

- **Un solo servicio Playwright.** TCLLM puede exponer su Playwright MCP a la LAN (`playwright.host: "0.0.0.0"`,
  `allowedHosts`) y sustituye al servicio suelto que corría aparte. TCLLM le habla siempre por IP de loopback
  (`127.0.0.1`), nunca por `localhost`: en Windows puede resolver a `::1`, donde puede haber otro servidor ajeno
  que TCLLM "adoptaría" por error. `GET /api/browser` informa `host`, `allowedHosts` y `storageState`.
- **Logins compartidos**: `tcllm login` (abre el navegador del servidor con perfil persistente, guarda y fusiona
  cookies/localStorage en `~/.tcllm/storage-state.json`; `--visit`, `--auto`, `--replace`, `--browser`),
  `tcllm check-login <url…>` (sesión de agente real: OK / NO LOGUEADO) y `test/multi-client.mjs` (dos agentes a la
  vez: aislamiento, ventanas, cookie canario). Migrados del servicio anterior (`tools/`).
- **Watchdog en la tarea programada.** La tarea `TCLLM` tiene ahora dos disparadores: al iniciar sesión y cada 5 minutos.
  Si el proceso muere sin que se cierre la sesión (incidente 2026-09-21: un "Apagar" abortado desde el menú Inicio mató
  los procesos, pero el logon no se repitió y nada relanzó TCLLM), el segundo disparador lo levanta; con
  `MultipleInstances=IgnoreNew` no crea duplicados. `RestartCount` no cubría este caso.
- **El bridge PowerShell ya no tumba el servidor.** Una escritura en vuelo cuando el sidecar muere emitía `error` en su
  stdin sin listener → `uncaughtException: write EPIPE` y TCLLM caía entero. Ahora se registra, se rechazan las
  peticiones pendientes y el sidecar se relanza en la siguiente llamada. Test: `node test/bridge-epipe.mjs`.
- Instalador: si la tarea `TCLLM` existente pertenece a Administradores (fue creada desde una consola elevada) y no se
  puede actualizar sin elevar, lo dice claramente en vez de fallar con "Acceso denegado". El desinstalador borra también
  una tarea `TCLLM watchdog` aparte si existe.

## 0.2.1 — 2026-09-20

- **Firefox es el navegador por defecto.** El instalador descarga la build de Firefox de Playwright (~100 MB) durante la instalación
  (`-NoFirefox` para omitirlo); si no puede (sin red), usa Chrome o Edge y lo avisa. `pickDefault()` prefiere Firefox.
- El instalador espera hasta 60 s a que TCLLM responda (antes 30 s).

## 0.2.0 — 2026-09-20

- **Navegadores**: Playwright funciona con Chrome, Edge, **Brave** (Chromium del sistema) y con las builds propias de Playwright de **Firefox**, Chromium y WebKit.
  Detección de lo instalado, instalación bajo demanda (`browser_install` / panel) y cambio en caliente (`browser_use` / panel → Navegador).
- Nuevas tools MCP/REST: `browser_list`, `browser_use`, `browser_install`; `GET /api/browser/browsers`, `POST /api/browser/use`, `POST /api/browser/install` (no bloqueante) y `GET /api/browser/install/:browser` (progreso).
- Config: `playwright.browser` acepta `chrome | msedge | brave | chromium | firefox | webkit`; `playwright.executablePath` para otros Chromium (Vivaldi, Opera…).
- Ventanas: se detectan también Brave y Firefox lanzados por Playwright.

## 0.1.0 — 2026-09-20

Primera versión.

- Servidor único (`:7777`): API REST + OpenAPI 3.1, servidor MCP (Streamable HTTP y stdio), panel web, WebSocket de eventos/logs.
- 58 tools: `vm_*` (VirtualBox: encender/apagar/reiniciar seguro/reset/captura/ratón/teclado/pegar/PowerShell dentro, elevado, SSH, copiar archivos, snapshots, mostrar/ocultar ventana), `browser_*` (proxy 1:1 del Playwright MCP), `windows_*`, `services_*`.
- Export de tools en formato OpenAI function-calling (`/api/tools/openai`) para cualquier LLM.
- Monitor/supervisor: Playwright MCP gestionado (relanzado si muere; adopta uno existente; busca puerto libre si el configurado está ocupado), estado de VirtualBox/VMs/SSH/bridge/host, historial de eventos.
- Watchdog del cuelgue de reinicio de VirtualBox sobre Hyper-V (NEM).
- Gestor de ventanas Win32: mostrar/ocultar ventanas de VMs (engancha GUI a VMs headless) y del navegador.
- Panel de administración: Dashboard, control remoto en vivo de VMs, Navegador, Ventanas, Servicios, Conectar agentes (snippets e instalación con un clic), Logs, Ajustes.
- Integración con agentes: Claude Code, Codex CLI, OpenCode, Qwen Code, Gemini CLI, Cursor, Windsurf (MCP + SKILL.md).
- Instalador Windows por usuario (`install.ps1`, tarea programada al iniciar sesión, Node incluido), desinstalador, empaquetado ZIP + `setup.exe` auto-extraíble.
