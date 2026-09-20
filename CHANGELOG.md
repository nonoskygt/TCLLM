# Changelog

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
