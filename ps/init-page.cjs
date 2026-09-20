// --init-page para Playwright MCP (opcional, config playwright.freeFileDialogs):
// quita el listener 'filechooser' que el MCP registra en cada página, para que un humano pueda usar el
// diálogo nativo de archivos de Windows en el navegador compartido.
// El servidor lo carga con: const { default: func } = require(initPage); await func({ page })
async function initPage({ page }) {
  try { for (const l of page.listeners('filechooser')) page.off('filechooser', l); } catch {}
}
module.exports = { default: initPage };
