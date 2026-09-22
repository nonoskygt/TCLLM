---
name: tcllm
description: "Use when a task needs to control a VirtualBox virtual machine (start/stop/restart, screenshots, mouse, keyboard, run PowerShell inside, files, snapshots) or a Playwright browser through TCLLM, or to switch which browser the agents use. Triggers: 'la VM', 'máquina virtual', 'VirtualBox', 'TCLLM', 'dentro de Windows', 'navegador', 'abrí/usá chrome', 'abrí firefox', 'abrí brave', 'cambiá el navegador', 'abrí Windows', 'abrí la VM'."
---

# TCLLM — control total de VMs y navegador para agentes

TCLLM corre en `http://127.0.0.1:7777` (panel: `http://127.0.0.1:7777/`). Úsalo por **MCP** (servidor `tcllm`, tools `vm_*`, `browser_*`,
`windows_*`, `services_*`) o por **REST** (`http://127.0.0.1:7777/api/openapi.json`, auth `Authorization: Bearer <apiKey>`).

## Comandos rápidos (lo que pide el usuario → qué tool llamar)
- **"abrí / usá / cambiá a chrome"** → `browser_use { "browser": "chrome" }`. Igual con `firefox`, `brave`, `edge` (=`msedge`), `chromium`, `webkit`.
- **"abrí / encendé Windows / la VM / la máquina"** → `vm_list` para ver el nombre (p.ej. `Win11`), luego `vm_start { "vm": "Win11" }`; `vm_show { "vm": "Win11" }` para verla.
- **"mostrá / ocultá el navegador"** → `browser_windows_show` / `browser_windows_hide`. **"mostrá / ocultá la VM"** → `vm_show` / `vm_hide`.
- **"¿qué navegadores hay?" / "cuál está activo"** → `browser_list`.

> Un solo Playwright compartido: `browser_use` lo **relanza** y afecta a todos los agentes conectados (se pierden las pestañas). Cámbialo solo cuando te lo pidan; si el navegador ya es el activo, no hace nada. Chrome, Edge y Brave ya vienen instalados; Firefox/Chromium/WebKit se bajan con `browser_install`.

## Flujo con una VM
1. `vm_list` → estado. Si no está `running`: `vm_start` (tarda 1-5 min; espera solo).
2. `vm_screenshot` → mira la pantalla. Coordenadas de `vm_click`/`vm_drag` = las de esa imagen.
3. Datos del guest (procesos, archivos, versión, RAM…): `vm_run` (PowerShell dentro), **no** capturas. `admin: true` para elevado.
4. GUI: `vm_click`, `vm_key` ("win+r", "ctrl+alt+del", "enter"), `vm_type` (ASCII corto), `vm_paste` (largo/Unicode).
5. Al terminar cierra lo que abriste (`vm_run` con `Stop-Process`). No apagues la VM si no te lo pidieron.

## Reglas
- Reiniciar Windows: **solo** `vm_restart` (vigila el cuelgue de VirtualBox sobre Hyper-V y resetea). Nunca `shutdown /r` a mano.
- Si la VM está en negro y no responde: `vm_reset`.
- `vm_show` / `vm_hide` muestran u ocultan su ventana en el host; `browser_windows_show/hide` las del navegador.
- Navegador: tools `browser_*` (navigate, snapshot, click, type, …) = Playwright MCP vía TCLLM. `browser_list` dice qué navegadores hay
  (Chrome, Edge, Brave, Firefox, Chromium, WebKit) y cuál está activo; `browser_use` cambia de navegador (relanza Playwright: se pierden las pestañas);
  `browser_install` descarga Firefox/Chromium/WebKit (100-200 MB, tarda).

