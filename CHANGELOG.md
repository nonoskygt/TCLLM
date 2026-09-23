# Changelog

## 0.4.4 - 2026-09-23

- **Las sesiones de los agentes ya no se caen cuando TCLLM se reinicia.** Con MCP por HTTP, Claude Code ve el puerto
  cerrado durante el reinicio, marca el servidor como caido y no reintenta: habia que hacer `/mcp` -> Reconnect a mano en
  cada sesion. Nuevo `src/stdio-bridge.js`: `tcllm mcp-stdio` es ahora un puente liviano que cada sesion lanza como
  proceso hijo; reenvia las llamadas a la API REST del servidor y, si el servidor no contesta, espera y reintenta
  (hasta 2 min). Si al arrancar no hay servidor, usa la ultima lista de tools guardada.
  - `--browser-only`: solo las tools del Playwright MCP, con sus nombres de siempre (sustituye a la entrada `playwright`).
  - El puente no lanza Playwright ni toca VirtualBox por su cuenta (el `mcp-stdio` anterior levantaba su propio
    supervisor y podia duplicar el Playwright). Todas sus llamadas quedan en `/api/calls` con el nombre de la sesion.
  - `tcllm install-agents` configura Claude Code con el puente (`tcllm` y `playwright`); la API key la lee el puente.
  - Verificado: una sesion MCP abierta sigue funcionando tras matar y relanzar el servidor, sin reconectar
    (`test/stdio-bridge.mjs`).

## 0.4.3 - 2026-09-23

- **Registro de llamadas: quien usa el navegador.** Nuevo `src/calls.js`. Cada llamada a una tool que pasa por TCLLM
  (API REST y MCP del 7777) queda registrada con quien llama, la tool, la duracion y el resultado, sin argumentos.
  Identidad: cabecera `X-TCLLM-Client` (REST), `clientInfo` + sesion (MCP) y, si la llamada tarda, el proceso de
  Windows que la hace. Las que siguen en curso mas de 30 s se avisan en el log (`EN CURSO hace N s`).
  `GET /api/calls` y seccion **Actividad de agentes** en el panel. Los clientes conectados directo al 8931 no pasan
  por TCLLM y no quedan registrados.
- **VirtualBox colgado ya no traba TCLLM.** Las consultas a VBoxManage tienen limite de 20 s (antes 2 min), el monitor
  no solapa vueltas y la lista de ventanas usa la ultima lista de VMs buena si VirtualBox no contesta en 4 s. Visto el
  23/09: con VBoxSVC colgado se apilaron 55 VBoxManage y `/windows`, `/browser` y `browser_list` no respondian.
- Test: `test/calls.mjs`.

## 0.4.2 - 2026-09-23

- **Una llamada larga ya no tumba el Chrome compartido.** `playwright.callTool` usaba el timeout de 60 s del SDK de MCP y,
  ante cualquier error (incluido ese timeout), cerraba su sesion con el Playwright MCP. Si era el ultimo cliente,
  `@playwright/mcp` cerraba el navegador y todos los agentes perdian sus pestanas (reportado por la sesion de la fabrica:
  2 veces el 23/09). Ahora: timeout propio `playwright.callTimeoutMs` (5 min por defecto, se reinicia con progreso) y
  un error del protocolo (timeout, error de la tool) conserva la sesion; solo se descarta si el transporte murio.
  Verificado: dos timeouts seguidos, mismo proceso de Chrome, la pestana sigue y la llamada siguiente funciona.

## 0.4.1 - 2026-09-23

- **Sin cuadros "¿Salir del sitio?"**: nuevo `ps/no-leave-dialogs.js`, cargado como `--init-script` en todas las paginas
  (`playwright.blockLeaveDialogs`, activo por defecto). Impide que los sitios registren `beforeunload`, que dejaba a los
  agentes colgados hasta el timeout al navegar y trababa el cierre limpio del navegador. Contrapartida: un formulario a
  medio llenar se pierde sin aviso al salir.
- Cierre limpio con respaldo: si tras el WM_CLOSE el navegador sigue vivo (un cuadro de una pagina vieja), se fuerza el
  cierre para no dejar el perfil bloqueado ("Browser is already in use").
- Test: `test/leave-dialogs.mjs` (verificado en rojo sin el arreglo: la navegacion se cuelga; y en verde con el).
- Conocido: Firefox a veces no cierra con WM_CLOSE en 25 s (aviso propio de cerrar pestanas) y se fuerza.

## 0.4.0 - 2026-09-22

- **Sesiones persistentes (nueva feature).** Los logins dejan de perderse:
  - `playwright.sessions: "persistent"` (nuevo valor por defecto): cada navegador usa un perfil en disco
    (`~/.tcllm/profiles/<navegador>`) en vez de un contexto en memoria, asi que lo que loguees sigue ahi al cerrar.
  - **Traspaso entre navegadores**: al cambiar de navegador TCLLM exporta cookies y localStorage del perfil que deja,
    los fusiona en la bolsa comun (`~/.tcllm/storage-state.json`) y siembra el perfil del nuevo. Un perfil nuevo se
    siembra con la bolsa, para no empezar deslogueado.
  - **Cierre limpio del navegador** (WM_CLOSE) antes de parar el Playwright MCP: Chrome y Firefox solo vuelcan cookies
    y localStorage al perfil cuando salen limpios; matando el proceso se perdia todo (causa raiz del bug).
  - Nuevo `src/sessions.js`, tools `sessions_status` y `sessions_save`, rutas `GET /api/sessions` y
    `POST /api/sessions/save`, y seccion **Sesiones** en el panel (modo, bolsa, perfiles, guardar ahora).
  - Contrapartida documentada: un perfil en disco admite un solo contexto, asi que los agentes comparten navegador.
    `playwright.sessions: "isolated"` restaura el aislamiento por agente (sin persistencia).
  - Tests: `test/sessions.mjs` (persiste tras reiniciar y al cambiar de navegador) y `test/multi-client.mjs`
    (consciente del modo).

## 0.3.2 - 2026-09-21

- **Skill: seleccionar navegador por instruccion.** La skill `tcllm` ahora mapea lenguaje natural a tools para que
  los agentes obedezcan: "abri/usa chrome|firefox|brave|edge" -> `browser_use`; "abri Windows / la VM" -> `vm_list`+`vm_start`+`vm_show`;
  "mostra/oculta el navegador|la VM" -> `browser_windows_show/hide` / `vm_show/hide`. Nuevos triggers en la descripcion.

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
