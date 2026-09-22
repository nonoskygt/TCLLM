> Documento histórico (2026-09-18) del servicio Playwright MCP suelto que precedió a TCLLM en esta máquina. El 2026-09-21 ese
> servicio se retiró y TCLLM asumió su papel con la misma configuración (`--isolated`, `storage-state`, `init-page`,
> `host 0.0.0.0` + `allowed-hosts`, puerto 8931). Las rutas y scripts que cita ya no existen: hoy son `tcllm login`,
> `tcllm check-login`, `test/multi-client.mjs` y la config `playwright` de `~/.tcllm/config.json`.

# Playwright MCP multi-agente en la laptop — diseño

Fecha: 2026-09-18 · Estado: aprobado por el usuario (chat) · Carpeta: `C:\Users\Usuario\playwright-mcp-service`

## Problema

El servidor `@playwright/mcp` 0.0.79 corre en la laptop (192.168.2.20:8931) lanzado por la tarea
programada "Playwright MCP" → `run-playwright-mcp.ps1` (supervisor) → `node cli.js --port 8931 ...`.
Corría en modo **persistente** (por defecto): cada cliente MCP lanza *su* Chrome sobre un perfil en
disco `%LOCALAPPDATA%\ms-playwright-mcp\mcp-chrome-<hash(cwd del cliente)>`. Dos clientes con el mismo
hash (mismo directorio de trabajo, o clientes sin roots) chocan contra el mismo perfil: el segundo recibe
`Browser is already in use for <dir>, use --isolated ...` y el perfil queda tomado mientras viva la sesión
HTTP del primero. Desde fuera (pve, CT100) no hay forma de liberarlo.

Verificado en `playwright-core/lib/coreBundle.js` (`createPersistentBrowser`, `isProfileLocked`,
`program.ts` modo HTTP).

## Requisitos

1. Varios agentes (locales y remotos) usando el mismo servidor **a la vez**, sin bloquearse.
2. Nada headless: todo lo que hace cada agente se ve en pantalla.
3. Los agentes arrancan **logueados** en los sitios que el usuario decida.
4. Sin cambios en los clientes (mismas URLs `http://192.168.2.20:8931/mcp` y `http://localhost:8931/mcp`).

## Alternativas evaluadas

| Opción | Multi-agente | Visible | Logins | Veredicto |
|---|---|---|---|---|
| A. `--isolated` + `--storage-state` | Sí: un Chrome, un contexto/ventana por agente | Sí | Inyectados desde `storage-state.json` | **Elegida** |
| B. `--shared-browser-context` | No: todos comparten ventana y pestañas, `browser_close` de uno afecta a todos | Sí | Sí (perfil persistente) | Descartada |
| C. Un servidor por puerto con perfil persistente | Requiere coordinar puertos; dos agentes en el mismo puerto reproducen el fallo | Sí | Sí | Descartada |

## Diseño

### 1. Servidor (`run-playwright-mcp.ps1`)

- Args: los actuales + `--isolated --storage-state "<carpeta>\storage-state.json"`.
- El supervisor crea `storage-state.json` con `{"cookies":[],"origins":[]}` si no existe (si falta,
  Playwright falla al crear contextos y ningún cliente podría conectar).
- Comportamiento resultante (modo HTTP + isolated): el servidor lanza **un** Chrome (canal `chrome`,
  headed) al primer cliente y lo comparte; cada cliente recibe `browser.newContext(storageState)` →
  ventana propia que aparece al primer uso y se cierra al desconectar el cliente. Cuando el último
  cliente se va, se cierra el Chrome. No hay perfil en disco → no hay lock.
- El archivo de storage-state se lee en cada `newContext`: refrescar logins **no** requiere reiniciar.
- Backup del script previo con la convención `run-playwright-mcp.ps1.bak-<yyyyMMdd-HHmmss>`.

### 2. Logins (`login.ps1` + `login.mjs`)