## Tools
- `vm_list`: Lista las máquinas virtuales de VirtualBox con su estado (running/poweroff/saved), snapshots y si TCLLM puede controlarlas por dentro.
- `vm_info`: Detalle de una VM: estado, RAM, CPUs, Guest Additions, snapshots, reenvíos de puertos.
- `vm_start`: Enciende (o reanuda) la VM y espera a que Windows responda. Resetea automáticamente si detecta el cuelgue de arranque/reinicio de VirtualBox sobre Hyper-V. Tarda 1-5 minutos.
- `vm_stop`: Apaga la VM limpiamente (shutdown /s dentro del guest o botón ACPI); poweroff forzado si no apaga en 4 min. force=true apaga de golpe.
- `vm_restart`: Reinicia Windows dentro de la VM de forma segura (shutdown /r + watchdog que resetea si el reinicio se cuelga) y espera a que responda. ÚSALO en vez de reiniciar desde Windows.
- `vm_reset`: Reset duro (como pulsar reset). Útil si la VM está colgada en negro.
- `vm_save_state`: Guarda el estado de la VM en disco y la detiene (como hibernar).
- `vm_screenshot`: Captura de pantalla de la VM (PNG). Las coordenadas para vm_click/vm_drag son las de esta imagen (0,0 arriba a la izquierda).
- `vm_click`: Clic de ratón en la VM en coordenadas de la captura.
- `vm_move`: Mueve el puntero del ratón de la VM (hover).
- `vm_drag`: Arrastra con el botón izquierdo desde (x1,y1) hasta (x2,y2).
- `vm_scroll`: Rueda del ratón en (x,y): amount>0 baja, amount<0 sube (en "ticks").
- `vm_key`: Pulsa una tecla o combinación en la VM: "enter", "ctrl+alt+del", "win+r", "alt+f4", "ctrl+shift+esc", "f5", "up"...
- `vm_type`: Escribe texto en la VM como si se tecleara (ASCII por scancodes; si hay caracteres no ASCII usa el portapapeles). Para texto largo usa vm_paste.
- `vm_paste`: Pega texto (Unicode, cualquier longitud) en la VM vía portapapeles compartido + Ctrl+V.
- `vm_run`: Ejecuta PowerShell DENTRO de la VM y devuelve la salida como texto. admin=true lo ejecuta elevado (sin prompt UAC). Es la forma correcta de leer datos del guest (procesos, archivos, registro...), no las capturas.
- `vm_ssh`: Ejecuta un comando por SSH en la VM (PowerShell, token elevado). Requiere sshPort/sshKey en la config de la VM.
- `vm_copy_to`: Copia un archivo del host a un directorio de la VM.
- `vm_copy_from`: Copia un archivo de la VM a un directorio del host.
- `vm_show`: Muestra la ventana de la VM en el escritorio del host (si corre headless, le engancha una ventana).
- `vm_hide`: Oculta la ventana de la VM (la VM sigue corriendo).
- `vm_snapshot_list`: Lista los snapshots de la VM.
- `vm_snapshot_take`: Crea un snapshot de la VM (funciona en caliente).
- `vm_snapshot_restore`: Restaura un snapshot (la VM debe estar apagada). Descarta el estado actual.
- `vm_snapshot_delete`: Borra un snapshot.
- `windows_list`: Lista las ventanas gestionables del host: las de las VMs (VirtualBoxVM) y las del navegador de Playwright, con su hwnd y visibilidad.
- `window_show`: Muestra (y trae al frente) una ventana por hwnd.
- `window_hide`: Oculta una ventana por hwnd (el proceso sigue).
- `browser_list`: Navegadores disponibles para Playwright (Chrome, Edge, Brave, Chromium, Firefox, WebKit): cuáles están instalados y cuál está activo.
- `browser_use`: Cambia el navegador que controla Playwright: se guarda en config y se relanza el Playwright MCP, así que TODOS los agentes conectados pierden sus pestañas. Si ya es el activo no hace nada. Firefox/Chromium/WebKit deben estar instalados (browser_install).
- `browser_install`: Descarga e instala una build de Playwright (chromium, firefox o webkit; 100-200 MB). BLOQUEA hasta terminar (de segundos a varios minutos según la conexión); si tu cliente corta por timeout la descarga sigue: vuelve a llamar, es idempotente. Chrome/Edge/Brave se instalan desde su web.
- `browser_windows_show`: Muestra las ventanas del navegador controlado por Playwright.
- `browser_windows_hide`: Oculta las ventanas del navegador controlado por Playwright (sigue funcionando).
- `services_status`: Estado de todos los servicios: TCLLM, VirtualBox, cada VM, Playwright MCP (navegador) y el host (CPU/RAM/discos).
- `service_restart`: Reinicia un servicio gestionado: "playwright" (servidor MCP del navegador) o "bridge" (puente PowerShell).
- `services_events`: Últimos eventos del monitor (cambios de estado, reinicios, avisos).
