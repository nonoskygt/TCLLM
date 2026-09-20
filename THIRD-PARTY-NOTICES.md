# Avisos de terceros

TCLLM se distribuye bajo licencia MIT (ver `LICENSE`). El paquete instalable incluye software de terceros con sus propias licencias:

| Componente | Licencia | Uso |
|---|---|---|
| Node.js (runtime incluido en `runtime\`) | MIT — https://github.com/nodejs/node/blob/main/LICENSE | Ejecuta TCLLM |
| @playwright/mcp, playwright-core | Apache-2.0 — https://github.com/microsoft/playwright-mcp | Servidor MCP del navegador (supervisado por TCLLM) |
| @modelcontextprotocol/sdk | MIT | Servidor y cliente MCP |
| express | MIT | API REST y panel |
| ws | MIT | WebSocket del panel |
| zod | MIT | Validación |

Las licencias completas de cada dependencia están en `node_modules/<paquete>/LICENSE` dentro del paquete.
VirtualBox (Oracle, GPLv2) y el navegador (Google Chrome / Microsoft Edge) no se distribuyen con TCLLM: se usan los instalados en el sistema.