- `login.mjs` usa el `playwright` que ya trae `@playwright/mcp` (misma versión, sin instalar nada).
- Abre Chrome (canal `chrome`, visible) con perfil persistente `login-profile\` dentro de la carpeta del
  servicio. El usuario se loguea en lo que necesite. Enter en la consola → exporta
  `storage-state.json` (escritura atómica: tmp + rename) y cierra. Autoguardado cada 30 s y al cerrar
  pestañas, por si el usuario cierra la ventana a mano.
- Parámetro `-Profile <dir>` para exportar desde otro perfil (p.ej. uno de los `mcp-chrome-*` ya
  existentes, aprovechando logins previos). `-Out <archivo>` para cambiar el destino.
- Límite conocido: lo que un agente loguee durante su sesión no se guarda de vuelta (contexto en
  memoria). Cuando caduquen las cookies, se repite `login.ps1`.

### 3. Reinicio y verificación

- `schtasks /end` de la tarea, matar el árbol restante (cmd/node), `schtasks /run`, comprobar que el
  8931 escucha con la línea de comandos nueva.
- `test-multi-client.mjs`: cliente MCP mínimo (Streamable HTTP con `fetch`) que abre **dos sesiones a la
  vez**, navega cada una a una URL distinta, lee `document.cookie` y cierra las sesiones (`DELETE`).
  Prueba que no hay lock y, si `storage-state.json` contiene la cookie canario `pwmcp_test` para
  `example.com`, que la inyección de cookies funciona. Queda en la carpeta para repetir la prueba.
- Prueba visual: dos ventanas de Chrome con títulos distintos (`Get-Process chrome | MainWindowTitle`).
- `README.md`: operación diaria (refrescar logins, reiniciar, diagnóstico rápido).

### Impacto del reinicio

Corta las conexiones MCP vivas (6 en el momento del diseño: 192.168.2.93 ×3, .146, .6, 2 locales). No
había ningún Chrome del MCP abierto. Cada sesión de Claude conectada debe reconectar (`/mcp` →
reconnect, o reiniciar la sesión). Aprobado explícitamente por el usuario.

### Fuera de alcance

Cambios en clientes, `--output-dir`, distinguir ventanas por agente (Chrome no lo permite), IndexedDB en
el storage-state.

## Ajustes durante la implementación (2026-09-18)

- `login.mjs` añade siempre la cookie canario `pwmcp_test` (solo para `example.com`) al exportar, de
  modo que `test-multi-client.mjs` verifica la inyección de logins en cada ejecución.
- `restart.ps1`: `Stop-ScheduledTask` solo termina el powershell supervisor; `cmd.exe` y `node.exe`
  sobreviven y mantienen el 8931 ocupado. El script mata el árbol, relanza la tarea y verifica flags.
- `chrome-windows.ps1`: `Get-Process` devuelve un título por proceso y todas las ventanas de los agentes
  viven en el mismo proceso de Chrome; se enumeran ventanas reales con `EnumWindows`.
- Resultado de la verificación: prueba de 2 agentes simultáneos OK por `localhost` y por
  `192.168.2.20` (aislamiento de pestañas, 2 ventanas visibles, cookie inyectada, cierre limpio).

## "Explorar archivos" no abria el dialogo nativo (2026-09-19)

- Causa (verificada en coreBundle.js): el MCP registra un listener 'filechooser' en cada pagina
  (Tab), lo que hace que Playwright envie Page.setInterceptFileChooserDialog a Chrome. Chrome entonces
  NO abre el dialogo nativo: se lo entrega al servidor (para browser_file_upload). Un humano frente a
  la ventana no puede elegir archivo.
- Solucion: quitar ese listener. Sin listeners, Playwright desactiva la interceptacion y vuelve el
  dialogo nativo de Windows.
  - Permanente: `--init-page init-page.cjs` en el supervisor -> se aplica a cada pagina nueva. Requiere
    reinicio para tomar efecto en un servidor ya corriendo.
  - En caliente (sin reiniciar, sin cortar agentes): `node free-file-dialogs.mjs` quita el listener en
    todas las paginas abiertas ahora mismo via browser_run_code_unsafe.
- Verificacion: `node test-file-dialog.mjs` abre un <input type=file>, hace clic y confirma que aparece
  el dialogo nativo #32770 de chrome.exe ("Abrir"). Resultado: OK.
- Compromiso: browser_file_upload deja de funcionar en paginas liberadas (ya no hay chooser que
  interceptar). Es lo que se quiere aqui: control humano del dialogo. Si algun agente necesitara subir
  archivos por API en su pagina, que vuelva a suscribir el evento el mismo.
